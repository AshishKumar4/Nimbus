#!/usr/bin/env bun
/**
 * sqlite-vfs-content-store — the content-addressed store (SPEC P1), through
 * the public filesystem API: dedup, GC completeness, crash safety of large
 * writes, CDC range reads, copy-on-write of shared content, and the in-place
 * rule that keeps an append log from churning chunks.
 */

import assert from 'node:assert/strict';
import { CHUNK_SIZE, MAX_TX_BLOB_BYTES } from '../../packages/platform/src/limits.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

function open(harness = createSqliteVfsTestHarness()) {
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, raw, vfs: raw.as(CRED_KERNEL) };
}

/** Deterministic incompressible bytes (xorshift32). */
function random(length, seed) {
  const out = new Uint8Array(length);
  let s = (seed * 2654435761 + 1) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = s & 255;
  }
  return out;
}

function databaseBytes(harness) {
  const [{ page_count: pages }] = harness.sql.exec('PRAGMA page_count');
  const [{ page_size: size }] = harness.sql.exec('PRAGMA page_size');
  return pages * size;
}

function drain(raw) {
  for (let pass = 0; pass < 1000; pass++) {
    if (raw.runContentMaintenance(64).transactions === 0) return;
  }
  throw new Error('maintenance did not reach a fixpoint');
}

function storedChunks(harness) {
  return harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n;
}

function fileRecord(path, data) {
  return {
    path,
    parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    isDir: false,
    size: data.length,
    mtime: 1,
    mode: 0o644,
    chunkCount: data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE),
  };
}

function wireChunks(path, data) {
  const out = [];
  for (let id = 0; id * CHUNK_SIZE < data.length; id++) {
    out.push({ path, chunkId: id, data: data.slice(id * CHUNK_SIZE, (id + 1) * CHUNK_SIZE) });
  }
  return out;
}

// ── Two identical 10k trees cost the second one's rows, not its bytes ─────
{
  const { harness, raw, vfs } = open();
  // npm-shaped: mostly small files, a few past CHUNK_SIZE.
  const sizes = Array.from({ length: 10_000 }, (_, i) => (i % 97 === 0 ? 150_000 + i : 200 + ((i * 7919) % 12_000)));
  const writeTree = (root) => {
    vfs.mkdir(root, { recursive: true });
    for (let d = 0; d < 100; d++) vfs.mkdir(`${root}/pkg-${d}`);
    for (let i = 0; i < sizes.length; i++) vfs.writeFile(`${root}/pkg-${i % 100}/f-${i}.js`, random(sizes[i], i));
  };
  const empty = databaseBytes(harness);
  writeTree('a/node_modules');
  const first = databaseBytes(harness) - empty;
  const chunksAfterFirst = storedChunks(harness);
  writeTree('b/node_modules');
  const second = databaseBytes(harness) - empty - first;
  assert.equal(storedChunks(harness), chunksAfterFirst, 'the second tree stores no chunk');
  // The second tree is inode rows and their indexes only: measured 268 B a
  // file (3.0% of this 8.8 KB-average tree), no content.
  assert.ok(second / sizes.length <= 300, `second identical tree added ${second / sizes.length} B a file`);
  assert.equal(vfs.contentKey('a/node_modules/pkg-3/f-3.js'), vfs.contentKey('b/node_modules/pkg-3/f-3.js'));
  assert.equal(vfs.contentKey('a/node_modules/pkg-0/f-0.js'), vfs.contentKey('b/node_modules/pkg-0/f-0.js'));
  assert.notEqual(vfs.contentKey('a/node_modules/pkg-0/f-0.js'), vfs.contentKey('a/node_modules/pkg-1/f-1.js'));

  // ── Unlinking every sharer frees every chunk ───────────────────────────
  assert.equal(vfs.removeRecursive('a'), 10_102);
  drain(raw);
  assert.equal(storedChunks(harness), chunksAfterFirst, 'the surviving sharer keeps every chunk');
  assert.deepEqual([...vfs.readFile('b/node_modules/pkg-0/f-0.js')], [...random(sizes[0], 0)]);
  vfs.removeRecursive('b');
  drain(raw);
  assert.equal(storedChunks(harness), 0, 'GC reaches empty once nothing names a chunk');
  assert.deepEqual(harness.sql.exec('SELECT id FROM vfs_contents'), []);
  assert.deepEqual(harness.sql.exec('SELECT kind, id FROM vfs_gc_queue'), []);
  assert.deepEqual(raw._auditContentStore(), { chunks: 0, contents: 0 });
}

