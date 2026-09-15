#!/usr/bin/env bun
// The session file plane can carry a credential.
//
// `SqliteVFS.as(cred)` has always given an in-process caller a view bound to
// an identity, but the pid-less file RPCs — the ones `box.files.*` and the
// embedder's own file plane reach — resolved to a fixed identity, so a
// credentialed file operation had to be smuggled through `exec`. Each of
// those RPCs now takes an optional `cred`, validated with the one VfsCred
// validator (`requireVfsCred`), and absent it keeps exactly the identity it
// has always had: the session user (uid 1000) for read, write, stat, list,
// mkdir, rename and chmod — see `callerCred` in session/rpc.ts — and the
// kernel for `files.delete` (`rpcDeleteFile`). Those defaults are the
// embedder's trusted surface and are asserted here unchanged.
//
// Fixture: a directory owned 0700 by uid 1001 holding a file owned 0600 by
// uid 1001. The session-user default and a stranger (uid 1002) get EACCES;
// the owner reads it; the kernel reads it; a write as the owner lands owned
// by the owner; a pid and a cred together are refused; a malformed cred is
// refused by the validator.

import assert from 'node:assert/strict';

import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import {
  _rpcExists,
  _rpcFsReadRange,
  _rpcMkdir,
  _rpcReadFile,
  _rpcReadFileBytes,
  _rpcReaddir,
  _rpcStat,
  _rpcWriteFile,
} from '../../packages/worker/src/session/rpc.ts';
import { rpcDeleteFile } from '../../packages/worker/src/session/programmatic.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './session-supervisor-ops.mjs';

const OWNER = Object.freeze({ uid: 1001, gid: 1001, groups: Object.freeze([1001]), umask: 0o022 });
const STRANGER = Object.freeze({ uid: 1002, gid: 1002, groups: Object.freeze([1002]), umask: 0o022 });

function makeHost() {
  const disk = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  kernel.mkdir('home/user/priv', { mode: 0o700 });
  kernel.chown('home/user/priv', OWNER.uid, OWNER.gid);
  kernel.writeFile('home/user/priv/secret.txt', 'owner eyes only', { mode: 0o600 });
  kernel.chown('home/user/priv/secret.txt', OWNER.uid, OWNER.gid);
  const st = kernel.stat('home/user/priv/secret.txt');
  assert.equal(st.uid, OWNER.uid, 'fixture: the file is owned by uid 1001');
  assert.equal(st.mode & 0o777, 0o600, 'fixture: mode 0600');
  const host = {
    sqliteFs: vfs,
    processes: new SessionProcessSupervisor(),
    ensureSqliteFs() {},
    ensureFacetManager() {},
    // rpcDeleteFile's ensureProgrammaticReady takes the already-booted path.
    shell: {},
    _w1SessionDestroyed: false,
  };
  return { host: attachSupervisorOps(host), vfs, kernel };
}

const eacces = async (promise, what) => {
  await assert.rejects(promise, (e) => {
    assert.ok(/EACCES/.test(e?.code ?? '') || /EACCES/.test(e?.message ?? ''), `${what}: expected EACCES, got ${e?.code ?? e?.message}`);
    return true;
  });
};

const SECRET = 'home/user/priv/secret.txt';

// ── reads: the default is the session user, and it is unchanged ───────────
{
  const { host } = makeHost();
  await eacces(_rpcReadFile(host, SECRET), 'the pid-less default (session user 1000) on a 0600 uid-1001 file');
  await eacces(_rpcReadFile(host, SECRET, undefined, STRANGER), 'as uid 1002');
  assert.equal(await _rpcReadFile(host, SECRET, undefined, OWNER), 'owner eyes only', 'as the owner');
  assert.equal(await _rpcReadFile(host, SECRET, undefined, CRED_KERNEL), 'owner eyes only', 'as the kernel');
  assert.equal(
    await _rpcReadFile(host, SECRET, undefined, CRED_SESSION_USER).catch((e) => e.code ?? e.message),
    await _rpcReadFile(host, SECRET).catch((e) => e.code ?? e.message),
    'naming the session user explicitly is the same as naming nothing',
  );

  // The same on every read-shaped sibling.
  await eacces(_rpcReadFileBytes(host, SECRET, undefined, STRANGER), 'readFileBytes as a stranger');
  assert.equal(new TextDecoder().decode(await _rpcReadFileBytes(host, SECRET, undefined, OWNER)), 'owner eyes only');
  await eacces(_rpcFsReadRange(host, SECRET, 0, 5, undefined, STRANGER), 'readRange as a stranger');
  assert.equal(new TextDecoder().decode(await _rpcFsReadRange(host, SECRET, 0, 5, undefined, OWNER)), 'owner');
  await eacces(_rpcReaddir(host, 'home/user/priv', undefined, STRANGER), 'readdir of a 0700 directory as a stranger');
  assert.deepEqual((await _rpcReaddir(host, 'home/user/priv', undefined, OWNER)).map((d) => d.name), ['secret.txt']);
  await eacces(_rpcStat(host, SECRET, undefined, STRANGER), 'stat through a 0700 directory as a stranger');
  assert.equal((await _rpcStat(host, SECRET, undefined, OWNER))?.uid, OWNER.uid);
  await eacces(_rpcExists(host, SECRET, undefined, STRANGER), 'exists through a 0700 directory as a stranger');
  assert.equal(await _rpcExists(host, SECRET, undefined, OWNER), true);
}

