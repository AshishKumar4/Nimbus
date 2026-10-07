#!/usr/bin/env bun
/**
 * sqlite-vfs-chunk-codec — the reader of deflated chunks (chunk-codec.ts).
 * This release writes every chunk as its bytes (state 0); the release after
 * it deflates them in the background, storing a chunk deflated (state 3) or,
 * found not to deflate, as written and tried (state 4). Here rows are put in
 * those states the way that pass will, and every reader must see the bytes:
 * whole and ranged reads, cached or not, dedup, an in-place rewrite (stored
 * as written again), export, and the cold store (which holds the bytes).
 * A deflated row that does not inflate to its size is EIO, never bytes.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const RAW = 0;
const COLD = 1;
const DEFLATED = 3;
const KEPT = 4;

function open(options = {}, harness = createSqliteVfsTestHarness()) {
  const raw = new SqliteVFS(harness.sql, harness.ctx, undefined, options);
  return { harness, raw, vfs: raw.as(CRED_KERNEL) };
}

/** A fresh engine over the same database: nothing cached. */
const reopen = ({ harness }, options = {}) => open(options, harness);

/** Source-like text, which deflates. */
function source(length, seed) {
  let text = '';
  for (let i = 0; text.length < length; i++) text += `export const value_${(seed * 31 + i) % 997} = await load(${i});\n`;
  return new TextEncoder().encode(text.slice(0, length));
}

function random(length, seed) {
  const out = new Uint8Array(length);
  let s = (Math.imul(seed, 2654435761) + 1) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = s & 255;
  }
  return out;
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The chunk rows a path's bytes name, in order. */
function chunkRows(harness, path) {
  return harness.sql.exec(`
    SELECT c.id, c.state, c.size FROM vfs_inodes i JOIN vfs_chunks c ON c.id = i.chunk_id WHERE i.path = ?
    UNION ALL
    SELECT c.id, c.state, c.size FROM vfs_inodes i JOIN vfs_content_chunks m ON m.content_id = i.content_id
      JOIN vfs_chunks c ON c.id = m.chunk_id WHERE i.path = ?`, path, path);
}

/** As the background pass will store a chunk: deflated, or kept as written and marked tried. */
function compact(harness, id, state = DEFLATED) {
  const [row] = harness.sql.exec('SELECT data FROM vfs_chunks WHERE id = ?', id);
  const data = state === DEFLATED ? new Uint8Array(deflateRawSync(row.data, { level: 1 })) : row.data;
  harness.sql.exec('UPDATE vfs_chunks SET data = ?, state = ? WHERE id = ?', data, state, id);
}

// ── Every read sees the bytes, whatever form a row stores them in ─────────
{
  const store = open();
  const { harness, vfs } = store;
  const small = source(9_000, 1);
  const kept = random(9_000, 2);
  const large = new Uint8Array(500_000);
  for (let at = 0, k = 0; at < large.length; at += 50_000, k++) large.set((k % 2 ? random : source)(50_000, 10 + k), at);
  vfs.writeFile('small.js', small);
  vfs.writeFile('kept.bin', kept);
  vfs.writeFile('large', large);
  compact(harness, chunkRows(harness, 'small.js')[0].id);
  compact(harness, chunkRows(harness, 'kept.bin')[0].id, KEPT);
  const rows = chunkRows(harness, 'large');
  assert.ok(rows.length >= 5);
  rows.forEach((row, index) => compact(harness, row.id, [DEFLATED, KEPT, RAW][index % 3]));
  assert.ok(harness.sql.exec('SELECT length(data) AS n FROM vfs_chunks WHERE id = ?', chunkRows(harness, 'small.js')[0].id)[0].n < small.byteLength / 2);

  for (const view of [reopen(store).vfs, reopen(store).vfs]) {
    assert.deepEqual(view.readFile('small.js'), small);
    assert.deepEqual(view.readFile('kept.bin'), kept);
    assert.deepEqual(view.readFile('large'), large);
    for (const [offset, length] of [[0, 10], [65_530, 20], [123_457, 200_000], [499_000, 5_000]]) {
      const want = large.subarray(offset, Math.min(large.length, offset + length));
      assert.deepEqual(view.readRange('large', offset, length), want, `cached ${offset}+${length}`);
      assert.deepEqual(view.readRangeUncached('large', offset, length), want, `uncached ${offset}+${length}`);
    }
  }

  // Dedup finds a deflated chunk by its bytes' name, and leaves it so.
  const fresh = reopen(store);
  const chunksBefore = harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n;
  fresh.vfs.writeFile('again.js', small);
  assert.equal(harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n, chunksBefore, 'the same bytes made a new chunk');
  assert.equal(chunkRows(harness, 'again.js')[0].state, DEFLATED);
  assert.deepEqual(fresh.vfs.readFile('again.js'), small);

  // An in-place rewrite stores its bytes as written. Red before: the row kept
  // state 3 over raw bytes, and the next read failed to inflate them.
  const solo = source(7_000, 3);
  fresh.vfs.writeFile('solo.js', solo);
  compact(harness, chunkRows(harness, 'solo.js')[0].id);
  const edited = reopen(store);
  edited.vfs.writeRange('solo.js', 100, new TextEncoder().encode('/* edit */'));
  solo.set(new TextEncoder().encode('/* edit */'), 100);
  assert.equal(chunkRows(harness, 'solo.js')[0].state, RAW, 'a rewrite left its row deflated');
  assert.deepEqual(reopen(store).vfs.readFile('solo.js'), solo);
}

