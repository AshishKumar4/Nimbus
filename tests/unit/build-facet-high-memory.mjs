#!/usr/bin/env bun
// build-facet-high-memory — the staged rolldown binding builds with its
// memory past the Workers runtime's ArrayBuffer cap.
//
// A Worker caps an ArrayBuffer at 128 MiB; only a WebAssembly.Memory grows
// past it, and on such a buffer `subarray` refuses a begin past the cap
// (lib/platform-subarray-limit.mjs). The napi-wasm loader's N-API layer
// (emnapi, pinned) read the binding's strings and buffers with
// `HEAPU8.subarray(pointer, end)`: past 128 MiB of memory, rolldown's
// results came back "RangeError: Invalid array buffer length", and Vite 8's
// optimizer pre-bundling React with lucide-react failed. The loader is
// rebuilt (scripts/napi-wasm/build.mjs) with emnapi's views of its heap taken
// by the constructor (specs.mjs EMNAPI.seams), and the loader's own
// random_get likewise.
//
// The cap is simulated at 1 MiB: every pointer into the binding's heap is past
// it, so a build exercises the whole N-API surface it uses.
import assert from 'node:assert/strict';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { rolldownBuildHost } from '../../packages/worker/src/facets/build-facet.ts';
import { PROJECTS } from '../fixtures/build-differential/projects.mjs';
import { durableObject, freshFacetClass, memories, releaseBuildFacetHarness } from './lib/build-facet-harness.mjs';
import { simulatePlatformSubarrayLimit } from './lib/platform-subarray-limit.mjs';

const LIMIT = 1 << 20;

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

const platform = simulatePlatformSubarrayLimit(LIMIT);
const { BuildFacet, cleanup } = await freshFacetClass();
try {
  const { ctx, env } = durableObject(BuildFacet);
  const host = rolldownBuildHost(ctx, env);
  for (const name of ['worker-routes', 'worker-interop']) {
    const project = PROJECTS[name];
    const result = await new EsbuildService(memoryFs(name, project.files), { buildHost: host })
      .build([`/home/user/${name}/${project.entry}`], { ...project.options, sourcemap: true });
    assert.deepEqual(result.errors ?? [], [], `${name} builds with the binding's heap past the cap`);
    assert.ok(result.outputFiles?.length > 0 && result.outputFiles[0].contents.length > 0, `${name}: and its output is read back`);
  }
  assert.ok(memories.length > 0 && memories[0].buffer.byteLength > LIMIT, 'the binding\'s memory is past the simulated cap');
  assert.equal(platform.refused, 0, 'no view of the binding\'s heap was taken with subarray past the cap');
} finally {
  platform.restore();
  cleanup();
  releaseBuildFacetHarness();
}
console.log('build-facet-high-memory: ok');