// ── A reset at every large-write boundary leaks nothing ───────────────────
// failAfterTransaction models the object dying right after a commit: the
// next open queues the abandoned staging content and GC frees it.
{
  const data = random(MAX_TX_BLOB_BYTES * 3 + 12_345, 7);
  const baseline = createSqliteVfsTestHarness();
  const { vfs: probe } = open(baseline);
  const before = baseline.transactionCount;
  probe.writeFile('big.bin', data);
  const transactions = baseline.transactionCount - before;
  assert.ok(transactions >= 4, `a large write spans ${transactions} transactions`);
  for (let k = 1; k <= transactions; k++) {
    const harness = createSqliteVfsTestHarness();
    const { vfs } = open(harness);
    vfs.writeFile('old.bin', random(1000, 1));
    harness.failAfterTransaction({ transaction: harness.transactionCount + k, error: new Error(`reset after ${k}`) });
    assert.throws(() => vfs.writeFile('big.bin', data), new RegExp(`reset after ${k}`));
    harness.clearFault();
    const reopened = open(createSqliteVfsTestHarness(harness.db));
    drain(reopened.raw);
    const exists = reopened.vfs.exists('big.bin');
    if (exists) assert.deepEqual(reopened.vfs.readFile('big.bin'), data, `boundary ${k}: all or nothing`);
    assert.deepEqual(reopened.raw._auditContentStore(), { chunks: 0, contents: 0 }, `boundary ${k} leaked`);
    assert.deepEqual(harness.db.query('SELECT id FROM vfs_contents WHERE state != 1').all(), [], `boundary ${k}: staging left behind`);
    const referenced = harness.db.query(
      `SELECT COUNT(*) AS n FROM vfs_chunks c WHERE EXISTS (SELECT 1 FROM vfs_inodes WHERE chunk_id = c.id)
         OR EXISTS (SELECT 1 FROM vfs_content_chunks WHERE chunk_id = c.id)`,
    ).get().n;
    assert.equal(storedChunks(harness), referenced, `boundary ${k}: every stored chunk is referenced`);
  }
}

// ── readRange across CDC boundaries at every offset mod 4 KiB ─────────────
{
  const { harness, vfs } = open();
  const data = random(CHUNK_SIZE * 6 + 777, 11);
  vfs.writeFile('cdc.bin', data);
  const cuts = harness.sql.exec(
    'SELECT off FROM vfs_content_chunks WHERE content_id = (SELECT content_id FROM vfs_inodes WHERE path = ?) ORDER BY off',
    'cdc.bin',
  ).map((row) => row.off);
  assert.ok(cuts.length >= 6 && cuts.some((off) => off % CHUNK_SIZE !== 0), 'content-defined, not fixed, cuts');
  for (const cut of cuts.slice(1)) {
    for (let delta = -4096; delta <= 4096; delta += 509) {
      const start = cut + delta;
      if (start < 0) continue;
      for (const length of [1, 4096, CHUNK_SIZE + 3]) {
        assert.deepEqual(vfs.readRange('cdc.bin', start, length), data.subarray(start, start + length), `range ${start}+${length}`);
      }
    }
  }
  for (let offset = 0; offset < 4096; offset += 97) {
    const start = cuts[3] - 4096 + offset;
    assert.deepEqual(vfs.readRangeUncached('cdc.bin', start, 8192), data.subarray(start, start + 8192));
  }
}

// ── An uncached read neither consults nor fills the content cache ─────────
{
  const { raw, vfs } = open();
  const data = random(CHUNK_SIZE * 4 + 11, 31);
  vfs.writeFile('blob.bin', data);
  vfs.writeFile('small.bin', data.subarray(0, 100));
  raw.evictAll();
  const before = raw.getStats().cache;
  assert.deepEqual(vfs.readFileUncached('blob.bin'), data);
  assert.deepEqual(vfs.readRangeUncached('blob.bin', CHUNK_SIZE - 5, CHUNK_SIZE + 10), data.subarray(CHUNK_SIZE - 5, CHUNK_SIZE * 2 + 5));
  assert.deepEqual(vfs.readFileUncached('small.bin'), data.subarray(0, 100));
  const after = raw.getStats().cache;
  assert.equal(after.entries, before.entries, 'an uncached read filled the content cache');
  assert.equal(after.hits + after.misses, before.hits + before.misses, 'an uncached read consulted the content cache');
  // A cached read fills it, and what it hands back is the caller's to change.
  const read = vfs.readFile('blob.bin');
  assert.ok(raw.getStats().cache.entries > after.entries);
  read.fill(0);
  assert.deepEqual(vfs.readFile('blob.bin'), data, 'a cached read handed back the cached bytes');
}

