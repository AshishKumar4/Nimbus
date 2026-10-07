#!/usr/bin/env bun
// Unit tests for SqliteVFS stateless range ops (readRange/writeRange/
// truncate) and per-path subtree revisions. Covers chunk-boundary cases:
// writes spanning chunks, truncate mid-chunk, gap zero-fill, and revision
// isolation between paths.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CHUNK_SIZE } from '../../packages/platform/src/limits.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { chunkBytesWritten, createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

function makeVfs(db) {
  const harness = createSqliteVfsTestHarness(db);
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, rawVfs, vfs: rawVfs.as(CRED_KERNEL) };
}

// A reader dates what it holds by the delta's revision for each path and
// fetches with that as its expectedRevision, which readRange compares with
// revision(path): every path the delta names must report the revision it is
// named at, and a namespace answer's stat must say the same.
function assertDeltaAgrees(rawVfs, vfs, cursor, label) {
  const answer = vfs.acquire(rawVfs.epoch, cursor, { namespace: true });
  assert.equal(answer.poison, false, `${label}: poisoned`);
  for (const entry of answer.paths) {
    assert.equal(entry.rev, vfs.revision(entry.path), `${label}: the delta names ${entry.path} at a revision it does not report`);
    if (entry.stat) assert.equal(entry.stat.revision, entry.rev, `${label}: ${entry.path} stat.revision`);
  }
  return new Map(answer.paths.map((entry) => [entry.path, entry.rev]));
}

// The delta from SQLite, for a cursor older than the reopened engine's log,
// reads the generations the rows and tombstones hold: a file's is its
// revision too.
function assertSqlDeltaAgrees(harness, cursor, files, label) {
  const reopened = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  const fromSql = new Map(reopened.invalidatedSince(reopened.epoch, cursor).paths.map((entry) => [entry.path, entry.rev]));
  for (const path of files) {
    assert.equal(fromSql.get(path), reopened.revision(path), `${label}: the delta from SQLite names ${path} at a revision it does not report`);
  }
}

function pattern(length, seed = 0) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i + seed) % 251;
  return out;
}

assert.equal(CHUNK_SIZE, 65536, 'tests assume the documented 64 KiB chunk size');

// ── readRange ────────────────────────────────────────────────────────────
{
  const { harness, vfs } = makeVfs();
  vfs.mkdir('home/user', { recursive: true });
  const data = pattern(CHUNK_SIZE * 2 + 1000);
  vfs.writeFile('home/user/big.bin', data);

  // Within a single chunk.
  assert.deepEqual(vfs.readRange('home/user/big.bin', 10, 20), data.slice(10, 30));
  // Spanning the chunk 0/1 boundary.
  assert.deepEqual(
    vfs.readRange('home/user/big.bin', CHUNK_SIZE - 5, 10),
    data.slice(CHUNK_SIZE - 5, CHUNK_SIZE + 5),
  );
  // Clamped at EOF.
  assert.deepEqual(
    vfs.readRange('home/user/big.bin', data.length - 4, 100),
    data.slice(data.length - 4),
  );
  // Past EOF → empty.
  assert.equal(vfs.readRange('home/user/big.bin', data.length + 10, 8).length, 0);
  // Missing file → ENOENT.
  assert.throws(() => vfs.readRange('home/user/nope.bin', 0, 1), /ENOENT/);
  // Directory → EISDIR.
  vfs.mkdir('home/user/dir');
  assert.throws(() => vfs.readRange('home/user/dir', 0, 1), /EISDIR/);
}

// ── writeRange: in-place, spanning chunks, only affected chunks committed ──
{
  const { harness, vfs } = makeVfs();
  const data = pattern(CHUNK_SIZE * 3);
  vfs.writeFile('f.bin', data);
  const statementStart = harness.statementCount;
  const patch = pattern(10, 7);
  vfs.writeRange('f.bin', CHUNK_SIZE - 5, patch); // spans chunks 0 and 1
  // Only the chunks around the patch are re-cut and stored: at most the two
  // it straddles, never the file.
  const written = chunkBytesWritten(harness, statementStart);
  assert.ok(written > 0 && written <= 2 * CHUNK_SIZE, `range write stored ${written} chunk bytes`);

  const expected = new Uint8Array(data);
  expected.set(patch, CHUNK_SIZE - 5);
  assert.deepEqual(vfs.readFile('f.bin'), expected);
  assert.equal(vfs.stat('f.bin').size, data.length, 'in-place range write must not change size');
}

