#!/usr/bin/env bun
/**
 * sqlite-vfs-durable-clock — the revision clock survives a supervisor
 * restart (SPEC P5). The epoch is the database's incarnation and revisions
 * are generations, so a reader holding (epoch, cursor) from before a restart
 * gets a delta, not a refill: untouched files keep their revisions, every
 * change (writes, deletes, renames, restores) is reported from the rows and
 * tombstones, a cursor below the tombstone floor poisons, and a reader that
 * applies the delta never keeps a stale byte.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

function open(harness = createSqliteVfsTestHarness(), options) {
  const raw = new SqliteVFS(harness.sql, harness.ctx, undefined, options);
  return { harness, raw, vfs: raw.as(CRED_KERNEL) };
}
const reopen = (harness, options) => open(createSqliteVfsTestHarness(harness.db), options);

function listAll(raw) {
  const entries = [];
  let after = null;
  for (;;) {
    const page = raw.list(after, 500, CRED_KERNEL);
    entries.push(...page.entries);
    if (page.next === null) return { epoch: page.epoch, rev: page.rev, entries };
    after = page.next;
  }
}

/** A resident reader: rows dated by revision, kept only while a delta allows. */
function residentFrom(raw, vfs) {
  const listing = listAll(raw);
  const rows = new Map();
  for (const entry of listing.entries) {
    if (entry.kind === 'file') rows.set(entry.path, { rev: entry.rev, bytes: dec.decode(vfs.readFile(entry.path)) });
  }
  return { cursor: { epoch: listing.epoch, rev: listing.rev }, rows };
}

function admit(resident, delta) {
  if (delta.poison) { resident.rows.clear(); resident.cursor = { epoch: delta.epoch, rev: delta.rev }; return 'poison'; }
  for (const { path, rev } of delta.paths) {
    const row = resident.rows.get(path);
    if (row && row.rev < rev) resident.rows.delete(path);
  }
  resident.cursor = { epoch: delta.epoch, rev: delta.rev };
  return 'delta';
}

function assertNoStaleRow(resident, vfs, label) {
  for (const [path, row] of resident.rows) {
    assert.ok(vfs.isFile(path), `${label}: kept ${path}, which is gone`);
    assert.equal(row.bytes, dec.decode(vfs.readFile(path)), `${label}: kept a stale ${path}`);
  }
}

// ── A restart keeps the epoch, the clock and every untouched revision ─────
{
  const { harness, raw, vfs } = open();
  vfs.mkdir('a/b', { recursive: true });
  for (let i = 0; i < 20; i++) vfs.writeFile(`a/b/f${i}`, `v${i}`);
  const before = listAll(raw);
  const next = reopen(harness);
  assert.equal(next.raw.epoch, raw.epoch, 'the epoch is the database, not the isolate');
  assert.equal(next.raw.revision(), raw.revision(), 'the clock is durable');
  const after = listAll(next.raw);
  const revs = (listing) => Object.fromEntries(listing.entries.filter((e) => e.kind === 'file').map((e) => [e.path, e.rev]));
  assert.deepEqual(revs(after), revs(before), 'an untouched file keeps its revision across a restart');
  for (const entry of after.entries) {
    if (entry.kind === 'file') assert.equal(entry.contentKey, next.vfs.contentKey(entry.path), 'list carries contentKey');
    if (entry.kind === 'directory') assert.ok(entry.rev >= raw.revision(`${entry.path}`), 'a directory never reports less than before');
  }
  // A different database is a different epoch.
  assert.notEqual(open().raw.epoch, raw.epoch);
}

// ── Randomized: churn across restarts, the delta keeps no stale row ───────
{
  let x = 12345;
  const rand = (n) => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x % n; };
  const { harness, raw, vfs } = open();
  vfs.mkdir('w', { recursive: true });
  for (let d = 0; d < 6; d++) vfs.mkdir(`w/d${d}`);
  for (let i = 0; i < 120; i++) vfs.writeFile(`w/d${i % 6}/f${i}`, `seed ${i}`);
  let state = { harness, raw, vfs };
  const resident = residentFrom(raw, vfs);
  let deltas = 0;
  for (let round = 0; round < 30; round++) {
    const { vfs: v } = state;
    for (let k = 0; k < 15; k++) {
      const dir = `w/d${rand(6)}`;
      if (!v.exists(dir)) v.mkdir(dir);
      const path = `${dir}/f${rand(160)}`;
      switch (rand(5)) {
        case 0: case 1: v.writeFile(path, `r${round} k${k}`); break;
        case 2: if (v.exists(path)) v.unlink(path); break;
        case 3: if (v.isFile(path) && !v.exists(`${path}m`)) v.rename(path, `${path}m`); break;
        default: if (v.isFile(path)) v.writeRange(path, 0, enc.encode(`e${round}`)); break;
      }
    }
    if (round % 7 === 3) { v.mkdir(`w/n${round}`); v.writeFile(`w/n${round}/x`, 'n'); v.rename(`w/n${round}`, `w/m${round}`); }
    if (round % 11 === 5) v.removeRecursive(`w/d${rand(6)}`);
    if (round % 3 === 0) state = reopen(state.harness);
    const delta = state.raw.invalidatedSince(resident.cursor.epoch, resident.cursor.rev);
    assert.equal(admit(resident, delta), 'delta', `round ${round}: a cursor from before a restart gets a delta`);
    deltas++;
    assertNoStaleRow(resident, state.vfs, `round ${round}`);
    // Refill what the reader lacks, dated as list reports it.
    for (const entry of listAll(state.raw).entries) {
      if (entry.kind === 'file' && !resident.rows.has(entry.path)) {
        resident.rows.set(entry.path, { rev: entry.rev, bytes: dec.decode(state.vfs.readFile(entry.path)) });
      }
    }
  }
  assert.equal(deltas, 30);
}

