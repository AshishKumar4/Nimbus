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
