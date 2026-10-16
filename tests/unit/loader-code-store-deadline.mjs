#!/usr/bin/env bun
// @tier slow — waits out the store's 60 s put deadline.
// A put to the Worker Loader shim's code store whose bytes stop coming is
// abandoned at its deadline (FAB-2): its producer is cancelled, nothing is
// published, its charge is given back, and its owner's directory is removed
// once it is released.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const { SqliteVFS, loaderCodeRegistry, LOADER_CODE_ROOT } = await importWorkerBundle({
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/worker/src/wrangler/loader-code-store.ts': ['loaderCodeRegistry', 'LOADER_CODE_ROOT'],
});

const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const registry = loaderCodeRegistry(engine);
const owner = registry.mint('wrangler-1', 'LOADER');
const data = new TextEncoder().encode('bytes that never come');
let cancelled = false;
const stalled = new ReadableStream({ start() {}, cancel() { cancelled = true; } });
const started = Date.now();
await assert.rejects(registry.serve({ kind: 'put', owner, digest: createHash('sha256').update(data).digest('hex'), size: data.byteLength }, stalled), /stopped coming for 60 s/);
assert.ok(Date.now() - started >= 59_000, 'not before its deadline');
assert.equal(cancelled, true, 'its producer is cancelled');
assert.deepEqual([registry.stats().storeBytes, registry.stats().putting], [0, 0], 'its charge is given back');
registry.release(owner);
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(registry.stats().removing, 0);
assert.deepEqual(engine.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 }).readdir(LOADER_CODE_ROOT), [], 'nothing was published, and its directory is gone');
console.log('ok - loader-code-store-deadline (a stalled put is abandoned at 60 s, its producer cancelled and its charge given back)');
