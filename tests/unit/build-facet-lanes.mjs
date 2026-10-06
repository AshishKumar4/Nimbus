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
//   - A build whose lane has ended while its hooks are still being called
//     (its call returned without waiting for it) still finishes, its hooks
//     run where they are dispatched, and a build in an open lane beside it
//     keeps every hook in its own context.

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

  // ── callLanes itself, and a build whose lane has ended ─────────────────
  const loaderFile = join(scratch, 'napi-wasm-loader.mjs');
  const runtimeFile = join(scratch, 'rolldown-runtime.mjs');
  writeFileSync(loaderFile, parts.loader);
  writeFileSync(runtimeFile, parts.runtime);
  const { callLanes, createNapiWasmBinding } = await import(loaderFile);
  assert.equal(typeof callLanes, 'function', 'the loader exports callLanes');
  {
    const lanes = callLanes(AsyncLocalStorage);
    // A job posted from another context runs in the lane's.
    let lane;
    let ran = null;
    const job = Promise.withResolvers();
    const answer = contexts.run('owner', () => lanes.run(async () => {
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
    await assert.rejects(lanes.run(async () => {
      rejected = lanes.current();
      throw new Error('the call fails');
    }), /the call fails/);
    check('a lane ends with a call that rejects', lanes.post(rejected, () => {}) === false && [...lanes.live()].length === 0, 'still accepts posts');
    check('outside a lane there is none', lanes.current() === undefined, String(lanes.current()));
  }
  {
    // The facet's binding, made by hand, with lanes as its contexts.
    const lanes = callLanes(AsyncLocalStorage);
    const rolldown = STAGED_BINDING_ARTIFACTS.find((b) => b.name === 'rolldown');
    globalThis.__nimbusRolldownBinding = createNapiWasmBinding({
      fs: nodeFs, env: {}, writeStdout() {}, writeStderr() {},
      binding: await WebAssembly.compile(parts.rolldown), trampoline: await WebAssembly.compile(parts.trampoline),
      memoryPages: rolldown.memoryPages, name: 'rolldown', contexts: lanes,
    });
    const runtime = await import(runtimeFile);
    const viaRuntime = (vfs) => new EsbuildService(vfs, { buildHost: (options, plugin) => runtime.build(options, plugin) });

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
    await contexts.run('ended', () => lanes.run(async () => {
      endedLane = lanes.current();
      endedBuild = viaRuntime(counting).build([ended.entry], { bundle: true, format: 'esm' });
    }));
    // A build in an open lane beside it.
    const openSeen = [];
    const open = project('open', 200, openSeen);
    const opened = contexts.run('open', () => lanes.run(() => viaRuntime(open.vfs).build([open.entry], { bundle: true, format: 'esm' })));
    const [endedResult, openResult] = await within(60_000, Promise.all([endedBuild, opened]), 'the builds beside an ended lane');
    check('a build whose lane has ended finishes', ended.holds(endedResult.outputFiles[0].contents), 'its output lacks a module');
    check('its hooks went on being called after its lane ended', afterEnd > 0, `${afterEnd} reads after the lane ended`);
    check('the build in an open lane beside it finishes', open.holds(openResult.outputFiles[0].contents), 'its output lacks a module');
    check('and keeps every hook in its own context', openSeen.every((context) => context === 'open'), `contexts ${[...new Set(openSeen)]}`);
    check('no lane is live once the calls have ended', [...lanes.live()].length === 0, `${[...lanes.live()].length} live`);
  }
} finally {
  releaseBuildFacetHarness();
  rmSync(scratch, { recursive: true, force: true });
}

assert.equal(failures.length, 0, `${failures.length} failed:\n  ${failures.join('\n  ')}`);
console.log('build-facet-lanes OK');
