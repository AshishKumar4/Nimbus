#!/usr/bin/env bun
/**
 * SqliteVFS.observeWrites (Kinu's ask 24, the engine half): every mutation
 * that lands, whoever made it (a view, a W7 stream, a descriptor), is
 * reported once it committed, with what stood at its path before and what
 * stands there now, and the principal of the call that made it. What it
 * replaced is held for the observer (a write in place copies instead) until
 * the observer is done, then let go for collection. A refused write, and a
 * rolled-back transaction, report nothing.
 */

import assert from 'node:assert/strict';
import { CHUNK_SIZE } from '../../packages/platform/src/limits.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

function open() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('home');
  kernel.mkdir('home/user');
  kernel.chown('home/user', 1000, 1000);
  return { harness, raw, kernel, vfs: raw.as(user, { actor: 'head-1' }) };
}

/** Each event, its content read while the observer holds it. */
function record(raw) {
  const events = [];
  const stop = raw.observeWrites((event) => {
    events.push({
      type: event.type,
      path: event.path,
      oldPath: event.oldPath,
      before: event.before === null ? null : event.before.type === 'directory' ? 'dir' : dec.decode(event.before.read()),
      after: event.after === null ? null : event.after.type === 'directory' ? 'dir' : dec.decode(event.after.read()),
      principal: event.principal,
    });
  });
  return { events, stop };
}

function drain(raw) {
  for (let pass = 0; pass < 1000; pass++) {
    if (raw.runContentMaintenance(64).transactions === 0) return;
  }
  throw new Error('maintenance did not reach a fixpoint');
}

function random(length, seed) {
  const out = new Uint8Array(length);
  let s = (seed * 2654435761 + 1) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = s & 255;
  }
  return out;
}

// ── A write over a file reports its old bytes; a new file reports null ──
{
  const { raw, vfs } = open();
  vfs.writeFile('home/user/a.txt', 'one');
  const { events } = record(raw);
  vfs.writeFile('home/user/a.txt', 'two');
  vfs.writeFile('home/user/b.txt', 'new');
  assert.deepEqual(events.map(({ principal, ...rest }) => rest), [
    { type: 'modify', path: 'home/user/a.txt', oldPath: undefined, before: 'one', after: 'two' },
    { type: 'create', path: 'home/user/b.txt', oldPath: undefined, before: null, after: 'new' },
  ]);
  assert.equal(events[0].principal.cred.uid, 1000);
  assert.equal(events[0].principal.actor, 'head-1', "the view's actor is not the event's principal");
}

// ── Unlink, rename (both paths, with what the target held), mkdir ──
{
  const { raw, vfs } = open();
  vfs.writeFile('home/user/from', 'moved');
  vfs.writeFile('home/user/to', 'replaced');
  vfs.writeFile('home/user/gone', 'bye');
  const { events } = record(raw);
  vfs.rename('home/user/from', 'home/user/to');
  vfs.unlink('home/user/gone');
  vfs.mkdir('home/user/dir');
  assert.deepEqual(events.map(({ principal, ...rest }) => rest), [
    { type: 'rename', path: 'home/user/to', oldPath: 'home/user/from', before: 'replaced', after: 'moved' },
    { type: 'delete', path: 'home/user/gone', oldPath: undefined, before: 'bye', after: null },
    { type: 'create', path: 'home/user/dir', oldPath: undefined, before: null, after: 'dir' },
  ]);
}

// ── A refused write reports nothing ──
{
  const { raw, vfs } = open();
  const { events } = record(raw);
  assert.throws(() => vfs.writeFile('etc-file', 'x'), /EACCES/);
  assert.throws(() => vfs.writeFile('home/user/missing/x', 'x'), /ENOENT/);
  assert.equal(events.length, 0, `a refused write was reported: ${JSON.stringify(events)}`);
}

