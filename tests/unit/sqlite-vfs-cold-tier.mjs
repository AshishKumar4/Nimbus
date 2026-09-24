#!/usr/bin/env bun
/**
 * sqlite-vfs-cold-tier — snapshot-only chunks in a cold store (SPEC P6).
 * Tiering moves only chunks no live row, live manifest or staging content
 * names, so no live row ever names a cold chunk; a sync read of a cold
 * chunk through a snapshot fails ENODATA until prepareSnapshot brings it
 * back; a restore of a tiered snapshot is byte-identical after it; a write
 * of a cold chunk's bytes makes it local; GC deletes cold objects too.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

/** An R2-shaped store over a Map, counting traffic. */
function memoryStore() {
  const objects = new Map();
  const store = {
    objects,
    puts: 0,
    gets: 0,
    async put(key, bytes) { store.puts++; objects.set(key, new Uint8Array(bytes)); },
    async get(key) {
      store.gets++;
      const bytes = objects.get(key);
      return bytes === undefined ? null : { arrayBuffer: async () => bytes.slice().buffer };
    },
    async delete(keys) { for (const key of keys) objects.delete(key); },
  };
  return store;
}

function open(coldStore, harness = createSqliteVfsTestHarness()) {
  const raw = new SqliteVFS(harness.sql, harness.ctx, undefined, { coldStore });
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

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The invariant sync reads rely on: no live row or live manifest names a cold chunk. */
function liveColdReferences(harness) {
  return harness.sql.exec(`
    SELECT COUNT(*) AS n FROM vfs_chunks c WHERE c.state = 1 AND (
      EXISTS (SELECT 1 FROM vfs_inodes WHERE chunk_id = c.id)
      OR EXISTS (SELECT 1 FROM vfs_content_chunks cc JOIN vfs_inodes i ON i.content_id = cc.content_id WHERE cc.chunk_id = c.id))`)[0].n;
}

async function tierAll(raw) {
  let total = { tiered: 0, bytes: 0 };
  for (let pass = 0; ; pass++) {
    const r = await raw.tierColdChunks();
    total = { tiered: total.tiered + r.tiered, bytes: total.bytes + r.bytes };
    if (r.done) return total;
    assert.ok(pass < 1000);
  }
}

function image(view, paths) {
  return Object.fromEntries(paths.map((path) => [path, view.exists(path) ? sha(view.readFile(path)) : null]));
}

const PATHS = ['small', 'large', 'kept', 'gone', 'dir/deep'];

{
  const store = memoryStore();
  const { harness, raw, vfs } = open(store);
  vfs.mkdir('dir');
  vfs.writeFile('small', random(3_000, 1));
  vfs.writeFile('large', random(700_000, 2));
  vfs.writeFile('kept', random(90_000, 3));
  vfs.writeFile('gone', random(40_000, 4));
  vfs.writeFile('dir/deep', random(5_000, 5));
  raw.snapshot('s');
  const snapshotImage = image(raw.at('s'), PATHS);
  // Diverge: rewrite, edit, delete. 'kept' stays live, so its chunks stay local.
  vfs.writeFile('small', random(3_000, 11));
  vfs.writeRange('large', 350_000, random(10, 12));
  vfs.unlink('gone');
  vfs.writeFile('dir/deep', random(5_000, 15));
  const liveImage = image(vfs, PATHS);

  const tiered = await tierAll(raw);
  assert.ok(tiered.tiered >= 4, `snapshot-only chunks went cold (${tiered.tiered})`);
  assert.equal(liveColdReferences(harness), 0, 'no live row names a cold chunk');
  assert.equal(store.objects.size, tiered.tiered);
  assert.deepEqual(image(vfs, PATHS), liveImage, 'the live tree reads as before, synchronously');

  // A sync read through the snapshot of a cold chunk fails; after prepare it reads.
  assert.throws(() => raw.at('s').readFile('gone'), /ENODATA/);
  assert.throws(() => raw.restore('s'), /ENODATA/, 'a restore would publish a cold chunk');
  assert.throws(() => vfs.copyTree('dir', 'fork', { at: 's' }), /ENODATA/);
  assert.equal(liveColdReferences(harness), 0);
  const gets = store.gets;
  const prepared = await raw.prepareSnapshot('s');
  assert.ok(prepared.hydrated >= tiered.tiered - 1 && store.gets > gets);
  assert.deepEqual(image(raw.at('s'), PATHS), snapshotImage, 'the snapshot reads byte-identical');
  // Prepared snapshots stay local while held.
  assert.equal((await tierAll(raw)).tiered, 0, 'a prepared snapshot is not tiered again');

  // Restore of the tiered snapshot is byte-identical.
  raw.restore('s');
  assert.deepEqual(image(vfs, PATHS), snapshotImage);
  assert.equal(liveColdReferences(harness), 0);
  raw.releaseSnapshot('s');
}

// ── A write of a cold chunk's bytes makes it local ───────────────────────
{
  const store = memoryStore();
  const { harness, raw, vfs } = open(store);
  const bytes = random(20_000, 7);
  vfs.writeFile('f', bytes);
  raw.snapshot('s');
  vfs.unlink('f');
  assert.equal((await tierAll(raw)).tiered, 1);
  vfs.writeFile('again', bytes);
  assert.equal(liveColdReferences(harness), 0, 'the dedupe brought the bytes back');
  assert.deepEqual(vfs.readFile('again'), bytes);
  assert.deepEqual(raw.at('s').readFile('f'), bytes, 'and the snapshot reads without a prepare');
}

// ── Dropping the snapshot deletes the cold objects ───────────────────────
{
  const store = memoryStore();
  const { raw, vfs } = open(store);
  for (let i = 0; i < 10; i++) vfs.writeFile(`f${i}`, random(10_000 + i, 20 + i));
  raw.snapshot('s');
  for (let i = 0; i < 10; i++) vfs.unlink(`f${i}`);
  assert.equal((await tierAll(raw)).tiered, 10);
  raw.dropSnapshot('s');
  for (let pass = 0; raw.runContentMaintenance(64).transactions > 0; pass++) assert.ok(pass < 100);
  const pass = await raw.tierColdChunks();
  assert.equal(pass.deleted, 10);
  assert.equal(store.objects.size, 0, 'nothing is left in the cold store');
  assert.deepEqual(raw._auditContentStore(), { chunks: 0, contents: 0 });
}

// ── A cold object that does not hash to its name is refused ──────────────
{
  const store = memoryStore();
  const { raw, vfs } = open(store);
  vfs.writeFile('f', random(30_000, 9));
  raw.snapshot('s');
  vfs.unlink('f');
  await tierAll(raw);
  for (const [key, bytes] of store.objects) { bytes[0] ^= 1; store.objects.set(key, bytes); }
  await assert.rejects(raw.prepareSnapshot('s'), /does not hash to its name/);
  assert.throws(() => raw.at('s').readFile('f'), /ENODATA/, 'still cold, not corrupt');
}

// ── An open descriptor pins what it reads ────────────────────────────────
{
  const store = memoryStore();
  const { raw, vfs } = open(store);
  vfs.writeFile('f', random(30_000, 10));
  raw.snapshot('s');
  const fd = raw.openDescription('f', CRED_KERNEL, { read: true, write: false });
  vfs.unlink('f');
  assert.equal((await tierAll(raw)).tiered, 0, 'a detached descriptor still reads it');
  assert.equal(fd.read(0, 10).length, 10);
  fd.close();
  assert.equal((await tierAll(raw)).tiered, 1);
}

// ── Across tier's awaits: a write naming a chunk, or a prepare, wins ─────
{
  const store = memoryStore();
  const { harness, raw, vfs } = open(store);
  const bytes = random(25_000, 30);
  vfs.writeFile('a', bytes);
  vfs.writeFile('b', random(25_000, 31));
  raw.snapshot('s');
  vfs.unlink('a');
  vfs.unlink('b');
  const put = store.put;
  let raced = false;
  store.put = async (key, data) => {
    await put(key, data);
    if (!raced) { raced = true; vfs.writeFile('back', bytes); raw.prepareSnapshot('s'); }
  };
  const r = await raw.tierColdChunks();
  assert.equal(r.tiered, 0, 'the re-probe kept both: one live again, one claimed by a prepare');
  assert.equal(liveColdReferences(harness), 0);
  assert.deepEqual(raw.at('s').readFile('a'), bytes);
}

console.log('sqlite-vfs-cold-tier: all assertions passed');
