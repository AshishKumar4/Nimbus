#!/usr/bin/env bun
// A Durable Object's builds run in its build facet (facets/build-facet.ts):
// the staged threadless rolldown binding and its runtime, as production loads
// them (lib/build-facet-harness.mjs), behind rolldownBuildHost. Overlapping
// builds share one facet load; the binding is created by the first build, at
// its declared minimum, and kept; outputs and failures cross RPC as the
// esbuild facet's did; and what the facet builds is what rolldown-build.ts
// builds over the native binding (build-differential.mjs compares that with
// esbuild).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EsbuildService, buildWithEsbuild } from '../../packages/core/src/runtime/esbuild-service.ts';
import { buildWithRolldown } from '../../packages/core/src/runtime/rolldown-build.ts';
import { loadBuildFacet, prewarmBuildFacet, rolldownBuildHost, BUILD_FACET_WORKER_ID } from '../../packages/worker/src/facets/build-facet.ts';
import { STAGED_BINDING_ARTIFACTS } from '../../packages/worker/src/napi-wasm-artifacts.generated.ts';
import { PROJECTS, WRANGLER_OPTIONS } from '../fixtures/build-differential/projects.mjs';
import { CASES, FILES, NODE_MODULES } from '../fixtures/prebundle-differential/packages.mjs';
import { prebundleSlice } from '../../packages/core/src/runtime/prebundle-slice.ts';
import { PrebundlePool } from '../../packages/worker/src/facets/prebundle-pool.ts';
import { PRE_BUNDLE_CONCURRENCY } from '../../packages/platform/src/limits.ts';
import { DO_DYNAMIC_WORKER_LIMIT, loaderLedgerStats } from '../../packages/fabric/src/budgets.ts';
import { durableObject, freshFacetClass, memories, releaseBuildFacetHarness } from './lib/build-facet-harness.mjs';

const MiB = 1024 * 1024;
const PAGE = 64 * 1024;
const rolldownNative = await import(createRequire(new URL('../../packages/worker/package.json', import.meta.url)).resolve('rolldown'));
const pages = STAGED_BINDING_ARTIFACTS.find((b) => b.name === 'rolldown').memoryPages;

function memoryFs(name, files) {
  const at = new Map(Object.entries(files).map(([p, text]) => [`home/user/${name}/${p}`, new TextEncoder().encode(text)]));
  const strip = (p) => p.replace(/^\/+/, '');
  const isDir = (p) => [...at.keys()].some((k) => k.startsWith(strip(p).replace(/\/+$/, '') + '/'));
  return {
    exists: (p) => at.has(strip(p)) || isDir(p),
    isDirectory: (p) => !at.has(strip(p)) && isDir(p),
    readFile: (p) => at.get(strip(p)),
    readFileString: (p) => new TextDecoder().decode(at.get(strip(p))),
  };
}

