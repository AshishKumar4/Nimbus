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
//
// The failing call is a read of a file the namespace holds and the process
// has not fetched: the namespace answers stat and existence itself, so the
// read is the call the session is asked, and it is the one that fails.

import assert from 'node:assert/strict';
import { acrossRpc } from './lib/rpc-error.mjs';
import { createAuthority, runScenarios } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const THING = '/home/user/thing.txt';

/** The program's file, which the session fails each read of with `failure`, as the RPC hop delivers it. */
function readsFailing(failure) {
  const authority = createAuthority();
  authority.kfs.writeFile(THING, 'thing');
  const crossed = () => Promise.reject(acrossRpc(failure));
  const { fs } = shimsOnSession({
    authority,
    overrides: { readFile: crossed, readFileBytes: crossed, fsReadBatch: crossed, fsReadRange: crossed },
  });
  return fs;
}

async function rejection(promise) {
  try { await promise; }
  catch (error) { return error; }
  throw new Error('expected a rejection');
}

const scenarios = {};

// ── the authority's code reaches the program ──────────────────────────────
for (const [code, errno, text] of [['ENOENT', -2, 'no such file or directory'], ['EACCES', -13, 'permission denied'], ['ENOTDIR', -20, 'not a directory']]) {
  scenarios[`the authority's ${code} is a ${code} in the program`] = async () => {
    const fs = readsFailing(Object.assign(new Error(`${code}: ${text}, open '${THING}'`), { code, syscall: 'open', path: THING }));
    const error = await rejection(fs.promises.readFile(THING));
    assert.equal(error.code, code, `a ${code} from the authority is a ${code} in the program`);
    assert.equal(error.errno, errno, `errno matches ${code}`);
    assert.equal(error.syscall, 'open', 'the syscall is filled in from the call site');
    assert.equal(error.path, THING, 'the path is filled in from the call site');
    assert.equal(error.message, `${code}: ${text}, open '${THING}'`, "the message is node's");
  };
}

// ── a call naming two paths reports both, as Node 22 does ─────────────────
scenarios['a call naming two paths reports both, as Node 22 does'] = async () => {
  const authority = createAuthority();
  authority.kfs.writeFile('/home/user/a.txt', 'a');
  authority.kfs.writeFile('/home/user/b.txt', 'b');
  const { fs } = shimsOnSession({ authority });
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
  // Every call naming two paths reports both as the program gave them,
  // whichever one's check failed (Node 22's messages, verbatim).
  const sync = (run) => { try { run(); } catch (e) { return e; } throw new Error('expected a failure'); };
  for (const [label, error, words, path, dest] of [
    ['renameSync', sync(() => fs.renameSync('/home/user/a.txt', '/home/user/nope/b')),
      "ENOENT: no such file or directory, rename '/home/user/a.txt' -> '/home/user/nope/b'", '/home/user/a.txt', '/home/user/nope/b'],
    ['fs.promises.rename', await rejection(fs.promises.rename('/home/user/a.txt', '/home/user/nope/b')),
      "ENOENT: no such file or directory, rename '/home/user/a.txt' -> '/home/user/nope/b'", '/home/user/a.txt', '/home/user/nope/b'],
    ['copyFileSync of a missing source', sync(() => fs.copyFileSync('/home/user/nope', '/home/user/c.txt')),
      "ENOENT: no such file or directory, copyfile '/home/user/nope' -> '/home/user/c.txt'", '/home/user/nope', '/home/user/c.txt'],
    ['fs.promises.copyFile into a missing directory', await rejection(fs.promises.copyFile('/home/user/a.txt', '/home/user/nope/c.txt')),
      "ENOENT: no such file or directory, copyfile '/home/user/a.txt' -> '/home/user/nope/c.txt'", '/home/user/a.txt', '/home/user/nope/c.txt'],
    ['linkSync', sync(() => fs.linkSync('/home/user/a.txt', '/home/user/l')),
      "ENOSYS: function not implemented, link '/home/user/a.txt' -> '/home/user/l'", '/home/user/a.txt', '/home/user/l'],
  ]) {
    assert.deepEqual([error.message, error.path, error.dest], [words, path, dest], label);
  }
  // copyFile's refusal to replace names its source, then its destination.
  let refused;
  try { fs.copyFileSync('/home/user/a.txt', '/home/user/b.txt', fs.constants.COPYFILE_EXCL); } catch (e) { refused = e; }
  assert.deepEqual(
    [refused?.message, refused?.syscall, refused?.path, refused?.dest],
    ["EEXIST: file already exists, copyfile '/home/user/a.txt' -> '/home/user/b.txt'", 'copyfile', '/home/user/a.txt', '/home/user/b.txt'],
  );
};

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
  scenarios[`${label} reaches the program as EIO`] = async () => {
    const fs = readsFailing(failure);
    const error = await rejection(fs.promises.readFile(THING));
    assert.equal(error.code, 'EIO', `${label} reaches the program as EIO`);
    assert.ok(
      Number.isInteger(error.errno) && error.errno < 0,
      `${label} carries a negative errno like every other fs error`,
    );
    assert.equal(error.syscall, 'open', `${label} names the syscall that failed`);
    assert.equal(error.path, THING, `${label} names the path`);
  };
}

// ── the original failure text is not thrown away ──────────────────────────
// Classifying the error must not cost the operator the reason it failed.
scenarios['the authority’s own words survive into the message'] = async () => {
  const fs = readsFailing(new Error('The Durable Object was reset because its code was updated.'));
  const error = await rejection(fs.promises.readFile(THING));
  assert.match(
    error.message,
    /Durable Object was reset/,
    'the authority’s own words survive into the message',
  );
};

await runScenarios(import.meta.path, scenarios);
