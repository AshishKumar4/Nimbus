#!/usr/bin/env bun
// Behavior test: a failed supervisor operation reaches the program as a
// filesystem error it can branch on.
//
// Errors do not survive the DO RPC boundary intact. Structured clone carries
// an Error's name, message and stack and DROPS every own property, so the
// `code`, `syscall`, `path` and `errno` the authority set are gone by the time
// the facet catches them. (Asserted below, so this premise is checked rather
// than assumed.) _mapSupervisorError's first branch — "the error already has a
// code, keep it" — therefore never fires for a real RPC failure, and every
// filesystem error a program sees is reconstructed from the message string.
//
// RED on the pre-fix build: when the message did not begin with a recognised
// CODE:, the error was returned UNCHANGED — no code, no syscall, no path. A
// program branching on err.code gets undefined and takes NEITHER arm, which is
// how an I/O failure becomes a silent hang instead of an error.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/worker/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

// ── the premise: what actually survives the boundary ───────────────────────
{
  const authored = Object.assign(new Error("ENOENT: truncate '/x/y.log'"), {
    code: 'ENOENT', syscall: 'truncate', path: '/x/y.log', errno: -2,
  });
  const crossed = structuredClone(authored);
  assert.equal(crossed.message, "ENOENT: truncate '/x/y.log'", 'the message survives');
  assert.deepEqual(
    [crossed.code, crossed.syscall, crossed.path, crossed.errno],
    [undefined, undefined, undefined, undefined],
    'code/syscall/path/errno are dropped crossing the boundary',
  );
}

// A supervisor whose calls fail exactly the way a real one does: the error
// arrives having been through structured clone.
function facetWithFailure(failure) {
  const crossed = () => Promise.reject(structuredClone(failure));
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
    '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
    'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
      '\n;return { fs: __fsMod };',
  )(
    {},
    { 'home/user': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } },
    {}, { home: ['user'], 'home/user': [] }, supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  ).fs;
}

async function rejection(promise) {
  try { await promise; }
  catch (error) { return error; }
  throw new Error('expected a rejection');
}

// ── a recognisable authority error still maps to its code ─────────────────
// The behaviour the whole shim already depends on; it must not regress.
{
  const fs = facetWithFailure(
    Object.assign(new Error("ENOENT: stat '/home/user/gone.txt'"), { code: 'ENOENT' }),
  );
  const error = await rejection(fs.promises.stat('/home/user/gone.txt'));
  assert.equal(error.code, 'ENOENT', 'an ENOENT from the authority is still an ENOENT');
  assert.equal(error.syscall, 'stat', 'the syscall is filled in from the call site');
  assert.equal(error.path, '/home/user/gone.txt', 'the path is filled in from the call site');
  assert.equal(error.errno, -2, 'errno matches the code');
}

// ── an UNRECOGNISABLE failure still reaches the program as an fs error ────
// This is the one that was silent. A supervisor can fail for reasons that have
// no errno spelling at all — the DO was evicted, the RPC was disconnected, a
// quota was hit. None of those messages begin with a code.
for (const [label, failure] of [
  ['a disconnected RPC', new Error('The Durable Object was reset because its code was updated.')],
  ['an internal error', new Error('internal error')],
  ['an empty message', new Error('')],
  ['a lowercase code-lookalike', new Error('enoent: not really a code')],
  ['an unknown uppercase token', new Error('WEIRDCODE: not a real errno')],
]) {
  const fs = facetWithFailure(failure);
  const error = await rejection(fs.promises.stat('/home/user/thing.txt'));
  assert.equal(
    typeof error.code, 'string',
    `${label} reaches the program with a code it can branch on`,
  );
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

// ── a non-Error rejection is still classified ─────────────────────────────
{
  const fs = facetWithFailure(new Error('x'));
  const error = await rejection(fs.promises.mkdir('/home/user/d'));
  assert.equal(typeof error.code, 'string', 'even a bare failure is a coded fs error');
}

console.log('node-shims-supervisor-error-mapping: PASS');
