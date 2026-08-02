#!/usr/bin/env bun
// The prefetch-bundle LRU is bounded by BYTES, not by entry count.
//
// It used to be capped at PREFETCH_CACHE_MAX = 16 entries, which bounds
// nothing: each entry retains a raw bundle plus its serialized source,
// manifest and metadata, and it persists ACROSS execs. Sixteen pi-sized
// entries hold several times the whole supervisor ceiling — the same defect
// class as the 44 MB node boot payload, something sized by count when what
// matters is bytes.
//
// The cache also has to report what it holds. A cache that cannot say its own
// size is exactly what made the heap estimator read 9.4 MiB while bundle
// bytes were resetting the DO.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { readDiagCounters } from '../../packages/worker/src/observability/diag-counters.ts';
import { PREFETCH_CACHE_MAX_BYTES } from '../../packages/worker/src/constants.ts';

setCtxExports({
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
  { id: { toString: () => 'prefetch-cache-bound' }, waitUntil() {} },
  env, new SessionProcessSupervisor(), new PortRegistry(), {},
);
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs);

// A working tree of big files. Each program requires a different one, so each
// exec builds a distinct multi-MiB bundle that the LRU would otherwise retain
// all of, by entry count, forever.
const fs = vfs.as(CRED_KERNEL);
fs.mkdir('home/user', { recursive: true, mode: 0o755 });
const BIG = 3 * 1024 * 1024;
const PROGRAMS = 12;
for (let i = 0; i < PROGRAMS; i++) {
  fs.writeFile(`home/user/data${i}.js`, `module.exports = "${'x'.repeat(BIG)}";\n`, { mode: 0o644 });
}

const cacheBytes = () => readDiagCounters().prefetchCacheBytes;

for (let i = 0; i < PROGRAMS; i++) {
  await manager.exec(`require('./data${i}.js');`, {
    filename: `/home/user/run${i}.js`,
    cwd: '/home/user',
    captureOutput: true,
  });
  assert.ok(
    cacheBytes() <= PREFETCH_CACHE_MAX_BYTES,
    `after exec ${i} the cache holds ${cacheBytes()} bytes, over the ${PREFETCH_CACHE_MAX_BYTES} bound`,
  );
}

// The bound has to have actually done something, or the assertion above is
// vacuous: 12 distinct 3 MiB bundles are far more than the bound admits, and
// all 12 are well inside the old entry count of 16.
assert.ok(PROGRAMS * BIG > PREFETCH_CACHE_MAX_BYTES * 2,
  'the workload really does exceed the byte bound many times over');
assert.ok(PROGRAMS <= 16,
  'and stays inside the entry count, so only the byte bound can be what evicted');
assert.ok(cacheBytes() > 0, 'the cache still holds the most recent work');

console.log('prefetch-cache-byte-bound: ok');