// ── Restore reports what it put back and what it removed ──────────────────
{
  const { harness, raw, vfs } = open();
  vfs.writeFile('keep', 'k1');
  vfs.writeFile('gone', 'g1');
  raw.snapshot('s');
  vfs.writeFile('keep', 'k2');
  vfs.unlink('gone');
  vfs.writeFile('new', 'n');
  const resident = residentFrom(raw, vfs);
  const next = reopen(harness);
  next.raw.restore('s');
  admit(resident, next.raw.invalidatedSince(resident.cursor.epoch, resident.cursor.rev));
  assertNoStaleRow(resident, next.vfs, 'after restore');
  assert.ok(!resident.rows.has('new') && !resident.rows.has('keep'));
}

// ── Below the tombstone floor, a cursor poisons ───────────────────────────
{
  const { harness, raw, vfs } = open(undefined, { tombstoneRows: 8 });
  for (let i = 0; i < 40; i++) vfs.writeFile(`t${i}`, 'x');
  const cursor = { epoch: raw.epoch, rev: raw.revision() };
  for (let i = 0; i < 40; i++) vfs.unlink(`t${i}`);
  const next = reopen(harness, { tombstoneRows: 8 });
  for (let pass = 0; next.raw.runContentMaintenance(64).transactions > 0; pass++) assert.ok(pass < 100);
  assert.ok(harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_tombstones')[0].n <= 8, 'tombstones are pruned to the retention');
  assert.equal(next.raw.invalidatedSince(cursor.epoch, cursor.rev).poison, true, 'a pruned deletion cannot be described');
  // A cursor past the floor is still answered.
  const later = { epoch: next.raw.epoch, rev: next.raw.revision() };
  next.vfs.writeFile('t0', 'back');
  const fresh = reopen(harness, { tombstoneRows: 8 });
  assert.deepEqual(fresh.raw.invalidatedSince(later.epoch, later.rev).paths.map((p) => p.path), ['t0']);
}

// ── A delta too large for one answer poisons rather than truncating ───────
{
  const { harness, raw, vfs } = open();
  vfs.mkdir('big');
  const cursor = { epoch: raw.epoch, rev: raw.revision() };
  for (let i = 0; i < 17_040; i += 60) {
    vfs.writeBatch({
      inodes: Array.from({ length: 60 }, (_, k) => ({ path: `big/f${i + k}`, parentPath: 'big', isDir: false, size: 1, mtime: 1, mode: 0o644, chunkCount: 1 })),
      chunks: Array.from({ length: 60 }, (_, k) => ({ path: `big/f${i + k}`, chunkId: 0, data: enc.encode('x') })),
    });
  }
  const next = reopen(harness);
  assert.equal(next.raw.invalidatedSince(cursor.epoch, cursor.rev).poison, true);
}

// ── A rename that fails part-way publishes every group it committed ──────
{
  const { harness, raw, vfs } = open();
  vfs.mkdir('src');
  for (let i = 0; i < 2000; i += 60) {
    vfs.writeBatch({
      inodes: Array.from({ length: 60 }, (_, k) => ({ path: `src/f${i + k}`, parentPath: 'src', isDir: false, size: 1, mtime: 1, mode: 0o644, chunkCount: 1 })),
      chunks: Array.from({ length: 60 }, (_, k) => ({ path: `src/f${i + k}`, chunkId: 0, data: enc.encode('x') })),
    });
  }
  const cursor = { epoch: raw.epoch, rev: raw.revision() };
  const start = harness.transactionCount;
  // Fault the last transaction the rename would commit: every group before it is durable.
  harness.failAfterTransaction({ transaction: start + 4, error: new Error('reset mid-rename') });
  assert.throws(() => vfs.rename('src', 'dst'), /reset mid-rename/);
  harness.clearFault();
  const visible = new Set(harness.sql.exec("SELECT path FROM vfs_inodes WHERE path LIKE 'dst/%'").map((row) => row.path));
  const gone = harness.sql.exec("SELECT COUNT(*) AS n FROM vfs_inodes WHERE path LIKE 'src/%'")[0].n;
  const delta = raw.invalidatedSince(cursor.epoch, cursor.rev);
  assert.equal(delta.poison, false);
  const reported = new Set(delta.paths.map((entry) => entry.path));
  for (const path of visible) assert.ok(reported.has(path), `${path} is visible but unreported`);
  if (gone < 2000) for (let i = 0; i < 2000; i++) if (!vfs.exists(`src/f${i}`)) assert.ok(reported.has(`src/f${i}`), `src/f${i} vanished unreported`);
}

// ── rotateIncarnation poisons every held cursor ───────────────────────────
{
  const { raw, vfs } = open();
  vfs.writeFile('f', 'x');
  const cursor = { epoch: raw.epoch, rev: raw.revision() };
  const epoch = raw.rotateIncarnation();
  assert.notEqual(epoch, cursor.epoch);
  assert.equal(raw.invalidatedSince(cursor.epoch, cursor.rev).poison, true);
}

console.log('sqlite-vfs-durable-clock: all assertions passed');