// ── writeRange: extension past EOF zero-fills the gap ──
{
  const { vfs } = makeVfs();
  vfs.writeFile('gap.bin', pattern(10));
  const tail = pattern(5, 3);
  vfs.writeRange('gap.bin', CHUNK_SIZE + 100, tail);

  const st = vfs.stat('gap.bin');
  assert.equal(st.size, CHUNK_SIZE + 105);
  const all = vfs.readFile('gap.bin');
  assert.equal(all.length, CHUNK_SIZE + 105);
  assert.deepEqual(all.slice(0, 10), pattern(10), 'original prefix preserved');
  assert.ok(all.slice(10, CHUNK_SIZE + 100).every((b) => b === 0), 'gap must read as zeroes');
  assert.deepEqual(all.slice(CHUNK_SIZE + 100), tail);
  // Ranged read across the gap agrees with the whole-file read.
  assert.deepEqual(vfs.readRange('gap.bin', CHUNK_SIZE + 98, 7), all.slice(CHUNK_SIZE + 98, CHUNK_SIZE + 105));
}

// ── writeRange: creates missing files; zero-length writes don't dirty ──
{
  const { vfs } = makeVfs();
  vfs.mkdir('made/by', { recursive: true });
  vfs.writeRange('made/by/range.bin', 0, pattern(20));
  assert.ok(vfs.isFile('made/by/range.bin'));
  assert.deepEqual(vfs.readFile('made/by/range.bin'), pattern(20));

  const revBefore = vfs.revision('made/by/range.bin');
  vfs.writeRange('made/by/range.bin', 5, new Uint8Array(0));
  assert.equal(vfs.revision('made/by/range.bin'), revBefore, 'zero-byte pwrite must not bump the revision');
  assert.equal(vfs.stat('made/by/range.bin').size, 20);

  assert.throws(() => vfs.writeRange('made/by', 0, pattern(1)), /EISDIR/);
}

// ── truncate: shrink mid-chunk, shrink across chunks, grow, persistence ──
{
  const { harness, vfs } = makeVfs();
  const data = pattern(CHUNK_SIZE * 2 + 500);
  vfs.writeFile('t.bin', data);

  // Shrink mid-chunk (drops chunk 2 entirely, trims chunk 1).
  vfs.truncate('t.bin', CHUNK_SIZE + 100);
  assert.equal(vfs.stat('t.bin').size, CHUNK_SIZE + 100);
  assert.deepEqual(vfs.readFile('t.bin'), data.slice(0, CHUNK_SIZE + 100));

  // Grow back: the dropped region must be zeroes, never resurrected data.
  vfs.truncate('t.bin', CHUNK_SIZE * 2);
  const grown = vfs.readFile('t.bin');
  assert.equal(grown.length, CHUNK_SIZE * 2);
  assert.deepEqual(grown.slice(0, CHUNK_SIZE + 100), data.slice(0, CHUNK_SIZE + 100));
  assert.ok(grown.slice(CHUNK_SIZE + 100).every((b) => b === 0), 'regrown region must be zero-filled');

  // Truncate to 0.
  vfs.truncate('t.bin', 0);
  assert.equal(vfs.stat('t.bin').size, 0);
  assert.equal(vfs.readFile('t.bin').length, 0);

  // Same-size truncate is a no-op (no revision bump).
  const rev = vfs.revision('t.bin');
  vfs.truncate('t.bin', 0);
  assert.equal(vfs.revision('t.bin'), rev);

  assert.throws(() => vfs.truncate('missing.bin', 0), /ENOENT/);

  // Persistence: a fresh VFS over the same SQLite sees the same bytes.
  vfs.writeRange('t.bin', 3, pattern(8, 1));
  const { vfs: vfs2 } = makeVfs(harness.db);
  const reread = vfs2.readFile('t.bin');
  assert.equal(reread.length, 11);
  assert.deepEqual(reread.slice(3), pattern(8, 1));
  assert.ok(reread.slice(0, 3).every((b) => b === 0));
}