// ── A write in place (a range, small and large) still hands over the old bytes ──
{
  const { raw, vfs } = open();
  vfs.writeFile('home/user/small', 'aaaa');
  const large = random(CHUNK_SIZE * 3 + 17, 7);
  vfs.writeFile('home/user/large', large);
  const held = [];
  const stop = raw.observeWrites((event) => { held.push(event); return new Promise((resolve) => setTimeout(resolve, 5)); });
  vfs.writeRange('home/user/small', 1, enc.encode('ZZ'));
  vfs.writeRange('home/user/large', CHUNK_SIZE + 3, enc.encode('patched'));
  // Written again while the observer still holds the first events.
  vfs.writeRange('home/user/large', CHUNK_SIZE + 3, enc.encode('PATCHED'));
  assert.equal(dec.decode(held[0].before.read()), 'aaaa');
  assert.equal(dec.decode(held[0].after.read()), 'aZZa');
  assert.deepEqual(held[1].before.read(), large, "a large file's replaced bytes were rewritten in place");
  const once = large.slice();
  once.set(enc.encode('patched'), CHUNK_SIZE + 3);
  assert.deepEqual(held[1].after.read(), once, "the event's after changed with a later write");
  stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Done with: the content is let go, and collected.
  assert.throws(() => held[1].before.read(), /EBADF/);
  drain(raw);
  assert.deepEqual(raw._auditContentStore(), { chunks: 0, contents: 0 }, 'released content leaked');
}

// ── Content an observer holds survives collection until it lets go ──
{
  const { raw, vfs } = open();
  const old = random(CHUNK_SIZE * 2 + 3, 9);
  vfs.writeFile('home/user/big', old);
  let release;
  let before;
  const stop = raw.observeWrites((event) => {
    before = event.before;
    return new Promise((resolve) => { release = resolve; });
  });
  vfs.writeFile('home/user/big', 'small now');
  stop();
  drain(raw);
  assert.deepEqual(before.read(), old, 'collection took content an observer holds');
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  drain(raw);
  assert.deepEqual(raw._auditContentStore(), { chunks: 0, contents: 0 });
}

// ── A W7 stream's writes are its caller's, committed in later turns ──
{
  const { raw, vfs } = open();
  const { events } = record(raw);
  const data = enc.encode('streamed');
  const result = await vfs.writeStream(encodeWriteBatchStream({
    inodes: [{ path: 'home/user/s.txt', parentPath: 'home/user', kind: 'file', isDir: false, size: data.length, mtime: 1, mode: 0o644, chunkCount: 1 }],
    chunks: [{ path: 'home/user/s.txt', chunkId: 0, data }],
  }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(events.length, 1);
  assert.equal(events[0].after, 'streamed');
  assert.equal(events[0].principal.cred?.uid, 1000, "a stream's write was not its caller's");
  assert.equal(events[0].principal.actor, 'head-1');
}

// ── A descriptor's writes are its opener's, wherever they are written ──
{
  const { raw, vfs } = open();
  vfs.writeFile('home/user/log', '');
  const { events } = record(raw);
  const description = raw.openDescription('home/user/log', user, { read: false, write: true });
  description.write(0, enc.encode('line\n'));
  description.close();
  assert.ok(events.length >= 1);
  const last = events.at(-1);
  assert.equal(last.after, 'line\n');
  assert.equal(last.principal.cred?.uid, 1000, "a descriptor's write was not its opener's");
}

// ── An embedder transaction reports once it publishes; a rollback, never ──
{
  const { raw, vfs } = open();
  const { events } = record(raw);
  raw.withTransaction(() => {
    vfs.writeFile('home/user/t1', 'one');
    vfs.writeFile('home/user/t1', 'two');
    assert.equal(events.length, 0, 'a write was reported inside its transaction');
  });
  assert.deepEqual(events.map((event) => [event.before, event.after]), [[null, 'one'], ['one', 'two']]);
  events.length = 0;
  assert.throws(() => raw.withTransaction(() => {
    vfs.writeFile('home/user/t2', 'never');
    throw new Error('abandon');
  }), /rolled back/);
  assert.equal(events.length, 0, 'a rolled-back write was reported');
  drain(raw);
  assert.deepEqual(raw._auditContentStore(), { chunks: 0, contents: 0 });
}

console.log('sqlite-vfs observeWrites: ok');