const { BuildFacet, cleanup } = await freshFacetClass();
try {
  // ── Overlapping builds share one facet; the binding is made by the first ──
  {
    assert.equal(memories.length, 0, 'loading the facet module creates no binding');
    const { ctx, env, counts } = durableObject(BuildFacet);
    const host = rolldownBuildHost(ctx, env);
    const names = ['worker-routes', 'worker-interop', 'vite-config'];
    const outcomes = await Promise.all(names.map((name) => {
      const project = PROJECTS[name];
      return new EsbuildService(memoryFs(name, project.files), { buildHost: host })
        .build([`/home/user/${name}/${project.entry}`], project.options);
    }));
    assert.equal(counts.loaderGets, 1, 'one facet load');
    assert.equal(counts.facetInstances, 1, 'one facet');
    assert.equal(memories.length, 1, 'one binding for every build');
    assert.ok(memories[0].buffer.byteLength >= pages * PAGE && memories[0].buffer.byteLength < 64 * MiB, `${memories[0].buffer.byteLength / MiB} MiB`);
    for (const [i, name] of names.entries()) {
      const project = PROJECTS[name];
      const native = await new EsbuildService(memoryFs(name, project.files), { buildHost: (o, p) => buildWithRolldown(rolldownNative, structuredClone(o), p) })
        .build([`/home/user/${name}/${project.entry}`], project.options);
      assert.equal(outcomes[i].outputFiles[0].contents, native.outputFiles[0].contents, `${name}: the staged binding builds what the native one does`);
      assert.deepEqual(outcomes[i].metafile, native.metafile);
    }
    console.log(`  ok  three overlapping builds: one facet, one binding (${(memories[0].buffer.byteLength / MiB).toFixed(1)} MiB), native rolldown's output`);
  }

  // ── A warm-up loads the facet and its binding; the first build reuses them ──
  {
    const { BuildFacet: Fresh, cleanup: release } = await freshFacetClass();
    try {
      const { ctx, env, counts } = durableObject(Fresh);
      const before = memories.length;
      prewarmBuildFacet(ctx, env);
      prewarmBuildFacet(ctx, env);
      for (let i = 0; i < 200 && memories.length === before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(memories.length, before + 1, 'the warm-up creates the binding');
      const project = PROJECTS['worker-routes'];
      await new EsbuildService(memoryFs('worker-routes', project.files), { buildHost: rolldownBuildHost(ctx, env) })
        .build([`/home/user/worker-routes/${project.entry}`], project.options);
      assert.deepEqual([counts.loaderGets, counts.facetInstances, memories.length], [1, 1, before + 1], 'the build runs on the warmed facet and binding');
      // Without a loader there is nothing to warm, and nothing is thrown or left rejected.
      prewarmBuildFacet({ facets: ctx.facets }, {});
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      release();
    }
    console.log('  ok  a warm-up loads the facet and creates its binding; the first build reuses both');
  }

  // ── A binding grown past its mark is left behind after the call ─────────────
  // 150,000 object literals (3.1 MiB of source) grow it to about 90 MiB. A
  // build beside it on the same binding is still in flight when the next one
  // starts on a fresh isolate: two workers at once, each counted by the
  // Durable Object's Dynamic Worker ledger under its own id.
  {
    const slowEntry = '/home/user/slow/b.js';
    const { ctx, env, counts } = durableObject(BuildFacet, async () => (await freshFacetClass()).BuildFacet, {
      deliveryDelayMs: (_call, options) => (options?.entryPoints?.[0] === slowEntry ? 2_000 : 0),
    });
    const host = rolldownBuildHost(ctx, env);
    const big = memoryFs('big', { 'a.js': `export const a = [${Array.from({ length: 150_000 }, (_, i) => `{x:${i},y:"s${i}"}`).join(',')}];` });
    const small = PROJECTS['worker-routes'];
    const slow = new EsbuildService(memoryFs('slow', { 'b.js': 'export const b = 2;' }), { buildHost: host }).build([slowEntry], WRANGLER_OPTIONS);
    const built = await new EsbuildService(big, { buildHost: host }).build(['/home/user/big/a.js'], WRANGLER_OPTIONS);
    assert.ok(built.outputFiles[0].contents.length > 3_000_000, 'the big build answers');
    assert.ok(memories.at(-1).buffer.byteLength > 64 * MiB, `${memories.at(-1).buffer.byteLength / MiB} MiB`);
    assert.equal(counts.aborted.length, 0, 'its facet is not aborted while a call on it is in flight');
    const next = new EsbuildService(memoryFs('worker-routes', small.files), { buildHost: host }).build([`/home/user/worker-routes/${small.entry}`], small.options);
    for (let i = 0; i < 200 && counts.loaderIds.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const [first, fresh] = counts.loaderIds;
    assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers.sort(), [first, fresh].sort(), 'both generations are in flight, each under its own id');
    assert.equal(loaderLedgerStats(ctx).headroom, DO_DYNAMIC_WORKER_LIMIT - 2);
    await next;
    assert.equal(counts.loaderIds.length, 2, 'the next build starts a fresh isolate');
    await slow;
    assert.deepEqual(counts.aborted, [first], 'the retired facet is aborted once its last call is answered');
    assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, [], 'and the ledger holds nothing');
    console.log(`  ok  a binding grown past 64 MiB (${(memories.at(-2).buffer.byteLength / MiB).toFixed(0)} MiB) is left behind; the next build starts a fresh isolate, each generation counted as its own worker`);
  }

  // ── Placing unresolved imports is bounded and runs after the build ──────────
  // A failed build places its unresolved imports by building each importer
  // again (rolldown-build.ts locateUnresolved): after the build's bundle is
  // closed, never beside it, and not at all for an importer past 256 KiB,
  // whose error names the file alone. The binding a failed build leaves is
  // no larger than the one the same module built successfully leaves.
  {
    const objects = (n) => Array.from({ length: n }, (_, i) => `{x:${i},y:"s${i}"}`).join(',');
    const peakOf = async (source) => {
      const { BuildFacet: Fresh, cleanup: release } = await freshFacetClass();
      try {
        const { ctx, env } = durableObject(Fresh);
        const before = memories.length;
        const outcome = await new EsbuildService(memoryFs('place', { 'a.js': source }), { buildHost: rolldownBuildHost(ctx, env) })
          .build(['/home/user/place/a.js'], WRANGLER_OPTIONS)
          .then(() => null, (error) => error);
        return { peak: memories.at(-1).buffer.byteLength, failure: outcome, created: memories.length - before };
      } finally {
        release();
      }
    };
    const big = objects(60_000);
    const built = await peakOf(`export const a = [${big}];`);
    const failed = await peakOf(`export const a = [${big}];\nexport const b = () => require('./missing.js');`);
    assert.equal(built.failure, null);
    assert.ok(failed.peak <= built.peak + 2 * MiB, `a failed build's binding: ${(failed.peak / MiB).toFixed(1)} MiB, the successful build's ${(built.peak / MiB).toFixed(1)} MiB`);
    assert.match(failed.failure.message, /^Build failed with 1 error:\n\S*\/home\/user\/place\/a\.js: ERROR: Could not resolve "\.\/missing\.js"$/, 'a large importer is named, not placed');
    const small = objects(6_000);
    const placedBuilt = await peakOf(`export const a = [${small}];`);
    const placed = await peakOf(`export const a = [${small}];\nexport const b = () => require('./missing.js');`);
    assert.match(placed.failure.message, /a\.js:2:31: ERROR: Could not resolve "\.\/missing\.js"$/, 'a small importer is placed');
    assert.ok(placed.peak <= placedBuilt.peak + 4 * MiB, `placing grew the binding to ${(placed.peak / MiB).toFixed(1)} MiB from ${(placedBuilt.peak / MiB).toFixed(1)} MiB`);
    console.log(`  ok  placing unresolved imports is bounded: a ${(big.length / 1e6).toFixed(1)} MB importer is named (binding ${(failed.peak / MiB).toFixed(1)} vs ${(built.peak / MiB).toFixed(1)} MiB built), a ${(small.length / 1e3).toFixed(0)} KB one placed (${(placed.peak / MiB).toFixed(1)} vs ${(placedBuilt.peak / MiB).toFixed(1)} MiB)`);
  }

  // ── Pre-bundles run in the same facet, from their slices, one at a time ─────
  {
    const { ctx, env, counts } = durableObject(BuildFacet, async () => (await freshFacetClass()).BuildFacet);
    const sliceOf = (files) => Object.entries(files).map(([path, v]) => ({ path: '/' + path, bytes: typeof v === 'string' ? new TextEncoder().encode(v) : v, isDir: false }));
    const specOf = ({ specifier, entry, define }, files = FILES) => ({
      specifier, entryPath: `${NODE_MODULES}/${entry}`, externals: specifier.startsWith('react') ? (specifier === 'react' ? [] : ['react']) : ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      slice: sliceOf(files), bundlerVersion: 'test', define,
    });
    const pool = await new PrebundlePool(env, ctx).acquire();
    const before = counts.loaderIds.length;
    assert.equal(before, 1, 'acquire loads the facet');
    const results = await Promise.all(CASES.map((c) => pool.prebundle(specOf(c))));
    assert.equal(counts.mostPrebundling, PRE_BUNDLE_CONCURRENCY, 'pre-bundles run one at a time');
    for (const [i, c] of CASES.entries()) {
      const native = await prebundleSlice(specOf(c), (o, p) => buildWithRolldown(rolldownNative, structuredClone(o), p));
      assert.deepEqual([results[i].ok, results[i].esmCode, results[i].errorText], [native.ok, native.esmCode, native.errorText], `${c.specifier}: the staged binding pre-bundles what the native one does`);
    }
    // A module nested past the stack: that pre-bundle fails saying so, and the next one runs on a fresh isolate.
    const deep = specOf({ specifier: 'deep-sum', entry: 'deep-sum/index.js' }, {
      'home/user/app/node_modules/deep-sum/package.json': '{"name":"deep-sum","main":"index.js"}',
      'home/user/app/node_modules/deep-sum/index.js': `const t = 1; exports.x = ${Array.from({ length: 10_000 }, () => 't').join(' + ')};`,
    });
    const warn = console.warn;
    console.warn = () => {};
    let crashed;
    try {
      crashed = await pool.prebundle(deep);
    } finally {
      console.warn = warn;
    }
    assert.deepEqual([crashed.ok, crashed.errorText], [false, "Nimbus's bundler ran out of stack: a module nests too deeply for it (Maximum call stack size exceeded.)"]);
    const after = await pool.prebundle(specOf(CASES.find((c) => c.specifier === 'cjs-lib')));
    assert.equal(after.ok, true);
    assert.equal(counts.loaderIds.length, 2, 'the next pre-bundle loads a fresh isolate');
    console.log(`  ok  ${CASES.length} pre-bundles through PrebundlePool: one facet load, one at a time, native rolldown's output; a dying binding fails only its own`);
  }

  // ── A failed build crosses RPC as esbuild's did ─────────────────────────────
  {
    const { ctx, env } = durableObject(BuildFacet);
    const project = PROJECTS['worker-unresolved'];
    const service = new EsbuildService(memoryFs('worker-unresolved', project.files), { buildHost: rolldownBuildHost(ctx, env) });
    await assert.rejects(service.build([`/home/user/worker-unresolved/${project.entry}`], project.options), (error) => {
      assert.equal(error.message, 'Build failed with 1 error:\nnimbus-vfs:/home/user/worker-unresolved/src/index.js:1:18: ERROR: Could not resolve "./missing.js"');
      assert.equal(error.errors.length, 1);
      assert.deepEqual(error.errors[0].location, {
        file: 'nimbus-vfs:/home/user/worker-unresolved/src/index.js', namespace: '', line: 1, column: 18, length: 14,
        lineText: "import { x } from './missing.js';", suggestion: '',
      });
      return true;
    });
    console.log('  ok  a failed build rejects with esbuild\'s message and its diagnostics');
  }

  // ── Options no caller passes are refused, not ignored ───────────────────────
  {
    const { ctx, env } = durableObject(BuildFacet);
    const project = PROJECTS['worker-routes'];
    const service = new EsbuildService(memoryFs('worker-routes', project.files), { buildHost: rolldownBuildHost(ctx, env) });
    // tsconfigRaw is read as esbuild reads it (tsconfig-jsx-differential); what the bundler cannot honour is refused by name.
    await assert.rejects(service.build([`/home/user/worker-routes/${project.entry}`], {
      ...project.options, tsconfigRaw: '{"extends":"./tsconfig.base.json","compilerOptions":{"jsx":"react-jsx"}}',
    }), /tsconfigRaw "extends" is not supported/);
    console.log('  ok  a tsconfig field the bundler does not implement is refused by name');
  }

  // ── A binding that dies answers every build, and the next one is fresh ──────
  // A 10,000-term sum overflows the stack inside the binding; esbuild builds it.
  {
    const fromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
    globalThis.self ??= globalThis;
    const esbuild = await import(fromCore.resolve('esbuild-wasm/esm/browser.js'));
    await esbuild.initialize({ wasmModule: await WebAssembly.compile(await readFile(fromCore.resolve('esbuild-wasm/esbuild.wasm'))), worker: false });
    const deep = memoryFs('deep', { 'a.js': `const t = 1; export const x = ${Array.from({ length: 10_000 }, () => 't').join(' + ')};` });
    const fine = memoryFs('fine', { 'b.js': 'export const y = 2;' });
    // esbuild's builds of what a dead binding left, each counted while it runs.
    let esbuildBuilds = 0;
    const esbuildBuild = async (options, plugin) => {
      esbuildBuilds++;
      try {
        return structuredClone(await buildWithEsbuild(esbuild, structuredClone(options), plugin));
      } finally {
        esbuildBuilds--;
      }
    };
    // A build is answered, or its answer is lost: it is still pending while
    // nothing it could be waiting on is under way (no facet evaluated or
    // called by these Durable Objects, no esbuild build), at two looks in a
    // row. Not a deadline: load slows what is under way (a fresh facet's
    // evaluation took 11 s of a 17 s build with eight copies of this file
    // running), and only a lost answer leaves the build pending with nothing
    // to wait for. A facet call that never returns is the harness's to
    // prevent (each copy's own binding, lib/build-facet-harness.mjs).
    const within = async (promise, what, ...objects) => {
      const pending = Symbol('pending');
      let idle = 0;
      for (;;) {
        const value = await Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 10, pending))]);
        if (value !== pending) return value;
        idle = esbuildBuilds > 0 || objects.some((object) => object.busy()) ? 0 : idle + 1;
        if (idle === 2) throw new Error(`${what} never settled, though nothing it waits on is under way`);
      }
    };
    await assert.rejects(within(new Promise(() => {}), 'a dropped answer'), /a dropped answer never settled/, 'a build left pending with nothing under way is reported');
    const settled = (promise) => promise.then(({ outputFiles: [{ contents }] }) => ({ code: typeof contents === 'string' ? contents : new TextDecoder().decode(contents) }), (error) => ({ failure: error.message }));
    const warned = [];
    const warn = console.warn;
    // The build of fine/b.js gets its answer `ms` late.
    const siblingLate = (ms) => (_call, options) => (options?.entryPoints?.[0] === '/home/user/fine/b.js' ? ms : 0);
    for (const withFallback of [true, false]) {
      // Each loader id is a fresh evaluation of the facet module: a fresh isolate.
      // The sibling's answer arrives 50 ms after the deep build's: that first
      // crashed answer must not abort the facet while this one is on its way.
      const object = durableObject(BuildFacet, async () => (await freshFacetClass()).BuildFacet, { deliveryDelayMs: siblingLate(50) });
      const { ctx, env, counts } = object;
      const fallbackBuilds = [];
      const fallback = async (options, plugin) => {
        fallbackBuilds.push(options.entryPoints[0]);
        return esbuildBuild(options, plugin);
      };
      const host = rolldownBuildHost(ctx, env, withFallback ? fallback : undefined);
      const build = (fs, entry) => settled(new EsbuildService(fs, { buildHost: host }).build([entry], WRANGLER_OPTIONS));
      console.warn = (line) => warned.push(line);
      let outcomes;
      try {
        outcomes = await within(Promise.all([build(deep, '/home/user/deep/a.js'), build(fine, '/home/user/fine/b.js')]), 'a build on the dead binding', object);
      } finally {
        console.warn = warn;
      }
      const [deepOutcome, fineOutcome] = outcomes;
      if (withFallback) {
        assert.match(deepOutcome.code, /var x = t \+ t \+ t/, 'esbuild builds the deep module');
        assert.match(fineOutcome.code, /var y = 2/, 'the build in flight beside it is built too');
        assert.deepEqual(fallbackBuilds.sort(), ['/home/user/deep/a.js', '/home/user/fine/b.js']);
      } else {
        for (const outcome of outcomes) {
          assert.equal(outcome.failure, "Build failed with 1 error:\nerror: Nimbus's bundler ran out of stack: a module nests too deeply for it (Maximum call stack size exceeded.)");
        }
      }
      assert.ok(warned.splice(0).every((line) => /^\[build-facet\] rolldown's binding died building \/home\/user\/(deep\/a|fine\/b)\.js \(Maximum call stack size exceeded\.\); /.test(line)));
      const later = await within(build(fine, '/home/user/fine/b.js'), 'the next build', object);
      assert.match(later.code, /const y = 2|var y = 2/, 'the next build runs');
      const [died, fresh] = counts.loaderIds.map((id) => Number(/:g(\d+)$/.exec(id)[1]));
      assert.equal(counts.loaderIds.length, 2);
      assert.equal(fresh, died + 1, 'on a fresh isolate');
      assert.ok(counts.aborted.length > 0 && counts.aborted.every((name) => name.endsWith(`:g${died}`)), 'the dead facet is aborted');
    }
    // A call on the dead generation that gets an error instead of its answer
    // (here, its facet aborted under it) is that death too: esbuild builds it.
    {
      const object = durableObject(BuildFacet, async () => (await freshFacetClass()).BuildFacet, { deliveryDelayMs: siblingLate(2000) });
      const { ctx, env, counts } = object;
      const fallbackBuilds = [];
      const host = rolldownBuildHost(ctx, env, async (options, plugin) => {
        fallbackBuilds.push(options.entryPoints[0]);
        return esbuildBuild(options, plugin);
      });
      const build = (fs, entry) => settled(new EsbuildService(fs, { buildHost: host }).build([entry], WRANGLER_OPTIONS));
      console.warn = () => {};
      try {
        const sibling = build(fine, '/home/user/fine/b.js');
        const first = await within(build(deep, '/home/user/deep/a.js'), 'the deep build', object);
        assert.match(first.code, /var x = t \+ t/);
        ctx.facets.abort(counts.loaderIds[0], new Error('aborted under its call'));
        assert.match((await within(sibling, 'the aborted sibling', object)).code, /var y = 2/, 'the aborted sibling is built by esbuild');
      } finally {
        console.warn = warn;
      }
      assert.deepEqual(fallbackBuilds.sort(), ['/home/user/deep/a.js', '/home/user/fine/b.js']);
    }
    // Another Durable Object's dead binding moves this one to the next
    // generation too, without cancelling the build it still has in flight.
    {
      const a = durableObject(BuildFacet, async () => (await freshFacetClass()).BuildFacet, { deliveryDelayMs: (call) => (call === 0 ? 300 : 0) });
      const b = durableObject(BuildFacet, async () => (await freshFacetClass()).BuildFacet);
      const hostA = rolldownBuildHost(a.ctx, a.env);
      const hostB = rolldownBuildHost(b.ctx, b.env);
      console.warn = () => {};
      try {
        const long = settled(new EsbuildService(fine, { buildHost: hostA }).build(['/home/user/fine/b.js'], WRANGLER_OPTIONS));
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok((await within(settled(new EsbuildService(deep, { buildHost: hostB }).build(['/home/user/deep/a.js'], WRANGLER_OPTIONS)), 'b', a, b)).failure);
        const next = await within(settled(new EsbuildService(fine, { buildHost: hostA }).build(['/home/user/fine/b.js'], WRANGLER_OPTIONS)), 'a, again', a, b);
        assert.match(next.code, /const y = 2|var y = 2/, 'the next build runs on the next generation');
        assert.match((await within(long, 'a, in flight', a, b)).code, /const y = 2|var y = 2/, 'the build in flight on the retired generation still answers');
        assert.equal(a.counts.aborted.length, 1, 'and its facet is aborted once it has');
      } finally {
        console.warn = warn;
      }
    }
    // Two isolates loading at the same time each build on their own binding,
    // so one's dying leaves the other building. Evaluated first, they load in
    // the same turn, each binding made before either's rolldown has read one.
    {
      const [first, second] = await Promise.all([freshFacetClass(), freshFacetClass()]);
      const a = durableObject(first.BuildFacet);
      const b = durableObject(second.BuildFacet);
      console.warn = () => {};
      try {
        await within(Promise.all([loadBuildFacet(a.ctx, a.env), loadBuildFacet(b.ctx, b.env)]), 'two loads at once', a, b);
        const died = await within(settled(new EsbuildService(deep, { buildHost: rolldownBuildHost(b.ctx, b.env) }).build(['/home/user/deep/a.js'], WRANGLER_OPTIONS)), 'b', a, b);
        assert.ok(died.failure, 'b\'s binding dies');
        const built = await within(settled(new EsbuildService(fine, { buildHost: rolldownBuildHost(a.ctx, a.env) }).build(['/home/user/fine/b.js'], WRANGLER_OPTIONS)), 'a, beside b\'s dead binding', a, b);
        assert.match(built.code, /const y = 2|var y = 2/, 'a builds on its own');
      } finally {
        console.warn = warn;
      }
    }
    await esbuild.stop();
    console.log('  ok  a binding that dies answers every build on it (esbuild builds them, or each fails saying why); the next build gets a fresh isolate; a retired facet is aborted only once its calls are answered');
  }
  assert.match(BUILD_FACET_WORKER_ID, /^nimbus-build:rolldown-1\.2\.11-[0-9a-f]{16}:/);
} finally {
  cleanup();
  releaseBuildFacetHarness();
}
console.log('build-facet OK');