// ── per-path revisions: subtree watermarks + isolation between paths ──
{
  const { vfs } = makeVfs();
  vfs.mkdir('home/user/example-app', { recursive: true });
  vfs.mkdir('home/other', { recursive: true });

  const base = vfs.revision('home/user');
  vfs.writeFile('home/user/example-app/a.txt', 'one');
  assert.ok(vfs.revision('home/user') > base, 'write under subtree bumps the subtree watermark');
  assert.equal(vfs.revision('home/user'), vfs.revision('home/user/example-app/a.txt'));
  assert.equal(vfs.revision(''), vfs.revision(), 'root watermark equals the global clock');

  // Isolation: mutations elsewhere must not move this subtree's watermark.
  const userRev = vfs.revision('home/user');
  const fileRev = vfs.revision('home/user/example-app/a.txt');
  vfs.writeFile('home/other/b.txt', 'two');
  vfs.utimes('home/other/b.txt', 1000, 2000);
  vfs.writeRange('home/other/b.txt', 1, new Uint8Array([7]));
  vfs.truncate('home/other/b.txt', 2);
  vfs.unlink('home/other/b.txt');
  assert.equal(vfs.revision('home/user'), userRev, 'unrelated mutations must not bump the subtree');
  assert.equal(vfs.revision('home/user/example-app/a.txt'), fileRev, 'unrelated mutations must not bump the file');
  assert.ok(vfs.revision() > userRev, 'global clock still advances');

  // Range ops and truncate bump their own subtree.
  vfs.writeRange('home/user/example-app/a.txt', 0, new Uint8Array([1]));
  assert.ok(vfs.revision('home/user') > userRev);
  const afterRange = vfs.revision('home/user');
  vfs.truncate('home/user/example-app/a.txt', 1);
  assert.ok(vfs.revision('home/user') > afterRange);

  // unlink/rmdir bump ancestors.
  const beforeUnlink = vfs.revision('home/user');
  vfs.unlink('home/user/example-app/a.txt');
  assert.ok(vfs.revision('home/user') > beforeUnlink);
}

// ── per-path revisions: rename bumps both subtrees including children ──
{
  const { harness, rawVfs, vfs } = makeVfs();
  vfs.mkdir('proj/src', { recursive: true });
  vfs.writeFile('proj/src/index.js', 'x');
  vfs.mkdir('dest', { recursive: true });

  const oldRev = vfs.revision('proj');
  const destRev = vfs.revision('dest');
  const cursor = vfs.revision();
  vfs.rename('proj/src', 'dest/src');
  assert.ok(vfs.revision('proj') > oldRev, 'rename bumps the source subtree');
  assert.ok(vfs.revision('dest') > destRev, 'rename bumps the destination subtree');
  // A moved child is published at its new path at the revision it reports;
  // at its old one it is behind the removed directory, which is published.
  const delta = assertDeltaAgrees(rawVfs, vfs, cursor, 'directory rename');
  assert.equal(vfs.revision('dest/src/index.js'), delta.get('dest/src/index.js'));
  assert.ok(delta.has('proj/src'));
  assertSqlDeltaAgrees(harness, cursor, ['dest/src/index.js'], 'directory rename');
}

