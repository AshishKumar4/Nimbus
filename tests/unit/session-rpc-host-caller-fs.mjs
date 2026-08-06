#!/usr/bin/env bun

// The SDK's `files.*` surface calls the session's filesystem RPCs with no pid
// (`_rpcReadFile(path)`) because a programmatic embedder is not a process.
// Those calls must work, must act as the unprivileged session user, and must
// never inherit kernel authority.

import assert from 'node:assert/strict';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/worker/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import {
  _rpcChmod,
  _rpcExists,
  _rpcFsReadRange,
  _rpcLstat,
  _rpcMkdir,
  _rpcReadFile,
  _rpcReaddir,
  _rpcReadFileBytes,
  _rpcRename,
  _rpcStat,
  _rpcWriteFile,
} from '../../packages/worker/src/session/rpc.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernelVfs = rawVfs.as(CRED_KERNEL);
// Session layout: /home/user belongs to the session user (seedFilesystem
// creates it with CRED_SESSION_USER), /private belongs to root alone.
kernelVfs.mkdir('home/user', { recursive: true });
kernelVfs.chown('home', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
kernelVfs.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
kernelVfs.mkdir('private', { recursive: true, mode: 0o700 });
kernelVfs.writeFile('private/root.txt', 'root secret', { mode: 0o600 });

const processes = new SessionProcessSupervisor();
const host = {
  sqliteFs: rawVfs,
  processes,
  ensureSqliteFs() {},
};

// ── the exact call shape @nimbus-sh/sdk uses ─────────────────────────────
await _rpcWriteFile(host, '/home/user/hello.txt', 'hi');
assert.equal(await _rpcReadFile(host, '/home/user/hello.txt'), 'hi');
assert.deepEqual(
  Array.from(await _rpcReadFileBytes(host, '/home/user/hello.txt')),
  [104, 105],
);
assert.equal(await _rpcExists(host, '/home/user/hello.txt'), true);
assert.equal(await _rpcExists(host, '/home/user/nope.txt'), false);

const stat = await _rpcStat(host, '/home/user/hello.txt');
assert.equal(stat.size, 2);
assert.equal(stat.type, 'file');

await _rpcMkdir(host, '/home/user/sub');
assert.ok((await _rpcReaddir(host, '/home/user')).some((e) => e.name === 'sub'));

await _rpcRename(host, '/home/user/hello.txt', '/home/user/sub/hello.txt');
assert.equal(await _rpcExists(host, '/home/user/hello.txt'), false);
await _rpcChmod(host, '/home/user/sub/hello.txt', 0o640);
assert.equal((await _rpcLstat(host, '/home/user/sub/hello.txt')).mode & 0o777, 0o640);
assert.deepEqual(
  Array.from(await _rpcFsReadRange(host, '/home/user/sub/hello.txt', 1, 1)),
  [105],
);

// ── the file is owned by the identity `exec` runs as, not by root ────────
const owned = kernelVfs.stat('home/user/sub/hello.txt');
assert.equal(owned.uid, CRED_SESSION_USER.uid, 'host-written files are owned by the session user');
assert.equal(owned.gid, CRED_SESSION_USER.gid);

// A process running as that same user can write what the host wrote.
const shellProcess = processes.spawn('sh', ['sh'], '/home/user');
await _rpcWriteFile(host, '/home/user/sub/hello.txt', 'from the process', shellProcess.pid);
assert.equal(await _rpcReadFile(host, '/home/user/sub/hello.txt'), 'from the process');

// ── and it is NOT the kernel ─────────────────────────────────────────────
await assert.rejects(
  _rpcReadFile(host, '/private/root.txt'),
  /EACCES/,
  'a pid-less host caller cannot read root-only files',
);

console.log('session RPC host-caller filesystem: ok');
