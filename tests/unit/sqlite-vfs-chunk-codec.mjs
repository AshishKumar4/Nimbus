#!/usr/bin/env bun
/**
 * sqlite-vfs-chunk-codec — deflated chunks (chunk-codec.ts). A chunk that
 * deflates by at least an eighth is stored deflated (state 3), its name and
 * size those of its bytes; any other is stored as it is (state 0). Every read
 * (whole, ranged, cached or not, through a snapshot), every rewrite and edit,
 * dedup, export, the cold store and hydration see the bytes, never the stored
 * form; a stored form that does not inflate to its size is EIO, never bytes;
 * and the database holds the deflated size.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { deflateChunk, inflateChunk } from '../../packages/core/src/vfs/chunk-codec.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const RAW = 0;
const COLD = 1;
const DEFLATED = 3;

function open(options = {}, harness = createSqliteVfsTestHarness()) {
  const raw = new SqliteVFS(harness.sql, harness.ctx, undefined, options);
  return { harness, raw, vfs: raw.as(CRED_KERNEL) };
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

/** Source-like text that deflates about 3x and is cut by FastCDC like any other. */
function source(length, seed) {
  const words = ['const', 'return', 'function', 'value', 'export', 'import', 'await', 'length', 'index', 'node'];
  const noise = random(length, seed);
  let text = '';
  for (let i = 0; text.length < length; i++) {
    text += `${words[noise[i % length] % 10]} ${words[noise[(i * 7) % length] % 10]}_${noise[(i * 13) % length]} = ${i};\n`;
  }
  return new TextEncoder().encode(text.slice(0, length));
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Every chunk row a path's bytes name, with its state, size and stored length. */
function chunkRows(harness, path) {
  return harness.sql.exec(`
    SELECT c.id, c.state, c.size, length(c.data) AS stored, hex(c.hash) AS hash FROM vfs_inodes i JOIN vfs_chunks c ON c.id = i.chunk_id WHERE i.path = ?
    UNION ALL
    SELECT c.id, c.state, c.size, length(c.data), hex(c.hash) FROM vfs_inodes i JOIN vfs_content_chunks m ON m.content_id = i.content_id
      JOIN vfs_chunks c ON c.id = m.chunk_id WHERE i.path = ?`, path, path);
}

// ── The codec: an eighth or nothing; exact inflation or a throw ───────────
{
  const text = source(20_000, 1);
  const deflated = deflateChunk(text);
  assert.ok(deflated !== null && deflated.byteLength < text.byteLength / 2, 'text deflates');
  assert.equal(deflated.byteOffset, 0);
  assert.equal(deflated.buffer.byteLength, deflated.byteLength, 'a row binds only its own bytes');
  assert.deepEqual(inflateChunk(deflated, text.byteLength), text);
  assert.equal(deflateChunk(random(20_000, 2)), null, 'random bytes do not');
  assert.equal(deflateChunk(new TextEncoder().encode('{"a":1}')), null, 'nor does a tiny chunk');
  assert.throws(() => inflateChunk(deflated, text.byteLength + 1), /inflates to 20000 bytes, not 20001/);
  assert.throws(() => inflateChunk(new Uint8Array([1, 2, 3, 4]), 4));
}

// ── Stored form: deflated when it pays, else as written; size is the bytes' ──
{
  const { harness, vfs } = open();
  const text = source(30_000, 3);
  const noise = random(30_000, 4);
  // A file of many chunks, alternating runs of text and noise.
  const mixed = new Uint8Array(600_000);
  for (let at = 0, k = 0; at < mixed.length; at += 100_000, k++) {
    mixed.set((k % 2 === 0 ? source : random)(100_000, 10 + k).subarray(0, Math.min(100_000, mixed.length - at)), at);
  }
  vfs.writeFile('text.js', text);
  vfs.writeFile('noise.bin', noise);
  vfs.writeFile('mixed', mixed);

  const [t] = chunkRows(harness, 'text.js');
  assert.equal(t.state, DEFLATED);
  assert.equal(t.size, text.byteLength);
  assert.ok(t.stored <= text.byteLength * 7 / 8);
  assert.equal(t.hash.toLowerCase(), sha(text), 'the name is the bytes\' hash');
  const [n] = chunkRows(harness, 'noise.bin');
  assert.deepEqual([n.state, n.size, n.stored], [RAW, noise.byteLength, noise.byteLength]);
  const rows = chunkRows(harness, 'mixed');
  assert.ok(rows.length > 6);
  assert.ok(rows.some((row) => row.state === DEFLATED) && rows.some((row) => row.state === RAW), 'a file mixes both');

  // Reads: whole, ranged across chunk bounds, cached and not.
  assert.deepEqual(vfs.readFile('text.js'), text);
  assert.deepEqual(vfs.readFile('mixed'), mixed);
  for (const [offset, length] of [[0, 10], [65_000, 3_000], [99_990, 30], [123_457, 200_000], [599_000, 5_000]]) {
    const want = mixed.subarray(offset, Math.min(offset + length, mixed.length));
    assert.deepEqual(vfs.readRange('mixed', offset, length), want, `cached ${offset}+${length}`);
    assert.deepEqual(vfs.readRangeUncached('mixed', offset, length), want, `uncached ${offset}+${length}`);
  }

  // Rewrite in place (one chunk), edit (a manifest), append and truncate.
  const patch = new TextEncoder().encode('/* patched */');
  vfs.writeRange('text.js', 1_000, patch);
  text.set(patch, 1_000);
  assert.deepEqual(vfs.readFile('text.js'), text);
  assert.equal(chunkRows(harness, 'text.js')[0].state, DEFLATED);
  vfs.writeRange('mixed', 250_000, patch);
  mixed.set(patch, 250_000);
  assert.deepEqual(vfs.readFile('mixed'), mixed);
  vfs.writeRange('noise.bin', 30_000, source(5_000, 5));
  assert.deepEqual(vfs.readFile('noise.bin'), new Uint8Array([...noise, ...source(5_000, 5)]));
  vfs.truncate('mixed', 150_000);
  assert.deepEqual(vfs.readFile('mixed'), mixed.subarray(0, 150_000));

  // Dedup finds a deflated chunk by the bytes' name: one row for both names.
  vfs.writeFile('again.js', text);
  assert.equal(chunkRows(harness, 'again.js')[0].id, chunkRows(harness, 'text.js')[0].id);
  assert.equal(harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks WHERE hash = ?', Buffer.from(sha(text), 'hex'))[0].n, 1);
}

// ── A stored form that does not inflate to its size is EIO, never bytes ───
{
  const { harness, raw, vfs } = open();
  vfs.writeFile('a.js', source(10_000, 6));
  vfs.writeFile('b.js', source(10_000, 7));
  const [a] = chunkRows(harness, 'a.js');
  const [b] = chunkRows(harness, 'b.js');
  harness.sql.exec('UPDATE vfs_chunks SET data = x\'01020304\' WHERE id = ?', a.id);
  harness.sql.exec('UPDATE vfs_chunks SET size = size + 1 WHERE id = ?', b.id);
  const fresh = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  assert.throws(() => fresh.readFile('a.js'), (error) => error.code === 'EIO' && /a stored chunk is corrupt/.test(error.message));
  assert.throws(() => fresh.readFile('b.js'), (error) => error.code === 'EIO' && /not 10001/.test(error.message));
  assert.throws(() => raw.exportChunks([b.hash.toLowerCase()]), /EIO/);
}

// ── Export carries the bytes; an import stores them as its own codec says ──
{
  const src = open();
  src.vfs.mkdir('p');
  const files = { 'p/a.js': source(40_000, 8), 'p/b.bin': random(40_000, 9), 'p/c.js': source(300_000, 10) };
  for (const [path, bytes] of Object.entries(files)) src.vfs.writeFile(path, bytes);
  src.raw.snapshot('s');
  const page = src.raw.exportPage({ at: 's', root: 'p' });
  const dst = open();
  const want = dst.raw.wantChunks(page);
  assert.ok(want.length >= 4);
  const { chunks, rest } = src.raw.exportChunks(want, Infinity);
  assert.equal(rest.length, 0);
  for (const chunk of chunks) assert.equal(sha(chunk.data), chunk.hash, 'an exported chunk is its bytes');
  assert.equal(src.raw.wantChunks(page).length, 0, 'a deflated chunk is held, not wanted');
  dst.vfs.mkdir('home');
  dst.raw.importChunks('home/p', chunks);
  assert.equal(dst.raw.importPage('home/p', page).want.length, 0);
  for (const [path, bytes] of Object.entries(files)) assert.deepEqual(dst.vfs.readFile(`home/${path}`), bytes);
  assert.equal(chunkRows(dst.harness, 'home/p/a.js')[0].state, DEFLATED);
  assert.equal(chunkRows(dst.harness, 'home/p/b.bin')[0].state, RAW);

  // A lazy import's pending chunks are stored as the codec says when they arrive.
  const lazy = open();
  lazy.vfs.mkdir('home');
  lazy.raw.importPage('home/p', page, [], { lazy: true });
  assert.ok(chunkRows(lazy.harness, 'home/p/a.js').every((row) => row.state === 2));
  const hydrated = lazy.raw.hydrateChunks(chunks);
  assert.equal(hydrated.invalid.length, 0);
  for (const [path, bytes] of Object.entries(files)) assert.deepEqual(lazy.vfs.readFile(`home/${path}`), bytes);
  assert.equal(chunkRows(lazy.harness, 'home/p/a.js')[0].state, DEFLATED);
}

// ── The cold store holds a chunk's bytes; hydration stores them deflated ──
{
  const objects = new Map();
  const store = {
    async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async get(key) {
      const bytes = objects.get(key);
      return bytes === undefined ? null : { arrayBuffer: async () => bytes.slice().buffer };
    },
    async delete(keys) { for (const key of keys) objects.delete(key); },
  };
  const { harness, raw, vfs } = open({ coldStore: store });
  const text = source(50_000, 11);
  vfs.writeFile('gone.js', text);
  const [row] = chunkRows(harness, 'gone.js');
  assert.equal(row.state, DEFLATED);
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
  assert.deepEqual(objects.get(sha(text)), text, 'the cold object is the bytes, under their name');
  assert.equal(harness.sql.exec('SELECT state FROM vfs_chunks WHERE id = ?', row.id)[0].state, COLD);
  assert.throws(() => raw.at('s').readFile('gone.js'), /ENODATA/);
  await raw.prepareSnapshot('s');
  assert.equal(harness.sql.exec('SELECT state FROM vfs_chunks WHERE id = ?', row.id)[0].state, DEFLATED);
  assert.deepEqual(raw.at('s').readFile('gone.js'), text);
  raw.releaseSnapshot('s');
}

// ── The database holds the deflated size ─────────────────────────────────
{
  // The same tree twice, as source and as noise of the same sizes: the rows
  // around the bytes cost both the same, so the difference is the codec's.
  const growth = (make) => {
    const { raw, vfs } = open();
    vfs.mkdir('src');
    const before = raw.databaseBytes();
    for (let i = 0; i < 200; i++) vfs.writeFile(`src/f${i}.js`, make(4_000 + (i % 7) * 1_000, 100 + i));
    return raw.databaseBytes() - before;
  };
  const text = growth(source);
  const noise = growth(random);
  assert.ok(text < noise * 0.6, `source took ${text} bytes of database, noise ${noise}`);
}

console.log('sqlite-vfs-chunk-codec: ok');
