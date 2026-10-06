#!/usr/bin/env bun
// The build facet's binding is the isolate's, shared by every Durable Object
// whose facet runs there, and each object may do I/O only in its own context
// (build-facet-isolation-workerd.mjs checks that against workerd). Here, in
// Bun, an AsyncLocalStorage of the test's stands for those contexts: a
// context is what the caller ran under, and Bun carries it, as workerd
// carries a context, through every continuation, timer and immediate.
//
//   - Two objects' facets on one binding, building at once: every plugin
//     read of a build happens in the context of the call that asked for the
//     build. Before callLanes, the binding's pump, started by one object's
//     build, dispatched the other's hooks in the first one's context.
//   - callLanes itself: a job posted from any context runs in the lane's;
//     a lane's loop ends with its call, resolved or rejected; a post to an
//     ended lane is refused.
//   - An owner's instances: a new instance's first call takes over the lanes
//     its last one left open (in workerd, calls whose Durable Object was
//     reset under them, whose own `finally` never runs). Their undelivered
//     jobs run in its lane, each one's `abandoned` is called and `onEnded`
//     listeners hear it; nothing else is touched.
//   - A build whose lane has ended while its hooks are still being called
//     (its call returned without waiting for it) still finishes, its hooks
//     run where they are dispatched, and a build in an open lane beside it
//     keeps every hook in its own context.
//   - A build whose lane is abandoned with a hook in flight that will never
//     answer ends on the binding: the binding refuses what it awaits there,
//     so its task ends and its state is freed rather than held for good.
//   - Async work is refused on a binding run with contexts (emnapi queues it
//     past its pool where no wrapper sees), loudly and by name; it runs
//     without them.
//   - None of emnapi's work (a threadsafe function's release, a finalizer)
//     goes to a timer of no context's: each runs in a call's context, and a
//     finalizer scheduled outside every call is taken by the next one.

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { STAGED_BINDING_ARTIFACTS } from '../../packages/worker/src/napi-wasm-artifacts.generated.ts';
import { freshFacetClass, parts, releaseBuildFacetHarness } from './lib/build-facet-harness.mjs';

const contexts = new AsyncLocalStorage();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A project of `modules` chained modules under /home/user/<tag>, read
 * asynchronously; `seen` collects the context each read happened in.
 */
