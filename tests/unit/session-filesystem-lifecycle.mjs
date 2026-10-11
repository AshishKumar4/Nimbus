#!/usr/bin/env bun
// A session's filesystem is one resource: its engine, the namespace
// authority over it, the supervisor ops' bridges and the engine's
// subscription to the isolate's allocation budget open together and close
// together, and a destroy closes the whole of it.
//
// Before, a destroy dropped the engine and the supervisor ops, and kept the
// rest: the budget's isolate-wide observer set held the old engine (shrunk
// and restored on every heavy allocation for the isolate's life), the host
// leases the supervisor ops held stayed open, and the authority memoized over
// the old engine — fenced by the destroy's own exclusive lease — went on
// answering for the session that replaced it.

import assert from 'node:assert/strict';
import { rpcDestroy } from '../../packages/worker/src/session/programmatic.ts';
import { SessionFilesystem } from '../../packages/worker/src/session/session-filesystem.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { acquireHeavyAlloc } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { assumeGeneration } from '../../packages/fabric/src/generation.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

/** How many times `engine` has been shrunk for a heavy allocation. */
function countShrinks(engine) {
  const counted = { shrinks: 0 };
  const shrink = engine.shrinkForInstall.bind(engine);
  engine.shrinkForInstall = () => { counted.shrinks++; shrink(); };
  return counted;
}

const harness = createSqliteVfsTestHarness();
const storage = new Map();
const host = {
  _w1SessionDestroyed: false,
  env: {},
  ctx: {
    getWebSockets: () => [],
    storage: {
      async get(k) { return storage.get(k); },
      async put(k, v) { storage.set(k, v); },
      async delete(k) { storage.delete(k); },
      async deleteAll() { storage.clear(); },
      async deleteAlarm() {},
    },
  },
  filesystem: null,
  get sqliteFs() { return this.filesystem?.engine ?? null; },
  // The session's own: a filesystem over its database, opened on first use.
  ensureSqliteFs() { this.filesystem ??= new SessionFilesystem(new SqliteVFS(harness.sql, harness.ctx), this); },
  getFilesystemAuthority() { this.ensureSqliteFs(); return this.filesystem.authority; },
  processes: new SessionProcessSupervisor(),
  portRegistry: new PortRegistry(),
  facetManager: null,
  shell: null,
  shellProcessPid: null,
  terminal: null,
  viteDevServer: null,
  cirrusReal: null,
  _cpRegistry: null,
  _viteShimPid: null,
  _viteShimPort: null,
  async _rpcStdout() {},
  async _rpcStderr() {},
  async serveSupervisorOp() { return null; },
  ensureFacetManager() {},
};
assumeGeneration(host.ctx, 1);

host.ensureSqliteFs();
const before = host.filesystem;
const shrunk = countShrinks(before.engine);
let release = await acquireHeavyAlloc();
release();
assert.equal(shrunk.shrinks, 1, 'an open filesystem\'s engine shrinks for a heavy allocation');

// A host bridge of the supervisor ops: a lease on the authority.
const leases = [];
const openHost = before.authority.openHost.bind(before.authority);
before.authority.openHost = (cred, options) => {
  const lease = openHost(cred, options);
  const record = { disposed: false };
  leases.push(record);
  return { fs: lease.fs, dispose: async () => { record.disposed = true; await lease.dispose(); } };
};
host.supervisorBridge = (pid) => host.filesystem.supervisorOps().bridge(pid);
host.supervisorBridge();
assert.equal(leases.length, 1, 'the supervisor ops hold a host lease');

const result = await rpcDestroy(host, { reason: 'test' });
assert.equal(result.ok, true);
assert.equal(host.filesystem, null, 'a destroy leaves no filesystem behind');
assert.deepEqual(leases.map((lease) => lease.disposed), [true], 'and released every host lease its supervisor ops held');
release = await acquireHeavyAlloc();
release();
assert.equal(shrunk.shrinks, 1, 'the destroyed engine is no longer subscribed to the allocation budget');

// The destroyed engine stays fenced by the destroy's lease; the session's
// filesystem is a new one, and writable.
assert.throws(() => before.authority.namespaceFs(CRED_KERNEL).writeFile('/after-destroy.txt', 'stale'), /EBUSY/);
const after = host.getFilesystemAuthority();
assert.notEqual(after, before.authority, 'the session answers from a new filesystem');
assert.equal(after.engine, host.sqliteFs, 'whose authority is over the session\'s engine');
after.namespaceFs(CRED_KERNEL).writeFile('/after-destroy.txt', 'fresh');
assert.equal(new TextDecoder().decode(host.sqliteFs.as(CRED_KERNEL).readFile('after-destroy.txt')), 'fresh');
await host.filesystem.close();

console.log('session-filesystem-lifecycle: ok');
