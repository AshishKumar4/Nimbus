#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mock } from 'bun:test';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import * as rpc from '../../packages/worker/src/session/rpc.ts';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  },
}));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
kernel.mkdir('private', { mode: 0o700 });
kernel.writeFile('private/root.txt', 'secret', { mode: 0o600 });
kernel.writeFile('user.txt', 'owned', { mode: 0o640 });
kernel.chown('user.txt', 1000, 1000);

const processes = new SessionProcessSupervisor();
const user = processes.spawn('node', ['user.js'], '/home/user');
const other = processes.spawn('node', ['other.js'], '/home/user', {
  cred: { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 },
});
const root = processes.spawn('node', ['root.js'], '/root', { cred: CRED_KERNEL });
const host = {
  sqliteFs: rawVfs,
  processes,
  ensureSqliteFs() {},
  _rpcSetUmask: (mask, pid) => rpc._rpcSetUmask(host, mask, pid),
};

const ops = buildSessionSupervisorOps(host);
host.supervisorBridge = (p) => ops.bridge(p);
function bound(pid) {
  const namespace = {
    idFromName: (id) => ({ toString: () => id }),
    idFromString: (id) => ({ toString: () => id }),
    get: () => ({ supervisorOp: (envelope) => ops.dispatch(envelope) }),
  };
  return new SupervisorRPC({ props: { doId: 'session', pid, writerId: 'permission-run' } }, { NIMBUS_SESSION: namespace });
}

await bound(user.pid).access('/user.txt', 0o4);
await assert.rejects(
  bound(user.pid).access('/private/root.txt', 0o4),
  (error) => error?.code === 'EACCES' && /^EACCES:/.test(error.message),
  'access preserves the VFS EACCES code and message prefix',
);
await assert.rejects(
  bound(user.pid).access('/missing.txt', 0o4),
  (error) => error?.code === 'ENOENT' && /^ENOENT:/.test(error.message),
  'a missing path stays ENOENT rather than becoming a permission denial',
);

await bound(user.pid).chown('/user.txt', 1000, 1000);
assert.deepEqual(
  { uid: kernel.stat('user.txt').uid, gid: kernel.stat('user.txt').gid },
  { uid: 1000, gid: 1000 },
  'the Linux owner-to-current-owner no-op allowance succeeds',
);
await assert.rejects(
  bound(user.pid).chown('/user.txt', 0, 0),
  (error) => error?.code === 'EPERM' && /^EPERM:/.test(error.message),
  'a non-root ownership change fails with EPERM, not EACCES',
);
await bound(root.pid).chown('/user.txt', 0, 0);
assert.deepEqual(
  { uid: kernel.stat('user.txt').uid, gid: kernel.stat('user.txt').gid },
  { uid: 0, gid: 0 },
  'the supervisor-assigned root process may change stored ownership',
);

assert.equal(processes.cred(other.pid).umask, 0o022);
const previous = await rpc._rpcSetUmask(host, 0o077, user.pid);
assert.equal(previous, 0o022, 'setUmask returns the invoking process previous mask');
assert.equal(processes.cred(user.pid).umask, 0o077);
assert.equal(processes.cred(other.pid).umask, 0o022, 'umask changes are process-local');

for (const call of [
  () => bound(0).access('/user.txt', 0),
  () => bound(0).chown('/user.txt', 0, 0),
  () => rpc._rpcSetUmask(host, 0o022, 0),
  // umask is process state: a caller with no process has none to set.
  () => rpc._rpcSetUmask(host, 0o022),
]) {
  await assert.rejects(call, /process|pid/i, 'an invalid pid cannot infer kernel credentials');
}

// A facet without a bound process cannot infer kernel credentials.
await assert.rejects(
  bound(undefined).chown('/user.txt', 0, 0),
  /process|pid/i,
  'a pid-less facet cannot take ownership as root',
);

// A supplied pid cannot elevate the binding's principal or mutate another process.
{
  const facet = bound(user.pid);
  await assert.rejects(facet.access('/private/root.txt', 0o4, root.pid), (error) => error.code === 'EACCES');
  await assert.rejects(facet.chown('/user.txt', 0, 0, { followSymlinks: true, pid: root.pid }), (error) => error.code === 'EPERM');
  const rootMask = processes.cred(root.pid).umask;
  await facet.setUmask(0o027, root.pid);
  assert.equal(processes.cred(user.pid).umask, 0o027);
  assert.equal(processes.cred(root.pid).umask, rootMask);
}

console.log('supervisor permission RPC contracts: ok');