function project(tag, modules, seen) {
  const files = new Map();
  for (let i = 0; i < modules; i++) {
    const next = i + 1 < modules ? `import { v as w } from './m${i + 1}.js';\n` : 'const w = "";\n';
    files.set(`home/user/${tag}/m${i}.js`, encoder.encode(`${next}export const v = ${JSON.stringify(tag + i)} + w;\n`));
  }
  const strip = (p) => p.replace(/^\/+/, '');
  const read = async (p) => {
    seen.push(contexts.getStore());
    await Promise.resolve();
    const bytes = files.get(strip(p));
    if (!bytes) throw new Error(`ENOENT: ${p}`);
    return bytes;
  };
  return {
    vfs: {
      exists: (p) => files.has(strip(p)) || [...files.keys()].some((k) => k.startsWith(strip(p).replace(/\/+$/, '') + '/')),
      isDirectory: (p) => !files.has(strip(p)) && [...files.keys()].some((k) => k.startsWith(strip(p).replace(/\/+$/, '') + '/')),
      readFile: read,
      readFileString: async (p) => decoder.decode(await read(p)),
    },
    entry: `/home/user/${tag}/m0.js`,
    holds: (text) => Array.from({ length: modules }, (_, i) => JSON.stringify(tag + i)).every((value) => text.includes(value)),
  };
}

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`  ${ok ? 'ok ' : 'RED'} ${name}`);
};
/** Runs one section; one that throws fails by name, and the others still run. */
const section = async (name, run) => {
  try {
    await run();
  } catch (error) {
    failures.push(`${name}: threw ${error?.stack ?? error}`);
    console.log(`  RED ${name}: threw ${String(error?.message ?? error).slice(0, 200)}`);
  }
};
const within = (ms, promise, what) => {
  const timer = Promise.withResolvers();
  const handle = setTimeout(() => timer.reject(new Error(`${what}: no answer in ${ms} ms`)), ms);
  return Promise.race([promise, timer.promise]).finally(() => clearTimeout(handle));
};

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'build-facet-lanes-'));
try {
  // ── Two objects' facets on one binding ─────────────────────────────────
  {
    const { BuildFacet } = await freshFacetClass();
    const facets = { A: new BuildFacet({}, {}), B: new BuildFacet({}, {}) };
    const builds = await Promise.all(Object.entries(facets).flatMap(([object, facet]) => [0, 1, 2].map((n) => contexts.run(object, async () => {
      // Staggered, so each build starts while another's pump is running.
      const waited = Promise.withResolvers();
      setTimeout(waited.resolve, n * 7 + (object === 'B' ? 3 : 0));
      await waited.promise;
      const seen = [];
      const { vfs, entry, holds } = project(`${object.toLowerCase()}${n}`, 150, seen);
      const service = new EsbuildService(vfs, { buildHost: (options, plugin) => facet.build(options, plugin) });
      const result = await within(60_000, service.build([entry], { bundle: true, format: 'esm' }), `${object}'s build ${n}`);
      return { object, built: holds(result.outputFiles[0].contents), seen };
    }))));
    check('every build of both objects builds', builds.every((b) => b.built), JSON.stringify(builds.map((b) => b.built)));
    const strays = builds.flatMap((b) => b.seen.filter((context) => context !== b.object).map((context) => `${b.object}'s read in ${context}'s context`));
    check('every plugin read happens in the context of the build\'s own object', strays.length === 0, `${strays.length} reads elsewhere, e.g. ${strays.slice(0, 3).join('; ')}`);
  }

  // ── callLanes itself ───────────────────────────────────────────────────
  const loaderFile = join(scratch, 'napi-wasm-loader.mjs');
  const runtimeFile = join(scratch, 'rolldown-runtime.mjs');
  writeFileSync(loaderFile, parts.loader);
  writeFileSync(runtimeFile, parts.runtime);
  const { callLanes, createNapiWasmBinding } = await import(loaderFile);
  assert.equal(typeof callLanes, 'function', 'the loader exports callLanes');
  await section('callLanes itself', async () => {
    const lanes = callLanes(AsyncLocalStorage);
    const calls = lanes.instance(undefined);
    // A job posted from another context runs in the lane's.
    let lane;
    let ran = null;
    const job = Promise.withResolvers();
    const answer = contexts.run('owner', () => calls.run(async () => {
      lane = lanes.current();
      assert.deepEqual([...lanes.live()], [lane], 'a lane is live while its call is in flight');
      await job.promise;
      return 'answered';
    }));
    contexts.run('other', () => {
      setTimeout(() => {
        assert.equal(lanes.post(lane, () => {
          ran = contexts.getStore();
          job.resolve();
        }), true);
      }, 5);
    });
    assert.equal(await answer, 'answered');
    check('a job posted from another context runs in the lane\'s', ran === 'owner', `ran in ${ran}`);
    check('a lane ends with its call', [...lanes.live()].length === 0 && lanes.post(lane, () => {}) === false, 'still live, or a post accepted');
    // A call that rejects ends its lane too.
    let rejected;
    await assert.rejects(calls.run(async () => {
      rejected = lanes.current();
      throw new Error('the call fails');
    }), /the call fails/);
    check('a lane ends with a call that rejects', lanes.post(rejected, () => {}) === false && [...lanes.live()].length === 0, 'still accepts posts');
    check('outside a lane there is none', lanes.current() === undefined, String(lanes.current()));
    check('a post to what is not a lane is refused', lanes.post({}, () => {}) === false, 'accepted');
  });

  // ── An owner's instances ───────────────────────────────────────────────
  await section('an owner\'s instances', async () => {
    const lanes = callLanes(AsyncLocalStorage);
    const heard = [];
    lanes.onEnded((context, successor) => heard.push([context, successor]));
    let settledLane;
    await lanes.instance('object-1').run(async () => {
      settledLane = lanes.current();
    });
    check('a lane whose call settles is heard to end, abandoned to no one', heard.length === 1 && heard[0][0] === settledLane && heard[0][1] === undefined, `${heard.length} heard`);
    // Its calls all settled: the next instance's call takes nothing over.
    const second = lanes.instance('object-1');
    await second.run(async () => {});
    check('an instance after its last one\'s calls settled takes nothing over', heard.length === 2 && heard[1][1] === undefined, `${heard.length} heard`);
    // One call of `second` never settles: its object is reset under it (in
    // workerd, its context dies, and its loop and finally with it).
    let stuckLane;
    let abandonedCalls = 0;
    second.run(async () => {
      stuckLane = lanes.current();
      await new Promise(() => {});
    }, () => abandonedCalls++);
    const others = [lanes.instance('object-2'), lanes.instance(undefined)].map((owner) => {
      const done = Promise.withResolvers();
      let lane;
      const call = owner.run(async () => {
        lane = lanes.current();
        await done.promise;
      });
      return { lane: () => lane, end: () => (done.resolve(), call) };
    });
    // Posted to it just now: its loop has not run this yet.
    let ranIn = null;
    assert.equal(lanes.post(stuckLane, () => {
      ranIn = contexts.getStore() ?? 'no context';
    }), true);
    const third = contexts.run('restart', () => lanes.instance('object-1'));
    check('a new instance takes nothing over before its first call', !heard.some(([context]) => context === stuckLane), 'abandoned already');
    let successor;
    const settle = Promise.withResolvers();
    const first = contexts.run('restart', () => third.run(async () => {
      successor = lanes.current();
      await settle.promise;
    }));
    check('its first call takes over the lane its last instance left open', heard.some(([context, to]) => context === stuckLane && to === successor) && abandonedCalls === 1, `abandoned called ${abandonedCalls}`);
    check('an abandoned lane is not live and takes no post', ![...lanes.live()].includes(stuckLane) && lanes.post(stuckLane, () => {}) === false, 'still live, or a post accepted');
    check('another object\'s lane and an untracked one stay open', others.every((other) => [...lanes.live()].includes(other.lane())), `${[...lanes.live()].length} live`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    check('the abandoned lane\'s undelivered job runs in the lane that took it over', ranIn === 'restart', `ran in ${ranIn}`);
    settle.resolve();
    await first;
    await Promise.all(others.map((other) => other.end()));
    check('no lane is live once the others settle', [...lanes.live()].length === 0, `${[...lanes.live()].length} live`);
  });

  // ── The facet's binding, made by hand, with lanes as its contexts ──────
  // emnapi's own scheduler is this spy from here on: every call to it from
  // the loader is work of emnapi's that went to no call's context.
  const nativeSetImmediate = globalThis.setImmediate;
  let unrouted = 0;
  const unroutedStacks = [];
  const spySetImmediate = function (fn, ...args) {
    const stack = new Error().stack ?? '';
    if (stack.includes('napi-wasm-loader')) {
      unrouted++;
      if (unroutedStacks.length < 3) unroutedStacks.push(stack.split('\n').slice(2, 6).map((line) => line.trim()).join(' < '));
    }
    return nativeSetImmediate(fn, ...args);
  };
  globalThis.setImmediate = spySetImmediate;
  try {
    const lanes = callLanes(AsyncLocalStorage);
    let finalizerDrains = 0;
    const post = lanes.post;
    lanes.post = (context, fn) => {
      if (String(fn).includes('drainFinalizerQueue')) finalizerDrains++;
      return post.call(lanes, context, fn);
    };
    const rolldown = STAGED_BINDING_ARTIFACTS.find((b) => b.name === 'rolldown');
    const host = {
      fs: nodeFs, env: {}, writeStdout() {}, writeStderr() {},
      binding: await WebAssembly.compile(parts.rolldown), trampoline: await WebAssembly.compile(parts.trampoline),
      memoryPages: rolldown.memoryPages, name: 'rolldown',
    };
    // The binding's own count of tasks not yet finished, read past the loader.
    let aliveTasks = () => NaN;
    const NativeInstance = WebAssembly.Instance;
    WebAssembly.Instance = function (module, imports) {
      const instance = new NativeInstance(module, imports);
      if (typeof instance.exports.nimbus_napi_alive_tasks === 'function') aliveTasks = instance.exports.nimbus_napi_alive_tasks;
      return instance;
    };
    let binding;
    try {
      binding = createNapiWasmBinding({ ...host, contexts: lanes });
    } finally {
      WebAssembly.Instance = NativeInstance;
    }
    globalThis.__nimbusRolldownBinding = binding;
    const runtime = await import(runtimeFile);
    const viaRuntime = (vfs) => new EsbuildService(vfs, { buildHost: (options, plugin) => runtime.build(options, plugin) });

    await section('a build whose lane has ended', async () => {
      // The ended lane's call returns at once; its build goes on.
      const endedSeen = [];
      const ended = project('ended', 200, endedSeen);
      let endedBuild;
      let endedLane;
      let afterEnd = 0;
      const afterLane = () => {
        if (endedLane && lanes.post(endedLane, () => {}) === false) afterEnd++;
      };
      const counting = {
        ...ended.vfs,
        readFile: (p) => (afterLane(), ended.vfs.readFile(p)),
        readFileString: (p) => (afterLane(), ended.vfs.readFileString(p)),
      };
      await contexts.run('ended', () => lanes.instance(undefined).run(async () => {
        endedLane = lanes.current();
        endedBuild = viaRuntime(counting).build([ended.entry], { bundle: true, format: 'esm' });
      }));
      // A build in an open lane beside it.
      const openSeen = [];
      const open = project('open', 200, openSeen);
      const opened = contexts.run('open', () => lanes.instance(undefined).run(() => viaRuntime(open.vfs).build([open.entry], { bundle: true, format: 'esm' })));
      const [endedResult, openResult] = await within(60_000, Promise.all([endedBuild, opened]), 'the builds beside an ended lane');
      check('a build whose lane has ended finishes', ended.holds(endedResult.outputFiles[0].contents), 'its output lacks a module');
      check('its hooks went on being called after its lane ended', afterEnd > 0, `${afterEnd} reads after the lane ended`);
      check('the build in an open lane beside it finishes', open.holds(openResult.outputFiles[0].contents), 'its output lacks a module');
      check('and keeps every hook in its own context', openSeen.every((context) => context === 'open'), `contexts ${[...new Set(openSeen)]}`);
      check('no lane is live once the calls have ended', [...lanes.live()].length === 0, `${[...lanes.live()].length} live`);
    });

    await section('a build abandoned with a hook in flight', async () => {
      // Its read of m3 never answers, as a read whose object was reset.
      const hungSeen = [];
      const hung = project('hung', 40, hungSeen);
      const asked = Promise.withResolvers();
      // Held, as workerd holds a call's promise: one no one can reach would be
      // collected here, and napi-rs's finalizers would end its wait.
      const held = [];
      const hangs = (read) => (p) => (p.endsWith('/m3.js') ? (asked.resolve(), new Promise((resolve) => held.push(resolve))) : read(p));
      const hanging = { ...hung.vfs, readFile: hangs(hung.vfs.readFile), readFileString: hangs(hung.vfs.readFileString) };
      const reset = lanes.instance('reset');
      // Its JavaScript waits on that read for good (in workerd, its context is gone with it).
      contexts.run('reset', () => reset.run(() => viaRuntime(hanging).build([hung.entry], { bundle: true, format: 'esm' })));
      const besideSeen = [];
      const beside = project('beside', 150, besideSeen);
      const besideBuild = contexts.run('beside', () => lanes.instance('beside').run(() => viaRuntime(beside.vfs).build([beside.entry], { bundle: true, format: 'esm' })));
      await within(30_000, asked.promise, 'the read that never answers');
      const besideResult = await within(60_000, besideBuild, 'the build beside it');
      check('another object\'s build beside it finishes, in its own context', beside.holds(besideResult.outputFiles[0].contents) && besideSeen.every((context) => context === 'beside'), `contexts ${[...new Set(besideSeen)]}`);
      const stuck = aliveTasks();
      // The reset object's next instance builds: its first call takes the hung one's lane over.
      const againSeen = [];
      const again = project('again', 40, againSeen);
      const next = lanes.instance('reset');
      const againResult = await within(60_000, contexts.run('reset again', () => next.run(() => viaRuntime(again.vfs).build([again.entry], { bundle: true, format: 'esm' }))), 'the reset object\'s next build');
      check('the reset object builds again', again.holds(againResult.outputFiles[0].contents) && againSeen.every((context) => context === 'reset again'), `contexts ${[...new Set(againSeen)]}`);
      for (const until = Date.now() + 10_000; aliveTasks() > 0 && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 10));
      check('the abandoned build\'s task ends on the binding, refused what it awaited', stuck > 0 && aliveTasks() === 0, `${stuck} task(s) alive while it hung, ${aliveTasks()} after`);
      check('no lane is live once it is done', [...lanes.live()].length === 0, `${[...lanes.live()].length} live`);
      assert.equal(held.length, 1, 'the read that never answers was asked once');
    });

    await section('async work', async () => {
      const source = 'let a: number = 1;';
      const refused = await new Promise((resolve) => resolve(binding.enhancedTransform('a.ts', source, undefined, undefined, false))).then(() => 'it ran', (error) => String(error?.message ?? error));
      check('async work is refused on a binding run with contexts, by name', /created async work/.test(refused), refused);
      const sync = binding.enhancedTransformSync('a.ts', source, undefined, undefined, false);
      check('the synchronous transform runs there', /let a = 1/.test(sync.code), JSON.stringify(sync).slice(0, 200));
      // emnapi's scheduler is the native one on this binding: it is not routed.
      globalThis.setImmediate = nativeSetImmediate;
      let plain;
      try {
        plain = createNapiWasmBinding(host);
      } finally {
        globalThis.setImmediate = spySetImmediate;
      }
      const ran = await plain.enhancedTransform('a.ts', source, undefined, undefined, false);
      check('async work runs on a binding without contexts', /let a = 1/.test(ran.code), JSON.stringify(ran).slice(0, 200));
    });

    await section('emnapi\'s other work', async () => {
      // Releases happened in every build above. Finalizers: collect, then
      // build again, until one has run.
      for (let round = 0; round < 20 && finalizerDrains === 0; round++) {
        Bun.gc(true);
        await new Promise((resolve) => nativeSetImmediate(resolve));
        const seen = [];
        const small = project(`gc${round}`, 5, seen);
        await contexts.run(`gc${round}`, () => lanes.instance(undefined).run(() => viaRuntime(small.vfs).build([small.entry], { bundle: true, format: 'esm' })));
      }
      check('finalizers scheduled outside every call are taken by a call', finalizerDrains > 0, 'no finalizer ran in 20 collections');
      check('none of emnapi\'s work went to a timer of no call\'s context', unrouted === 0, `${unrouted}, e.g. ${unroutedStacks.join(' | ')}`);
    });
  } finally {
    globalThis.setImmediate = nativeSetImmediate;
  }
} finally {
  releaseBuildFacetHarness();
  rmSync(scratch, { recursive: true, force: true });
}

assert.equal(failures.length, 0, `${failures.length} failed:\n  ${failures.join('\n  ')}`);
console.log('build-facet-lanes OK');
