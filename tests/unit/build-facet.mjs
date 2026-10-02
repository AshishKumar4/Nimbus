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
import { prewarmBuildFacet, rolldownBuildHost, BUILD_FACET_WORKER_ID } from '../../packages/worker/src/facets/build-facet.ts';
import { STAGED_BINDING_ARTIFACTS } from '../../packages/worker/src/napi-wasm-artifacts.generated.ts';
import { PROJECTS, WRANGLER_OPTIONS } from '../fixtures/build-differential/projects.mjs';
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
    await assert.rejects(service.build([`/home/user/worker-routes/${project.entry}`], { ...project.options, tsconfigRaw: '{"compilerOptions":{"jsx":"react-jsx"}}' }),
      /Nimbus's bundler does not support tsconfigRaw/);
    console.log('  ok  an option the bundler does not implement is refused');
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
    const within = (promise, what) => {
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} never settled`)), 20_000); });
      return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
    };
    const settled = (promise) => promise.then(({ outputFiles: [{ contents }] }) => ({ code: typeof contents === 'string' ? contents : new TextDecoder().decode(contents) }), (error) => ({ failure: error.message }));
    const warned = [];
    const warn = console.warn;
    for (const withFallback of [true, false]) {
      // Each loader id is a fresh evaluation of the facet module: a fresh isolate.
      const { ctx, env, counts } = durableObject(BuildFacet, async () => (await freshFacetClass()).BuildFacet);
      const fallbackBuilds = [];
      const fallback = async (options, plugin) => {
        fallbackBuilds.push(options.entryPoints[0]);
        return structuredClone(await buildWithEsbuild(esbuild, structuredClone(options), plugin));
      };
      const host = rolldownBuildHost(ctx, env, withFallback ? fallback : undefined);
      const build = (fs, entry) => settled(new EsbuildService(fs, { buildHost: host }).build([entry], WRANGLER_OPTIONS));
      console.warn = (line) => warned.push(line);
      let outcomes;
      try {
        outcomes = await within(Promise.all([build(deep, '/home/user/deep/a.js'), build(fine, '/home/user/fine/b.js')]), 'a build on the dead binding');
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
      const later = await within(build(fine, '/home/user/fine/b.js'), 'the next build');
      assert.match(later.code, /const y = 2|var y = 2/, 'the next build runs');
      const [died, fresh] = counts.loaderIds.map((id) => Number(/:g(\d+)$/.exec(id)[1]));
      assert.equal(counts.loaderIds.length, 2);
      assert.equal(fresh, died + 1, 'on a fresh isolate');
      assert.ok(counts.aborted.length > 0 && counts.aborted.every((name) => name.endsWith(`:g${died}`)), 'the dead facet is aborted');
    }
    await esbuild.stop();
    console.log('  ok  a binding that dies answers every build on it (esbuild builds them, or each fails saying why); the next build gets a fresh isolate');
  }
  assert.match(BUILD_FACET_WORKER_ID, /^nimbus-build:rolldown-1\.2\.11-[0-9a-f]{16}:/);
} finally {
  cleanup();
  releaseBuildFacetHarness();
}
console.log('build-facet OK');