// ── writes land owned by the credential ───────────────────────────────────
{
  const { host, kernel } = makeHost();
  await eacces(_rpcWriteFile(host, 'home/user/priv/note.txt', 'x', undefined, STRANGER), 'write into a 0700 directory as a stranger');
  await eacces(_rpcWriteFile(host, 'home/user/priv/note.txt', 'x'), 'the session-user default cannot write there either');
  await _rpcWriteFile(host, 'home/user/priv/note.txt', 'mine', undefined, OWNER);
  const st = kernel.stat('home/user/priv/note.txt');
  assert.equal(st.uid, OWNER.uid, 'the file is owned by the credential that wrote it');
  await _rpcMkdir(host, 'home/user/priv/sub', undefined, OWNER);
  assert.equal(kernel.stat('home/user/priv/sub').uid, OWNER.uid, 'so is a directory it made');
  // The session-user default still owns what it writes where it can.
  await _rpcWriteFile(host, 'home/user/plain.txt', 'hello');
  assert.equal(kernel.stat('home/user/plain.txt').uid, CRED_SESSION_USER.uid, 'the default identity is unchanged');
}

// ── delete: the default is the kernel, and it is unchanged ────────────────
{
  const { host, kernel } = makeHost();
  await eacces(rpcDeleteFile(host, SECRET, {}, STRANGER), 'delete through a 0700 directory as a stranger');
  assert.equal(kernel.exists(SECRET), true, 'refused, so still there');
  await rpcDeleteFile(host, SECRET, {}, OWNER);
  assert.equal(kernel.exists(SECRET), false, 'the owner may delete it');

  kernel.writeFile('home/user/priv/again.txt', 'x', { mode: 0o600 });
  kernel.chown('home/user/priv/again.txt', OWNER.uid, OWNER.gid);
  await rpcDeleteFile(host, 'home/user/priv/again.txt');
  assert.equal(kernel.exists('home/user/priv/again.txt'), false, "the pid-less default (kernel) deletes it — today's behaviour");
  // Removing `priv` itself needs write on its parent, which uid 1000 owns:
  // the owner of the subtree is refused exactly as POSIX refuses it, and the
  // kernel default takes it out.
  await eacces(rpcDeleteFile(host, 'home/user/priv', { recursive: true }, OWNER), 'recursive removal of a directory in a parent the owner cannot write');
  assert.equal(kernel.exists('home/user/priv'), true);
  await rpcDeleteFile(host, 'home/user/priv', { recursive: true });
  assert.equal(kernel.exists('home/user/priv'), false, 'recursive removal by the kernel default');
}

// ── what is refused ───────────────────────────────────────────────────────
{
  const { host } = makeHost();
  const entry = host.processes.spawn('cat', [], '/home/user');
  await assert.rejects(
    _rpcReadFile(host, SECRET, entry.pid, CRED_KERNEL),
    /cred cannot ride a pid/,
    'a process cannot widen its identity by naming a credential',
  );
  await assert.rejects(
    _rpcReadFile(host, SECRET, undefined, { uid: 'root' }),
    /requires process credentials/,
    'a malformed credential is refused by the one VfsCred validator',
  );
  await assert.rejects(
    rpcDeleteFile(host, SECRET, {}, { uid: 1001 }),
    /requires process credentials/,
    'on delete too',
  );
}

console.log('PASS files-credential-bound-rpc');
