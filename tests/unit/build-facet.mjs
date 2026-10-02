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
import { createRequire } from 'node:module';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { buildWithRolldown } from '../../packages/core/src/runtime/rolldown-build.ts';
import { rolldownBuildHost, BUILD_FACET_WORKER_ID } from '../../packages/worker/src/facets/build-facet.ts';
import { STAGED_BINDING_ARTIFACTS } from '../../packages/worker/src/napi-wasm-artifacts.generated.ts';
import { PROJECTS } from '../fixtures/build-differential/projects.mjs';
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
  assert.match(BUILD_FACET_WORKER_ID, /^nimbus-build:rolldown-1\.2\.11-[0-9a-f]{16}:/);
} finally {
  cleanup();
  releaseBuildFacetHarness();
}
console.log('build-facet OK');
