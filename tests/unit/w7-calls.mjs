#!/usr/bin/env bun
/**
 * w7-calls — a process's filesystem calls as W7 records (W7Call): each is
 * applied by the session's operation of that name, with its semantics and
 * its refusal, in program order. Differential: the same calls made one by
 * one through the engine's own API leave the same tree, and refuse at the
 * same call with the same errno; a refusal stops the wave with every call
 * before it committed (committedOps) and none after.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { decodeWriteBatchStream, encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const USER = { ...CRED_SESSION_USER, umask: 0o027 };

function engine() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', USER.uid, USER.gid);
  const user = raw.as(USER);
  // What each case starts from.
  user.mkdir('home/user/d', { mode: 0o755 });
  user.writeFile('home/user/kept', 'old');
  user.chmod('home/user/kept', 0o600);
  user.writeFile('home/user/target', 't');
  user.symlink('target', 'home/user/link');
  kernel.mkdir('home/locked', { mode: 0o755 });
  return { raw, kernel, user };
}

/** The calls one by one, as the engine's API makes them: the index of the first refusal and its errno. */
function oneByOne(user, calls) {
  for (const [index, call] of calls.entries()) {
    try {
      switch (call.call) {
        case 'writeFile': user.writeFile(call.path, call.data, { mode: call.mode }); break;
        case 'appendFile': {
          const prior = user.exists(call.path) ? user.readFile(call.path) : null;
          if (prior === null) user.writeFile(call.path, call.data, { mode: call.mode });
          else user.writeRange(call.path, prior.byteLength, call.data);
          break;
        }
        case 'mkdir': user.mkdir(call.path, { mode: call.mode }); break;
        case 'unlink': user.unlink(call.path); break;
        case 'rmdir': user.rmdir(call.path); break;
        case 'symlink': user.symlink(call.target, call.path); break;
      }
    } catch (error) {
      return { refusedAt: index, errno: error.code };
    }
  }
  return { refusedAt: null, errno: null };
}

/** Every name under home with what stat and readlink/readFile say of it. */
function tree(user) {
  const out = {};
  const walk = (dir) => {
    for (const { name } of user.readdir(dir)) {
      const path = `${dir}/${name}`;
      const stat = user.lstat(path);
      const entry = { type: stat.type, mode: (stat.mode & 0o7777).toString(8), uid: stat.uid, gid: stat.gid, ino: stat.ino, size: stat.size };
      if (stat.type === 'file') entry.text = new TextDecoder().decode(user.readFile(path));
      if (stat.type === 'symlink') entry.target = user.readlink(path);
      out[path] = entry;
      if (stat.type === 'directory') walk(path);
    }
  };
  walk('home/user');
  return out;
}

async function asWave(calls) {
  const { raw, user } = engine();
  const result = await user.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops: calls.map((call) => ({ type: 'call', call })) }));
  return { result, tree: tree(user), raw };
}