// ── A write to shared content leaves the other sharer byte-identical ──────
for (const size of [5_000, CHUNK_SIZE * 5 + 17]) {
  const { raw, vfs } = open();
  const data = random(size, 3);
  vfs.writeFile('one', data);
  vfs.copyFile('one', 'two');
  assert.equal(vfs.contentKey('one'), vfs.contentKey('two'), 'a copy shares the content');
  vfs.writeRange('one', 100, new Uint8Array(50).fill(9));
  vfs.truncate('two', size - 10);
  const one = data.slice();
  one.fill(9, 100, 150);
  assert.deepEqual(vfs.readFile('one'), one);
  assert.deepEqual(vfs.readFile('two'), data.subarray(0, size - 10));
  drain(raw);
  assert.deepEqual(raw._auditContentStore(), { chunks: 0, contents: 0 });
}

// ── An append log does not churn chunks (the in-place rule) ───────────────
{
  const { harness, raw, vfs } = open();
  const expected = [];
  vfs.writeFile('app.log', '');
  for (let i = 0; i < 1000; i++) {
    const line = new TextEncoder().encode(`${String(i).padStart(6, '0')} ${'x'.repeat(i % 180)}\n`);
    vfs.writeRange('app.log', vfs.stat('app.log').size, line);
    expected.push(...line);
  }
  drain(raw);
  assert.deepEqual([...vfs.readFile('app.log')], expected);
  const [{ n: manifestRows }] = harness.sql.exec(
    'SELECT COUNT(*) AS n FROM vfs_content_chunks WHERE content_id = (SELECT content_id FROM vfs_inodes WHERE path = ?)',
    'app.log',
  );
  assert.ok(storedChunks(harness) <= manifestRows + 2, `${storedChunks(harness)} chunks stored for ${manifestRows} in the manifest`);
  assert.deepEqual(raw._auditContentStore(), { chunks: 0, contents: 0 });
}

// ── A streamed file is stored exactly as a written one ────────────────────
{
  const { harness, vfs } = open();
  const data = random(CHUNK_SIZE * 9 + 5, 21);
  vfs.writeFile('written.bin', data);
  const chunksBefore = storedChunks(harness);
  const result = await vfs.writeStream(encodeWriteBatchStream({
    inodes: [fileRecord('streamed.bin', data)],
    chunks: wireChunks('streamed.bin', data),
  }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(storedChunks(harness), chunksBefore, 'streamed CDC cuts equal whole-buffer cuts');
  assert.equal(vfs.contentKey('streamed.bin'), vfs.contentKey('written.bin'));
  assert.deepEqual(vfs.readFile('streamed.bin'), data);
}

// ── stat() carries the row generation; contentKey follows the bytes ───────
{
  const { vfs } = open();
  vfs.writeFile('g', 'one');
  const first = vfs.stat('g');
  const firstKey = vfs.contentKey('g');
  vfs.chmod('g', 0o600);
  const second = vfs.stat('g');
  assert.ok(second.gen > first.gen, 'a metadata change is a new row generation');
  assert.equal(vfs.contentKey('g'), firstKey, 'and leaves the content key alone');
  vfs.writeFile('g', 'two');
  assert.notEqual(vfs.contentKey('g'), firstKey);
  vfs.writeFile('h', '');
  assert.equal(vfs.contentKey('h'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
}

// ── Pre-v2 tables: ignored, then removed a bounded page at a time ─────────
{
  const harness = createSqliteVfsTestHarness();
  harness.sql.exec(`CREATE TABLE inodes (path TEXT PRIMARY KEY, parent_path TEXT, kind INTEGER, size INTEGER,
    mode INTEGER, chunk_count INTEGER, content_id TEXT)`);
  harness.sql.exec('CREATE TABLE file_chunks (content_id TEXT, chunk_id INTEGER, data BLOB, PRIMARY KEY (content_id, chunk_id))');
  harness.sql.exec('CREATE TABLE content_lifecycle (content_id TEXT PRIMARY KEY, state TEXT, created_at INTEGER)');
  for (let i = 0; i < 700; i++) {
    harness.sql.exec("INSERT INTO inodes VALUES (?, '', 0, 3, 420, 1, ?)", `old-${i}`, `c${i}`);
    harness.sql.exec('INSERT INTO file_chunks VALUES (?, 0, ?)', `c${i}`, new Uint8Array(3));
  }
  // A host's own table that merely shares a pre-v2 name is not ours.
  harness.sql.exec('CREATE TABLE vfs_schema_migrations (host_column TEXT)');
  const { raw, vfs } = open(harness);
  assert.equal(vfs.exists('old-1'), false, 'v2 starts empty');
  vfs.writeFile('new', 'v2');
  drain(raw);
  const tables = harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
  for (const legacy of ['inodes', 'file_chunks', 'content_lifecycle']) assert.ok(!tables.includes(legacy), `${legacy} dropped`);
  assert.ok(tables.includes('vfs_schema_migrations'), 'a host table with a colliding name is left alone');
  assert.equal(vfs.readFileString('new'), 'v2');
}

console.log('sqlite-vfs-content-store: all assertions passed');
