#!/usr/bin/env bun
// The ESM→CJS transform cache is bounded by BYTES and reports what it holds.
//
// It was unbounded. Every transformed cell stayed in module scope forever, a
// second copy of what the prefetch entry already retained, and a tool whose
// bundle is a few large ESM chunks (pi: 14 MB in 22 files) filled it on its
// first launch. Every distinct shell command moves the global revision, so
// the next launch rebuilt the bundle with both copies resident plus its own
// transient peak, and the Durable Object was reset. With nothing retained
// between builds the same launches complete (measured on a throwaway,
// 2026-09-21), so the retained bytes are the whole difference.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { readDiagCounters } from '../../packages/platform/src/diag-counters.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { ESM_TRANSFORM_CACHE_MAX_BYTES } from '../../packages/core/src/constants.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

const env = {
  LOADER: {
    load() {
      return { getEntrypoint: () => ({ async fetch() { return Response.json({ exitCode: 0, stdout: '', stderr: '' }); } }) };
    },
    get() { throw new Error('unused'); },
  },
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(
        readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
        { status: 200 },
      );
    },
  },
};

const manager = new FacetManager(
  createFacetCtx(createFacetWorld(() => ({})), 'transform-cache-bound'),
  env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {},
);
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs, new SqliteFilesystemAuthority(vfs));
// Stands in for esbuild's CJS emit (the wasm is a wrangler-time binding, not
// available here), as the transform host the session's esbuild uses: the
// output is the input's size, which is what the bound prices.
let transforms = 0;
manager.setEsbuildService(new EsbuildService(undefined, {
  transformHost: async (requests) => requests.map(({ code, options }) => {
    assert.equal(options.format, 'cjs');
    transforms++;
    return { code: code.replace(/^export const /m, 'exports.x = '), map: '', warnings: [] };
  }),
}));

// ESM modules of a size the walker stages whole and esbuild transforms. Each
// program imports a different one, so each build transforms fresh content.
const fs = vfs.as(CRED_KERNEL);
fs.mkdir('home/user', { recursive: true, mode: 0o755 });
const CHUNK = 2 * 1024 * 1024;
const PROGRAMS = 12;
for (let i = 0; i < PROGRAMS; i++) {
  fs.writeFile(`home/user/chunk${i}.mjs`, `export const data${i} = "${'x'.repeat(CHUNK)}";\n`, { mode: 0o644 });
}
const cacheBytes = () => readDiagCounters().transformCacheBytes;

for (let i = 0; i < PROGRAMS; i++) {
  await manager.exec(`require('./chunk${i}.mjs');`, {
    filename: `/home/user/run${i}.js`,
    cwd: '/home/user',
    captureOutput: true,
  });
  assert.ok(
    cacheBytes() <= ESM_TRANSFORM_CACHE_MAX_BYTES,
    `after exec ${i} the transform cache holds ${cacheBytes()} bytes, over the ${ESM_TRANSFORM_CACHE_MAX_BYTES} bound`,
  );
}
// The bound has to have actually done something, or the assertion above is
// vacuous: the transformed chunks together are several times the bound.
assert.ok(PROGRAMS * CHUNK > ESM_TRANSFORM_CACHE_MAX_BYTES * 2,
  'the workload really does exceed the byte bound many times over');
assert.ok(cacheBytes() > 0, 'the cache still holds the most recent work');
assert.equal(transforms, PROGRAMS, 'every chunk was transformed once, so the cache held real emit');

// An output larger than the WHOLE bound is used for the build that produced
// it and not retained, so the cache never sits over its bound holding one
// thing nobody else fits beside.
fs.writeFile(
  'home/user/huge.mjs',
  `export const huge = "${'x'.repeat(ESM_TRANSFORM_CACHE_MAX_BYTES + 1024)}";\n`,
  { mode: 0o644 },
);
const before = cacheBytes();
const result = await manager.exec("require('./huge.mjs');", {
  filename: '/home/user/run-huge.js',
  cwd: '/home/user',
  captureOutput: true,
});
assert.equal(result.exitCode, 0, 'the invocation is still served from the transform it refuses to keep');
assert.ok(cacheBytes() <= before, `an oversized output was retained: ${before} → ${cacheBytes()} bytes`);
assert.ok(cacheBytes() <= ESM_TRANSFORM_CACHE_MAX_BYTES, 'and the cache is still inside its bound');

console.log('esm-transform-cache-byte-bound: ok');