async function differential(label, calls) {
  const reference = engine();
  const expected = oneByOne(reference.user, calls);
  const { result, tree: waveTree } = await asWave(calls);
  const refTree = tree(reference.user);
  // Inode numbers are each engine's own; compare which names share them, not the numbers.
  const strip = (t) => Object.fromEntries(Object.entries(t).map(([path, { ino: _ino, ...rest }]) => [path, rest]));
  assert.deepEqual(strip(waveTree), strip(refTree), `${label}: the wave left another tree than the calls`);
  if (expected.refusedAt === null) {
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.error)}`);
    assert.equal(result.committedOps, calls.length);
  } else {
    assert.equal(result.ok, false, `${label}: the wave took what call ${expected.refusedAt} refuses`);
    assert.equal(result.committedOps, expected.refusedAt, `${label}: committedOps names another call than the refused one`);
    assert.equal(result.error.errno, expected.errno, `${label}: ${result.error.message}`);
  }
  return result;
}

// ── Each call alone: semantics the bulk upserts did not have ─────────────
await differential('writeFile creates, less the umask', [{ call: 'writeFile', path: 'home/user/new', mode: 0o666, data: enc.encode('n') }]);
{
  // An existing file keeps its mode, owner and inode: only its bytes change.
  const { user } = engine();
  const before = user.lstat('home/user/kept');
  const result = await user.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops: [{ type: 'call', call: { call: 'writeFile', path: 'home/user/kept', mode: 0o666, data: enc.encode('new bytes') } }] }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const after = user.lstat('home/user/kept');
  assert.equal(after.mode & 0o7777, 0o600, 'an existing file keeps its mode');
  assert.equal(after.ino, before.ino, 'an existing file keeps its inode');
  assert.equal([after.uid, after.gid].join(':'), [before.uid, before.gid].join(':'));
  assert.equal(new TextDecoder().decode(user.readFile('home/user/kept')), 'new bytes');
}
await differential('writeFile through a link writes its target', [{ call: 'writeFile', path: 'home/user/link', mode: 0o666, data: enc.encode('via link') }]);
await differential('writeFile on a directory is EISDIR', [{ call: 'writeFile', path: 'home/user/d', mode: 0o666, data: enc.encode('x') }]);
await differential('writeFile in a missing directory is ENOENT', [{ call: 'writeFile', path: 'home/user/nope/f', mode: 0o666, data: enc.encode('x') }]);
await differential('writeFile where it may not write is EACCES', [{ call: 'writeFile', path: 'home/locked/f', mode: 0o666, data: enc.encode('x') }]);
await differential('appendFile creates, then appends', [
  { call: 'appendFile', path: 'home/user/log', mode: 0o644, data: enc.encode('one\n') },
  { call: 'appendFile', path: 'home/user/log', mode: 0o644, data: enc.encode('two\n') },
]);
await differential('mkdir, less the umask', [{ call: 'mkdir', path: 'home/user/m', mode: 0o777 }]);
await differential('mkdir of a name that exists is EEXIST', [{ call: 'mkdir', path: 'home/user/d', mode: 0o755 }]);
await differential('unlink, rmdir and symlink', [
  { call: 'unlink', path: 'home/user/target' },
  { call: 'rmdir', path: 'home/user/d' },
  { call: 'symlink', path: 'home/user/l2', target: 'kept' },
]);
await differential('rmdir of a file is ENOTDIR', [{ call: 'rmdir', path: 'home/user/kept' }]);

// ── A refusal in the middle: the prefix committed, nothing after it ─────
{
  const calls = [
    { call: 'mkdir', path: 'home/user/p', mode: 0o755 },
    { call: 'writeFile', path: 'home/user/p/a', mode: 0o644, data: enc.encode('a') },
    { call: 'mkdir', path: 'home/user/p', mode: 0o755 },
    { call: 'writeFile', path: 'home/user/p/b', mode: 0o644, data: enc.encode('b') },
  ];
  const result = await differential('a refusal mid-wave', calls);
  assert.equal(result.committedOps, 2);
  assert.equal(result.error.errno, 'EEXIST');
}

// ── Receipts: each call's file, with the revision its writeFile answers ──
{
  const { result } = await asWave([
    { call: 'writeFile', path: 'home/user/r1', mode: 0o644, data: enc.encode('1') },
    { call: 'writeFile', path: 'home/user/r2', mode: 0o644, data: enc.encode('22') },
  ]);
  assert.deepEqual(result.receipts.map((receipt) => [receipt.path, receipt.size]), [['home/user/r1', 1], ['home/user/r2', 2]]);
  assert.ok(result.receipts[1].revision > result.receipts[0].revision, 'each receipt carries its own revision');
}

// ── The wire: calls round-trip, with their fields exactly ───────────────
{
  const calls = [
    { call: 'writeFile', path: 'a/f', mode: 0o640, data: new Uint8Array(70_000).fill(3) },
    { call: 'mkdir', path: 'a/d', mode: 0o700 },
    { call: 'symlink', path: 'a/l', target: '../x' },
    { call: 'unlink', path: 'a/l' },
  ];
  const decoded = await decodeWriteBatchStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops: calls.map((call) => ({ type: 'call', call })) }));
  const seen = [];
  for await (const record of decoded.records) {
    if (record.type === 'file-begin') seen.push([record.type, record.inode.call, record.inode.path, record.inode.mode, record.inode.size]);
    else if (record.type === 'call') seen.push([record.type, record.call]);
    else if (record.type === 'file-chunk') record.retention.release();
  }
  assert.deepEqual(seen, [
    ['file-begin', 'writeFile', 'a/f', 0o640, 70_000],
    ['call', { call: 'mkdir', path: 'a/d', mode: 0o700 }],
    ['call', { call: 'symlink', path: 'a/l', target: '../x' }],
    ['call', { call: 'unlink', path: 'a/l' }],
  ]);
  await assert.rejects(async () => {
    const bad = encodeWriteBatchStream({ inodes: [], chunks: [], ops: [{ type: 'call', call: { call: 'mkdir', path: 'a/d', mode: 0o700, target: 'x' } }] });
    for await (const _ of (await decodeWriteBatchStream(bad)).records) { /* drain */ }
  }, /mkdir takes other fields/);
}

console.log('w7-calls: ok');