// ── per-path revisions: an atomic write (write a temp file, rename it over) ──
// Rename commits the destination and retires the source in two transactions
// and publishes once, at the second: the destination's row holds the first.
// A reader that dates the file by the delta must be able to fetch it at that.
{
  const { harness, rawVfs, vfs } = makeVfs();
  const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
  vfs.mkdir('home/user', { recursive: true });
  vfs.writeFile('home/user/app.js', 'v1');
  const cursor = vfs.revision();
  vfs.writeFile('home/user/.app.js.tmp', 'v2');
  vfs.rename('home/user/.app.js.tmp', 'home/user/app.js');
  const delta = assertDeltaAgrees(rawVfs, vfs, cursor, 'rename over');
  assert.deepEqual([...delta.keys()].sort(), ['home/user', 'home/user/.app.js.tmp', 'home/user/app.js']);
  assert.ok(delta.get('home/user/app.js') < vfs.revision(), 'the destination row is the first transaction\'s');
  const bytes = bridge.readRange('/home/user/app.js', 0, 16, { expectedEpoch: rawVfs.epoch, expectedRevision: delta.get('home/user/app.js') });
  assert.equal(new TextDecoder().decode(bytes), 'v2');
  assertSqlDeltaAgrees(harness, cursor, ['home/user/app.js'], 'rename over');
}

// ── per-path revisions: an embedder transaction of several operations ──
// Each operation commits its own generation inside the one transaction, and
// the transaction publishes once, at the last: a path written by an earlier
// operation holds that earlier one, and is published at it.
{
  const { harness, rawVfs, vfs } = makeVfs();
  vfs.mkdir('tx', { recursive: true });
  vfs.writeFile('tx/a', 'a0');
  vfs.writeFile('tx/b', 'b0');
  vfs.writeFile('tx/g', 'g0');
  const cursor = vfs.revision();
  rawVfs.withTransaction(() => {
    vfs.writeFile('tx/a', 'a1');
    vfs.mkdir('tx/d');
    vfs.writeFile('tx/d/c', 'c1');
    vfs.mkdir('tx/empty');
    vfs.unlink('tx/b');
    vfs.writeFile('tx/g', 'g1');
    vfs.writeFile('tx/e', 'e1');
    vfs.rename('tx/e', 'tx/f');
    vfs.writeFile('tx/g', 'g2');
  });
  const delta = assertDeltaAgrees(rawVfs, vfs, cursor, 'withTransaction');
  for (const path of ['tx', 'tx/a', 'tx/b', 'tx/d', 'tx/d/c', 'tx/empty', 'tx/e', 'tx/f', 'tx/g']) {
    assert.ok(delta.has(path), `withTransaction: ${path} was not published`);
    assert.ok(delta.get(path) > cursor, `withTransaction: ${path} published at or below the cursor`);
  }
  assert.ok(vfs.revision('tx/a') < vfs.revision('tx/g'), 'an earlier operation\'s row is below a later one\'s');
  assert.equal(vfs.revision('tx/g'), vfs.revision(), 'the last write is the publication\'s');
  assert.equal(vfs.revision('tx'), vfs.revision(), 'the directory is the publication\'s');
  assert.equal(vfs.readFileString('tx/f'), 'e1');
  assertSqlDeltaAgrees(harness, cursor, ['tx/a', 'tx/d/c', 'tx/f', 'tx/g'], 'withTransaction');
}

// ── per-path revisions: writeBatch advances every touched path, one tick ──
{
  const { vfs } = makeVfs();
  vfs.mkdir('keep', { recursive: true });
  vfs.writeFile('keep/k.txt', 'k');
  const keepRev = vfs.revision('keep');
  const globalBefore = vfs.revision();

  const mtime = Date.now();
  vfs.writeBatch({
    inodes: [
      { path: 'pkg', parentPath: '', isDir: true, size: 0, mtime, mode: 0o755, chunkCount: 0 },
      { path: 'pkg/mod.js', parentPath: 'pkg', isDir: false, size: 3, mtime, mode: 0o644, chunkCount: 1 },
    ],
    chunks: [{ path: 'pkg/mod.js', chunkId: 0, data: new Uint8Array([1, 2, 3]) }],
  });

  assert.equal(vfs.revision(), globalBefore + 1, 'a batch advances the clock exactly once');
  assert.equal(vfs.revision('pkg'), vfs.revision(), 'batch stamps the touched subtree');
  assert.equal(vfs.revision('pkg/mod.js'), vfs.revision());
  assert.equal(vfs.revision('keep'), keepRev, 'batch must not bump untouched subtrees');
}

console.log('sqlite-vfs-range-revision: all assertions passed');
