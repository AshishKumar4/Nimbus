#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import {
  _rpcFsClose,
  _rpcFsOpen,
  _rpcFsRead,
} from '../../packages/worker/src/session/rpc.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernelVfs = rawVfs.as(CRED_KERNEL);
kernelVfs.mkdir('private', { recursive: true, mode: 0o700 });
kernelVfs.writeFile('private/root.txt', 'root secret', { mode: 0o600 });
kernelVfs.writeFile('public.txt', 'public', { mode: 0o644 });

const processes = new SessionProcessSupervisor();
const user = processes.spawn('node', ['user.js'], '/home/user');
const root = processes.spawn('node', ['root.js'], '/root', { cred: CRED_KERNEL });
const host = {
  sqliteFs: rawVfs,
  processes,
  ensureSqliteFs() {},
};

const rootSecret = await _rpcFsOpen(host, '/private/root.txt', { read: true }, root.pid);
assert.equal(
  new TextDecoder().decode(await _rpcFsRead(host, rootSecret.id, 0, 64, root.pid)),
  'root secret',
);

await assert.rejects(
  _rpcFsOpen(host, '/private/root.txt', { read: true }, user.pid),
  /EACCES/,
  'filesystem RPCs act with the supervisor-assigned process credential',
);

const rootPublic = await _rpcFsOpen(host, '/public.txt', { read: true }, root.pid);
await assert.rejects(
  _rpcFsRead(host, rootPublic.id, 0, 1, user.pid),
  /EBADF/,
  'file-handle maps are isolated per process',
);

kernelVfs.mkdir('created', { mode: 0o777 });
kernelVfs.chmod('created', 0o777);
processes.setUmask(user.pid, 0o077);
const masked = await _rpcFsOpen(
  host,
  '/created/masked.txt',
  { create: true, write: true },
  user.pid,
);
await _rpcFsClose(host, masked.id, user.pid);
assert.equal(
  kernelVfs.stat('created/masked.txt').mode & 0o777,
  0o600,
  'an existing per-process bridge observes later umask changes without losing its handle table',
);

await assert.rejects(
  _rpcFsOpen(host, '/private/root.txt', { read: true }, 0),
  /process|pid/i,
  'pid zero cannot infer CRED_KERNEL',
);
await assert.rejects(
  _rpcFsOpen(host, '/private/root.txt', { read: true }),
  /EACCES/,
  'a pid-less host caller acts as the unprivileged session user, never as the kernel',
);

console.log('session RPC process filesystem isolation: ok');
