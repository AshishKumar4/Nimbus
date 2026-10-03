#!/usr/bin/env bun
// A filesystem error's message is Node's (Kinu, ASK-mounts item 11):
// `ENOENT: no such file or directory, open 'x'`: the code, libuv's words,
// the syscall, the path quoted after a space (not a comma), and
// `-> 'dest'` for a call that names two paths. Code, errno, path, syscall
// and cause stay structured. Every layer that makes one says which call it
// is: the constructor, the namespace (whose refusals are made before it
// knows the call), a mounted backend, and the engine's errors as the SQLite
// backend converts them. A hosted node program's fs errors, across the RPC
// hop, are node-shims-supervisor-error-mapping's.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { CompositeVFS, isAsyncMountRefusal } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import * as vfsErrors from '../../packages/core/src/vfs/vfs-error.ts';
import { NimbusFlueApi } from '../../packages/sdk/src/flue.ts';
import { ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const { VfsError, VFS_DESCRIPTION, syscallError, toVfsError } = vfsErrors;
const bytes = (text) => new TextEncoder().encode(text);

async function failure(run) {
  try { await run(); } catch (error) { return error; }
  throw new Error('expected a failure');
}

function failureSync(run) {
  try { run(); } catch (error) { return error; }
  throw new Error('expected a failure');
}

// ── The constructor: Kinu's repro, exactly ─────────────────────────────────
{
  const error = new VfsError('ENOENT', 'no such file or directory, open', 'probe-fixture.txt');
  assert.equal(error.message, "ENOENT: no such file or directory, open 'probe-fixture.txt'");
  assert.deepEqual([error.code, error.errno, error.path], ['ENOENT', -2, 'probe-fixture.txt']);
  assert.equal(new VfsError('EIO', 'backend down').message, 'EIO: backend down', 'no path, no quote');
}

// ── libuv's words for every code, as node's util.getSystemErrorMap() has them ──
{
  const node = {
    E2BIG: 'argument list too long', EPERM: 'operation not permitted', ENOENT: 'no such file or directory',
    EIO: 'i/o error', ENXIO: 'no such device or address', EAGAIN: 'resource temporarily unavailable',
    EACCES: 'permission denied', EBUSY: 'resource busy or locked', EEXIST: 'file already exists',
    EXDEV: 'cross-device link not permitted', ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory',
    EINVAL: 'invalid argument', ENOSPC: 'no space left on device', EROFS: 'read-only file system',
    ELOOP: 'too many symbolic links encountered', ENAMETOOLONG: 'name too long', ENOTEMPTY: 'directory not empty',
    ENOTSUP: 'operation not supported on socket',
  };
  for (const [code, words] of Object.entries(node)) {
    assert.equal(VFS_DESCRIPTION[code], words, code);
    assert.equal(syscallError(code, 'open', '/x').message, `${code}: ${words}, open '/x'`);
  }
  const moved = syscallError('ENOENT', 'rename', '/nope', { dest: '/nope2' });
  assert.equal(moved.message, "ENOENT: no such file or directory, rename '/nope' -> '/nope2'", "node's rename message");
  assert.deepEqual([moved.syscall, moved.path, moved.dest], ['rename', '/nope', '/nope2']);
}

// ── The namespace: each call names its syscall and the caller's path ───────
{
  const vfs = new CompositeVFS(new MemoryVFS());
  vfs.mount('/m', new MemoryVFS());
  vfs.mount('/ro', new MemoryVFS(), { readOnly: true });
  vfs.mount('/async', () => ({ stat: async () => null, readFile: async () => bytes('') }));
  await vfs.writeFile('/m/f', bytes('f'));
  await vfs.mkdir('/d');

  const cases = [
    ['readFile', () => vfs.readFile('/d/nope'), "ENOENT: no such file or directory, open '/d/nope'"],
    ['readFile through a file', () => vfs.readFile('/m/f/x'), "ENOTDIR: not a directory, open '/m/f/x'"],
    ['readFile of a mount point', () => vfs.readFile('/m'), "EISDIR: illegal operation on a directory, open '/m'"],
    ['readdir', () => vfs.readdir('/nope/x'), "ENOENT: no such file or directory, scandir '/nope/x'"],
    ['writeFile on a read-only mount', () => vfs.writeFile('/ro/a', bytes('a')), "EROFS: /ro is mounted read-only, open '/ro/a'"],
    ['rename across mounts', () => vfs.rename('/m/f', '/d/f'),
      "EXDEV: /m and / are different filesystems, rename '/m/f' -> '/d/f'"],
    ['unlink of a mount point', () => vfs.unlink('/m'), "EISDIR: illegal operation on a directory, unlink '/m'"],
    ['rmdir of a mount point', () => vfs.rmdir('/m'), "EBUSY: a mount point cannot be removed, rmdir '/m'"],
    ['copy of a missing file', () => vfs.copy('/m/nope', '/m/g'), "ENOENT: no such file or directory, copyfile '/m/nope' -> '/m/g'"],
    ['realpath', () => vfs.realpathAsync('/m/nope'), "ENOENT: no such file or directory, realpath '/m/nope'"],
    ['mkdir on a mount point', () => vfs.mkdir('/m'), "EBUSY: a mount point cannot be created, mkdir '/m'"],
  ];
  for (const [label, run, message] of cases) {
    const error = await failure(run);
    assert.ok(error instanceof VfsError, `${label}: ${error}`);
    assert.equal(error.message, message, label);
    assert.equal(error.errno, { ENOENT: -2, ENOTDIR: -20, EISDIR: -21, EROFS: -30, EXDEV: -18, EBUSY: -16 }[error.code], label);
  }
  // A backend's own error is reported for the caller's call: the mounted
  // MemoryVFS was given '/nope' and '/g', and the caller named the mount's.
  const missing = await failure(() => vfs.rename('/m/nope', '/m/g'));
  assert.equal(missing.message, "ENOENT: no such file or directory, rename '/m/nope' -> '/m/g'");

  // The synchronous face says the same, and an async mount's refusal is still one.
  assert.equal(failureSync(() => vfs.sync.readFile('/d/nope')).message, "ENOENT: no such file or directory, open '/d/nope'");
  const refused = failureSync(() => vfs.sync.readFile('/async/a'));
  assert.equal(refused.message, "EAGAIN: /async is an asynchronous mount; this caller cannot wait for it, open '/async/a'");
  assert.equal(refused.syscall, 'open');
  assert.ok(isAsyncMountRefusal(refused), 'a caller that can wait still recognizes the refusal');
  assert.equal(failureSync(() => vfs.mount('/m', new MemoryVFS())).message, "EBUSY: something is already mounted there, mount '/m'");
}

// ── The SQLite backend: the engine's errors, as the call that met them ─────
{
  const harness = createSqliteVfsTestHarness();
  const files = sqliteFiles(new SqliteVFS(harness.sql, harness.ctx), CRED_KERNEL);
  files.mkdir('/home');
  files.writeFile('/home/a', bytes('a'));
  const cases = [
    [() => files.readFile('/home/nope'), "ENOENT: no such file or directory, open '/home/nope'", 'open'],
    [() => files.readdir('/home/a'), "ENOTDIR: not a directory, scandir '/home/a'", 'scandir'],
    [() => files.rename('/home/nope', '/home/b'), "ENOENT: no such file or directory, rename '/home/nope' -> '/home/b'", 'rename'],
    [() => files.rmdir('/home'), "ENOTEMPTY: directory not empty, rmdir '/home'", 'rmdir'],
  ];
  for (const [run, message, syscall] of cases) {
    const error = failureSync(run);
    assert.equal(error.message, message);
    assert.equal(error.syscall, syscall);
    assert.ok(error.cause instanceof Error, 'the engine error is the cause');
  }
  // mkdir(2)'s EEXIST, which the backend decides itself.
  assert.equal(failureSync(() => files.mkdir('/home')).message, "EEXIST: file already exists, mkdir '/home'");
}

// ── symlink names its target, then the link, as Node 22 does ──────────────
{
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  raw.as(CRED_KERNEL).mkdir('home', { recursive: true });
  raw.as(CRED_KERNEL).writeFile('home/taken', 'x');
  const view = new ProcessView(processBridge(raw, CRED_KERNEL));
  const error = await failure(() => view.symlink('relative-target', '/home/taken'));
  assert.deepEqual(
    [error.message, error.code, error.syscall, error.path, error.dest],
    ["EEXIST: file already exists, symlink 'relative-target' -> '/home/taken'", 'EEXIST', 'symlink', 'relative-target', '/home/taken'],
  );
  // Every call naming two paths reports both as its caller gave them,
  // whichever one's lookup failed (Node 22's messages, verbatim).
  const cases = [
    [() => view.rename('/home/taken', '/home/nope/b'), 'ENOENT', "no such file or directory, rename '/home/taken' -> '/home/nope/b'"],
    [() => view.rename('/home/taken', '/home/taken/b'), 'ENOTDIR', "not a directory, rename '/home/taken' -> '/home/taken/b'"],
    [() => view.copy('/home/nope', '/home/b'), 'ENOENT', "no such file or directory, copyfile '/home/nope' -> '/home/b'"],
    [() => view.copy('/home/taken', '/home/nope/b'), 'ENOENT', "no such file or directory, copyfile '/home/taken' -> '/home/nope/b'"],
    [() => view.symlink('t', '/home/nope/b'), 'ENOENT', "no such file or directory, symlink 't' -> '/home/nope/b'"],
  ];
  for (const [run, code, words] of cases) {
    const refused = await failure(run);
    assert.equal(refused.message, `${code}: ${words}`);
    assert.equal(refused.code, code);
  }
  const moved = await failure(() => view.rename('/home/taken', '/home/nope/b'));
  assert.deepEqual([moved.syscall, moved.path, moved.dest], ['rename', '/home/taken', '/home/nope/b']);
}

// ── A conversion: a coded error, and a VfsError that named no call ─────────
{
  const bridge = Object.assign(new Error('EACCES: stat'), { code: 'EACCES', syscall: 'stat', path: '/home/x' });
  assert.equal(toVfsError(bridge, 'open', '/other').message, "EACCES: permission denied, stat '/home/x'", "a bridge error's own call and path");
  const quota = new VfsError('ENOSPC', '5 bytes would exceed the 1 GB storage of this session');
  const reported = toVfsError(quota, 'open', '/home/big');
  assert.equal(reported.message, "ENOSPC: 5 bytes would exceed the 1 GB storage of this session, open '/home/big'");
  assert.equal(reported.cause, quota);
  const named = new VfsError('ENOENT', 'no such file or directory, open', 'x');
  assert.equal(toVfsError(named, 'stat', '/y'), named, 'an error that names its path is kept as it is');
  // Node 22's own rename error keeps its destination; the caller's is a fallback for its own call only.
  const node = Object.assign(new Error("ENOENT: no such file or directory, rename '/home/nope' -> '/home/new'"),
    { code: 'ENOENT', errno: -2, syscall: 'rename', path: '/home/nope', dest: '/home/new' });
  const kept = toVfsError(node, 'rename', '/home/nope');
  assert.deepEqual([kept.message, kept.syscall, kept.path, kept.dest], [node.message, 'rename', '/home/nope', '/home/new']);
  const bridged = toVfsError(Object.assign(new Error('ENOENT: rename'), { code: 'ENOENT', syscall: 'rename', path: '/a' }), 'rename', '/a', '/b');
  assert.equal(bridged.message, "ENOENT: no such file or directory, rename '/a' -> '/b'");
  const inner = toVfsError(Object.assign(new Error('ENOENT: lstat'), { code: 'ENOENT', syscall: 'lstat', path: '/a' }), 'rename', '/a', '/b');
  assert.deepEqual([inner.message, inner.dest], ["ENOENT: no such file or directory, lstat '/a'", undefined]);
  for (const code of ['constructor', 'toString', '__proto__', 'ENOTREAL']) {
    const unsupported = Object.assign(new Error('outside the VFS codes'), { code });
    assert.equal(toVfsError(unsupported, 'open', '/x'), unsupported);
  }
}

// ── The SDK's Flue adapter: a missing file is node's ENOENT too ────────────
{
  const flue = new NimbusFlueApi({ files: { read: async () => null, readBytes: async () => null, stat: async () => null } });
  const read = await failure(() => flue.readFile('/home/user/nope'));
  assert.equal(read.message, "ENOENT: no such file or directory, open '/home/user/nope'");
  assert.deepEqual([read.code, read.errno, read.syscall, read.path], ['ENOENT', -2, 'open', '/home/user/nope']);
  assert.equal((await failure(() => flue.stat('/home/user/nope'))).message, "ENOENT: no such file or directory, stat '/home/user/nope'");
}

console.log('vfs-error-node-shape: ok');