// ── A deflated row that does not inflate to its size is EIO, never bytes ──
{
  const store = open();
  const { harness, vfs } = store;
  for (const name of ['garbage', 'short', 'bomb']) vfs.writeFile(name, source(8_000, name.length));
  const id = (path) => chunkRows(harness, path)[0].id;
  harness.sql.exec('UPDATE vfs_chunks SET data = x\'01020304\', state = 3 WHERE id = ?', id('garbage'));
  compact(harness, id('short'));
  harness.sql.exec('UPDATE vfs_chunks SET size = size + 1 WHERE id = ?', id('short'));
  // Claims 8,000 bytes and inflates to 50 MB: bounded by the size it claims.
  harness.sql.exec('UPDATE vfs_chunks SET data = ?, state = 3 WHERE id = ?', new Uint8Array(deflateRawSync(new Uint8Array(50_000_000))), id('bomb'));
  const view = reopen(store);
  for (const name of ['garbage', 'short', 'bomb']) {
    assert.throws(() => view.vfs.readFile(name), (error) => error.code === 'EIO' && /a stored chunk is corrupt/.test(error.message), name);
  }
}

// ── A valid deflate of other bytes of the same length is EIO, never bytes ──
// Raw deflate carries no check: what it inflates to must hash to the row's
// name. Red before: a read returned (and cached) the other bytes, and an
// export or the cold store published them under the original name.
{
  const objects = new Map();
  const coldStore = {
    async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async get(key) { const bytes = objects.get(key); return bytes === undefined ? null : { arrayBuffer: async () => bytes.slice().buffer }; },
    async delete(keys) { for (const key of keys) objects.delete(key); },
  };
  const store = open({ coldStore });
  const { harness, raw, vfs } = store;
  const right = source(12_000, 8);
  const wrong = source(12_000, 9);
  assert.equal(wrong.byteLength, right.byteLength);
  assert.notDeepEqual(wrong, right);
  vfs.writeFile('swapped.js', right);
  const [row] = chunkRows(harness, 'swapped.js');
  harness.sql.exec('UPDATE vfs_chunks SET data = ?, state = 3 WHERE id = ?', new Uint8Array(deflateRawSync(wrong)), row.id);
  const corrupt = (error) => error.code === 'EIO' && /does not hash to its name/.test(error.message);
  const view = reopen(store, { coldStore });
  assert.throws(() => view.vfs.readFile('swapped.js'), corrupt, 'a read returned bytes that are not the chunk');
  assert.throws(() => view.vfs.readRange('swapped.js', 0, 100), corrupt, 'a cached read returned them');
  assert.throws(() => view.vfs.readRangeUncached('swapped.js', 0, 100), corrupt);
  assert.throws(() => view.raw.exportChunks([sha(right)]), corrupt, 'an export published them under the name');
  view.raw.snapshot('s');
  view.vfs.unlink('swapped.js');
  await assert.rejects(async () => { for (let pass = 0; !(await view.raw.tierColdChunks()).done; pass++) assert.ok(pass < 100); }, corrupt);
  assert.equal(objects.size, 0, 'the cold store took them under the name');
}

// ── Export carries the bytes; the cold store holds them ───────────────────
{
  const src = open();
  src.vfs.mkdir('p');
  const files = { 'p/a.js': source(30_000, 4), 'p/b.bin': random(30_000, 5), 'p/c.js': source(200_000, 6) };
  for (const [path, bytes] of Object.entries(files)) src.vfs.writeFile(path, bytes);
  for (const path of Object.keys(files)) for (const row of chunkRows(src.harness, path)) compact(src.harness, row.id, path.endsWith('.bin') ? KEPT : DEFLATED);
  src.raw.snapshot('s');
  const page = src.raw.exportPage({ at: 's', root: 'p' });
  assert.equal(src.raw.wantChunks(page).length, 0, 'a compacted chunk is held, not wanted');
  const dst = open();
  const want = dst.raw.wantChunks(page);
  const { chunks, rest } = reopen(src).raw.exportChunks(want, Infinity);
  assert.equal(rest.length, 0);
  for (const chunk of chunks) assert.equal(sha(chunk.data), chunk.hash, 'an exported chunk is not its bytes');
  dst.vfs.mkdir('home');
  dst.raw.importChunks('home/p', chunks);
  assert.equal(dst.raw.importPage('home/p', page).want.length, 0);
  for (const [path, bytes] of Object.entries(files)) assert.deepEqual(dst.vfs.readFile(`home/${path}`), bytes);
}
{
  const objects = new Map();
  const coldStore = {
    async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async get(key) {
      const bytes = objects.get(key);
      return bytes === undefined ? null : { arrayBuffer: async () => bytes.slice().buffer };
    },
    async delete(keys) { for (const key of keys) objects.delete(key); },
  };
  const store = open({ coldStore });
  const { harness, raw, vfs } = store;
  const gone = source(40_000, 7);
  vfs.writeFile('gone.js', gone);
  const [row] = chunkRows(harness, 'gone.js');
  compact(harness, row.id);
  raw.snapshot('s');
  vfs.unlink('gone.js');
  let tiered = 0;
  for (let pass = 0; ; pass++) {
    const result = await raw.tierColdChunks();
    tiered += result.tiered;
    if (result.done) break;
    assert.ok(pass < 100);
  }
  assert.equal(tiered, 1);
  assert.deepEqual(objects.get(sha(gone)), gone, 'the cold object is not the bytes under their name');
  assert.equal(harness.sql.exec('SELECT state FROM vfs_chunks WHERE id = ?', row.id)[0].state, COLD);
  await raw.prepareSnapshot('s');
  assert.equal(harness.sql.exec('SELECT state FROM vfs_chunks WHERE id = ?', row.id)[0].state, RAW, 'hydration stores the bytes as written');
  assert.deepEqual(raw.at('s').readFile('gone.js'), gone);
  raw.releaseSnapshot('s');
}

console.log('sqlite-vfs-chunk-codec: ok');
