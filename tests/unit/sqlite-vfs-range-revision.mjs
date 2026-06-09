#!/usr/bin/env bun
// Unit tests for SqliteVFS stateless range ops (readRange/writeRange/
// truncate) and per-path subtree revisions. Covers chunk-boundary cases:
// writes spanning chunks, truncate mid-chunk, gap zero-fill, and revision
// isolation between paths.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { CHUNK_SIZE } from '../../packages/worker/src/constants.ts';

function makeSql(db = new Database(':memory:')) {
  return {
    db,
    exec(query, ...params) {
      return this.db.query(query).all(...params);
    },
  };
}

function pattern(length, seed = 0) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i + seed) % 251;
  return out;
}

assert.equal(CHUNK_SIZE, 65536, 'tests assume the documented 64 KiB chunk size');

// ── readRange ────────────────────────────────────────────────────────────
{
  const vfs = new SqliteVFS(makeSql());
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

// ── writeRange: in-place, spanning chunks, only affected chunks flushed ──
{
  const vfs = new SqliteVFS(makeSql());
  const data = pattern(CHUNK_SIZE * 3);
  vfs.writeFile('f.bin', data);
  vfs.flushAll();

  const before = vfs.getStats().sql.writes;
  const patch = pattern(10, 7);
  vfs.writeRange('f.bin', CHUNK_SIZE - 5, patch); // spans chunks 0 and 1
  vfs.flushAll();
  const flushedChunks = vfs.getStats().sql.writes - before;
  assert.equal(flushedChunks, 2, `range write spanning one boundary must flush exactly 2 chunks, flushed ${flushedChunks}`);

  const expected = new Uint8Array(data);
  expected.set(patch, CHUNK_SIZE - 5);
  assert.deepEqual(vfs.readFile('f.bin'), expected);
  assert.equal(vfs.stat('f.bin').size, data.length, 'in-place range write must not change size');
}

// ── writeRange: extension past EOF zero-fills the gap ──
{
  const vfs = new SqliteVFS(makeSql());
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
  const vfs = new SqliteVFS(makeSql());
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
  const sql = makeSql();
  const vfs = new SqliteVFS(sql);
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
  await vfs.flushAndWait();
  const vfs2 = new SqliteVFS(makeSql(sql.db));
  const reread = vfs2.readFile('t.bin');
  assert.equal(reread.length, 11);
  assert.deepEqual(reread.slice(3), pattern(8, 1));
  assert.ok(reread.slice(0, 3).every((b) => b === 0));
}

// ── per-path revisions: subtree watermarks + isolation between paths ──
{
  const vfs = new SqliteVFS(makeSql());
  vfs.mkdir('home/user/app', { recursive: true });
  vfs.mkdir('home/other', { recursive: true });

  const base = vfs.revision('home/user');
  vfs.writeFile('home/user/app/a.txt', 'one');
  assert.ok(vfs.revision('home/user') > base, 'write under subtree bumps the subtree watermark');
  assert.equal(vfs.revision('home/user'), vfs.revision('home/user/app/a.txt'));
  assert.equal(vfs.revision(''), vfs.revision(), 'root watermark equals the global clock');

  // Isolation: mutations elsewhere must not move this subtree's watermark.
  const userRev = vfs.revision('home/user');
  const fileRev = vfs.revision('home/user/app/a.txt');
  vfs.writeFile('home/other/b.txt', 'two');
  vfs.utimes('home/other/b.txt', 1000, 2000);
  vfs.writeRange('home/other/b.txt', 1, new Uint8Array([7]));
  vfs.truncate('home/other/b.txt', 2);
  vfs.unlink('home/other/b.txt');
  assert.equal(vfs.revision('home/user'), userRev, 'unrelated mutations must not bump the subtree');
  assert.equal(vfs.revision('home/user/app/a.txt'), fileRev, 'unrelated mutations must not bump the file');
  assert.ok(vfs.revision() > userRev, 'global clock still advances');

  // Range ops and truncate bump their own subtree.
  vfs.writeRange('home/user/app/a.txt', 0, new Uint8Array([1]));
  assert.ok(vfs.revision('home/user') > userRev);
  const afterRange = vfs.revision('home/user');
  vfs.truncate('home/user/app/a.txt', 1);
  assert.ok(vfs.revision('home/user') > afterRange);

  // unlink/rmdir bump ancestors.
  const beforeUnlink = vfs.revision('home/user');
  vfs.unlink('home/user/app/a.txt');
  assert.ok(vfs.revision('home/user') > beforeUnlink);
}

// ── per-path revisions: rename bumps both subtrees including children ──
{
  const vfs = new SqliteVFS(makeSql());
  vfs.mkdir('proj/src', { recursive: true });
  vfs.writeFile('proj/src/index.js', 'x');
  vfs.mkdir('dest', { recursive: true });

  const oldRev = vfs.revision('proj');
  const destRev = vfs.revision('dest');
  vfs.rename('proj/src', 'dest/src');
  assert.ok(vfs.revision('proj') > oldRev, 'rename bumps the source subtree');
  assert.ok(vfs.revision('dest') > destRev, 'rename bumps the destination subtree');
  assert.ok(vfs.revision('dest/src/index.js') > 0, 'moved children are stamped at their new path');
  assert.equal(vfs.revision('proj/src/index.js'), vfs.revision('dest/src/index.js'),
    'moved children are stamped at their old path too');
}

// ── per-path revisions: writeBatch stamps every touched path, one tick ──
{
  const vfs = new SqliteVFS(makeSql());
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
