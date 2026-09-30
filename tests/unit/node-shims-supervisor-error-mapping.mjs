#!/usr/bin/env bun
// Behavior test: a failed supervisor operation reaches the program as a
// filesystem error it can branch on.
//
// The error crosses a workerd RPC hop. Both ends run with
// enhanced_error_serialization, so it arrives with the authority's own
// properties, `code` among them (lib/rpc-error.mjs models the hop). The shim
// keeps that code and fills in the syscall, path and errno from the call
// site. A failure with no code at all (the object was reset, the RPC
// disconnected) still reaches the program as a coded fs error, EIO,
// rather than an error no `err.code` arm matches.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { acrossRpc } from './lib/rpc-error.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { SHIMS_STORE_PRELUDE, declareNamespace, listAuthority } from './lib/shims-namespace.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// A supervisor whose calls fail exactly the way a real one does: the error
// arrives having crossed the RPC hop.
function facetWithFailure(failure) {
  const crossed = () => Promise.reject(acrossRpc(failure));
  const supervisor = {
    stat: crossed,
    lstat: crossed,
    readdir: crossed,
    mkdir: crossed,
    unlink: crossed,
    rename: crossed,
    writeFile: crossed,
    readFile: crossed,
    exists: crossed,
    access: crossed,
    fsReadRange: crossed,
    fsWriteRange: crossed,
    fsTruncate: crossed,
  };
  return new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
      '\n;return { fs: __fsMod };',
  )(
    {},
    {},
    supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user',
    [],
    {},
    '/home/user/main.mjs',
    '/home/user',
  ).fs;
}

async function rejection(promise) {
  try { await promise; }
  catch (error) { return error; }
  throw new Error('expected a rejection');
}

// ── the authority's code reaches the program ──────────────────────────────
for (const [code, errno] of [['ENOENT', -2], ['EACCES', -13], ['ENOTDIR', -20]]) {
  const fs = facetWithFailure(
    Object.assign(new Error(`${code}: stat '/home/user/gone.txt'`), { code, syscall: 'stat', path: '/home/user/gone.txt' }),
  );
  const error = await rejection(fs.promises.stat('/home/user/gone.txt'));
  assert.equal(error.code, code, `a ${code} from the authority is a ${code} in the program`);
  assert.equal(error.errno, errno, `errno matches ${code}`);
  assert.equal(error.syscall, 'stat', 'the syscall is filled in from the call site');
  assert.equal(error.path, '/home/user/gone.txt', 'the path is filled in from the call site');
  assert.equal(
    error.message,
    `${code}: ${{ ENOENT: 'no such file or directory', EACCES: 'permission denied', ENOTDIR: 'not a directory' }[code]}, stat '/home/user/gone.txt'`,
    "the message is node's",
  );
}

// ── a call naming two paths reports both, as Node 22 does ─────────────────
// fs.promises.rename of a missing name, against the real bridge, its error
// crossing the RPC hop: Node's message names both paths, and so does `dest`.
{
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = rawVfs.as(CRED_KERNEL);
  root.mkdir('home/user', { recursive: true });
  root.chown('home/user', 1000, 1000);
  root.writeFile('home/user/a.txt', 'a');
  root.writeFile('home/user/b.txt', 'b');
  const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
  const bridge = processBridge(rawVfs, user);
  const crossing = (run) => async (...args) => {
    try { return await run(...args); } catch (error) { throw acrossRpc(error); }
  };
  const supervisor = {
    stat: crossing((p) => bridge.stat(p)),
    lstat: crossing((p) => bridge.stat(p, { followSymlinks: false })),
    readdir: crossing((p) => bridge.readdir(p)),
    rename: crossing((from, to) => bridge.rename(from, to)),
    symlink: crossing((target, path) => bridge.symlink(target, path)),
    fsAcquire: crossing((epoch, cursor, options) => bridge.acquire(epoch, cursor, options)),
  };
  listAuthority(rawVfs);
  globalThis.__nimbusVfsCursor = { epoch: rawVfs.epoch, rev: rawVfs.revision() };
  declareNamespace({ metadata: { 'home/user': { type: 'directory', size: 0, mode: 0o40755, uid: 1000, gid: 1000 } } });
  const { fs } = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode() + '\n;return { fs: __fsMod };',
  )({}, {}, supervisor, user, '/home/user', [], {}, '/home/user/main.mjs', '/home/user');
  const error = await rejection(fs.promises.rename('/home/user/nope', '/home/user/new'));
  assert.deepEqual(
    [error.message, error.code, error.errno, error.syscall, error.path, error.dest],
    ["ENOENT: no such file or directory, rename '/home/user/nope' -> '/home/user/new'", 'ENOENT', -2, 'rename', '/home/user/nope', '/home/user/new'],
  );
  // symlink names its target, then the link.
  const taken = await rejection(fs.promises.symlink('relative-target', '/home/user/b.txt'));
  assert.deepEqual(
    [taken.message, taken.syscall, taken.path, taken.dest],
    ["EEXIST: file already exists, symlink 'relative-target' -> '/home/user/b.txt'", 'symlink', 'relative-target', '/home/user/b.txt'],
  );
  // copyFile's refusal to replace names its source, then its destination.
  let refused;
  try { fs.copyFileSync('/home/user/a.txt', '/home/user/b.txt', fs.constants.COPYFILE_EXCL); } catch (e) { refused = e; }
  assert.deepEqual(
    [refused?.message, refused?.syscall, refused?.path, refused?.dest],
    ["EEXIST: file already exists, copyfile '/home/user/a.txt' -> '/home/user/b.txt'", 'copyfile', '/home/user/a.txt', '/home/user/b.txt'],
  );
}

// ── an UNCODED failure still reaches the program as an fs error ───────────
// A supervisor can fail for reasons that have no errno spelling at all — the
// DO was evicted, the RPC was disconnected, a quota was hit.
for (const [label, failure] of [
  ['a disconnected RPC', new Error('The Durable Object was reset because its code was updated.')],
  ['an internal error', new Error('internal error')],
  ['an empty message', new Error('')],
  ['an unknown code', Object.assign(new Error('WEIRDCODE: not a real errno'), { code: 'WEIRDCODE' })],
  ['a thrown string', 'boom'],
]) {
  const fs = facetWithFailure(failure);
  const error = await rejection(fs.promises.stat('/home/user/thing.txt'));
  assert.equal(error.code, 'EIO', `${label} reaches the program as EIO`);
  assert.ok(
    Number.isInteger(error.errno) && error.errno < 0,
    `${label} carries a negative errno like every other fs error`,
  );
  assert.equal(error.syscall, 'stat', `${label} names the syscall that failed`);
  assert.equal(error.path, '/home/user/thing.txt', `${label} names the path`);
}

// ── the original failure text is not thrown away ──────────────────────────
// Classifying the error must not cost the operator the reason it failed.
{
  const fs = facetWithFailure(new Error('The Durable Object was reset because its code was updated.'));
  const error = await rejection(fs.promises.readFile('/home/user/thing.txt'));
  assert.match(
    error.message,
    /Durable Object was reset/,
    'the authority’s own words survive into the message',
  );
}

console.log('node-shims-supervisor-error-mapping: PASS');
