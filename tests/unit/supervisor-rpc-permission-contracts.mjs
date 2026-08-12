#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import * as rpc from '../../packages/worker/src/session/rpc.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

for (const name of ['_rpcAccess', '_rpcChown', '_rpcSetUmask']) {
  assert.equal(typeof rpc[name], 'function', `session RPC exports ${name}`);
}

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
};

await rpc._rpcAccess(host, '/user.txt', 0o4, user.pid);
await assert.rejects(
  rpc._rpcAccess(host, '/private/root.txt', 0o4, user.pid),
  (error) => error?.code === 'EACCES' && /^EACCES:/.test(error.message),
  'access preserves the VFS EACCES code and message prefix',
);
await assert.rejects(
  rpc._rpcAccess(host, '/missing.txt', 0o4, user.pid),
  (error) => error?.code === 'ENOENT' && /^ENOENT:/.test(error.message),
  'a missing path stays ENOENT rather than becoming a permission denial',
);

await rpc._rpcChown(host, '/user.txt', 1000, 1000, user.pid);
assert.deepEqual(
  { uid: kernel.stat('user.txt').uid, gid: kernel.stat('user.txt').gid },
  { uid: 1000, gid: 1000 },
  'the Linux owner-to-current-owner no-op allowance succeeds',
);
await assert.rejects(
  rpc._rpcChown(host, '/user.txt', 0, 0, user.pid),
  (error) => error?.code === 'EPERM' && /^EPERM:/.test(error.message),
  'a non-root ownership change fails with EPERM, not EACCES',
);
await rpc._rpcChown(host, '/user.txt', 0, 0, root.pid);
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
  () => rpc._rpcAccess(host, '/user.txt', 0, 0),
  () => rpc._rpcChown(host, '/user.txt', 0, 0, 0),
  () => rpc._rpcSetUmask(host, 0o022, 0),
  // umask is process state: a caller with no process has none to set.
  () => rpc._rpcSetUmask(host, 0o022),
]) {
  await assert.rejects(call, /process|pid/i, 'an invalid pid cannot infer kernel credentials');
}

// A pid-less host caller (the SDK, the remote /rpc dispatcher) acts as the
// unprivileged session user, so privileged operations stay denied.
await assert.rejects(
  rpc._rpcChown(host, '/user.txt', 0, 0),
  (error) => error?.code === 'EPERM',
  'a pid-less host caller cannot take ownership as root',
);

const supervisorSource = readFileSync(fileURLToPath(
  new URL('../../packages/worker/src/session/supervisor-rpc.ts', import.meta.url),
), 'utf8');
for (const [method, delegate] of [
  ['access', '_rpcAccess'],
  ['chown', '_rpcChown'],
  ['setUmask', '_rpcSetUmask'],
]) {
  const body = supervisorSource.match(new RegExp(`async ${method}\\([^]*?\\n  }`))?.[0] ?? '';
  assert.match(body, new RegExp(`${delegate}\\([^]*this\\._pid\\(\\)`),
    `SupervisorRPC.${method} forwards only its bound process pid`);
}

console.log('supervisor permission RPC contracts: ok');
