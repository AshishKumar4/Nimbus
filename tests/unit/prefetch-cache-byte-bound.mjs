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
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { readDiagCounters } from '../../packages/core/src/observability/diag-counters.ts';
import { PREFETCH_CACHE_MAX_BYTES } from '../../packages/core/src/constants.ts';

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
  env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {},
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

// An entry larger than the WHOLE bound must not be retained.
//
// It used to be admitted anyway, on the reasoning that refusing it means never
// caching the program the session is running. But admitting it evicted every
// other entry to make room for something that still did not fit, so the cache
// ended up over its own bound with nothing else in it — the pressure the bound
// exists to prevent, reached by way of the bound.
{
  const oversized = new FacetManager(
    { id: { toString: () => 'prefetch-cache-oversized' }, waitUntil() {} },
    env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {},
  );
  const oversizedHarness = createSqliteVfsTestHarness();
  const oversizedVfs = new SqliteVFS(oversizedHarness.sql, oversizedHarness.ctx);
  oversized.setVfs(oversizedVfs);
  const oversizedFs = oversizedVfs.as(CRED_KERNEL);
  oversizedFs.mkdir('home/user/big', { recursive: true, mode: 0o755 });
  oversizedFs.writeFile(
    'home/user/big/data.js',
    `module.exports = "${'x'.repeat(PREFETCH_CACHE_MAX_BYTES + 1024)}";\n`,
    { mode: 0o644 },
  );

  const result = await oversized.exec("require('./data.js');", {
    filename: '/home/user/big/run.js',
    cwd: '/home/user/big',
    captureOutput: true,
  });
  assert.equal(result.exitCode, 0, 'the invocation is still served from the build it refuses to keep');
  assert.equal(cacheBytes(), 0, 'an entry larger than the byte bound must not be retained');
}

// An entry built at an older revision can never be served again — the lookup
// demands an exact revision match — so it is retained garbage from the first
// write after it was admitted. It goes before the build that replaces it
// allocates, so the two filesystem graphs never co-reside.
{
  const stale = new FacetManager(
    { id: { toString: () => 'prefetch-cache-stale' }, waitUntil() {} },
    env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {},
  );
  const staleHarness = createSqliteVfsTestHarness();
  const staleVfs = new SqliteVFS(staleHarness.sql, staleHarness.ctx);
  stale.setVfs(staleVfs);
  const staleFs = staleVfs.as(CRED_KERNEL);
  staleFs.mkdir('home/user/large', { recursive: true, mode: 0o755 });
  staleFs.mkdir('home/user/small', { recursive: true, mode: 0o755 });
  staleFs.writeFile(
    'home/user/large/data.js',
    `module.exports = "${'x'.repeat(4 * 1024 * 1024)}";\n`,
    { mode: 0o644 },
  );
  staleFs.writeFile('home/user/small/data.js', 'module.exports = 1;\n', { mode: 0o644 });

  await stale.exec("require('./data.js');", {
    filename: '/home/user/large/run.js',
    cwd: '/home/user/large',
    captureOutput: true,
  });
  const retained = cacheBytes();
  assert.ok(retained > 4 * 1024 * 1024, 'the first exec retained the large entry');

  staleFs.writeFile('home/user/revision-marker', 'changed', { mode: 0o644 });
  await stale.exec("require('./data.js');", {
    filename: '/home/user/small/run.js',
    cwd: '/home/user/small',
    captureOutput: true,
  });
  assert.ok(
    cacheBytes() < retained / 2,
    `the unservable ${retained}-byte entry survived a revision change; cache holds ${cacheBytes()} bytes`,
  );
}

console.log('prefetch-cache-byte-bound: ok');
