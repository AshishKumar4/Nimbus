#!/usr/bin/env bun

/**
 * facet-resident-store — the in-facet store that serves synchronous reads out
 * of a process facet's own SQLite.
 *
 * Driven against a REAL SQLite (bun:sqlite) behind a shim of workerd's
 * `ctx.storage.sql` surface, so the SQL is executed rather than asserted about.
 * A fake that returned canned rows would pass with the schema deleted.
 *
 * The seal cases matter most: the store's whole coherence claim is that a row
 * cannot be served by an incarnation that has not reconciled with the
 * authority, and that a row with no revision cannot be written at all.
 */

import assert from 'node:assert/strict';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { kvTables } from '../../packages/worker/src/vfs/resident/kv-tables.ts';
import { facetSql } from './lib/resident-body.mjs';
import { facetStorage } from './lib/fake-do-kv.mjs';
import { RESIDENT_CHUNK_BYTES } from '../../packages/worker/src/vfs/facet-resident-limits.ts';

/** A fresh typed store over its own facet storage; `meter` counts its reads and the file content they hand back. */
function loadStore(meter = undefined) {
  const store = createResidentStore();
  store.bind({ storage: facetStorage(facetSql(), { meter }) });
  return store;
}

const CURSOR = { poison: false, paths: [], epoch: 'e1', rev: 7 };

// ── the seal ────────────────────────────────────────────────────────────────

{
  const s = loadStore();
  assert.throws(
    () => s.bundle['anything'],
    /sealed/,
    'a store that has not reconciled must refuse to serve a row',
  );
  assert.throws(() => { s.bundle['a'] = 'x'; }, /sealed/, 'writes are sealed too');
  // …and the seal is genuinely liftable, so the check above is not vacuous.
  s.cells.admit(CURSOR);
  s.bundle['a'] = 'x';
  assert.equal(s.bundle['a'], 'x');
}

{
  const s = loadStore();
  assert.throws(
    () => s.cells.admit({ poison: false, paths: [] }),
    /no cursor/,
    'an acquire result with no cursor must leave the store sealed',
  );
  assert.throws(() => s.bundle['a'], /sealed/, 'still sealed after a refused admit');
}

// ── provenance is mandatory ─────────────────────────────────────────────────

{
  const s = loadStore();
  s.cells.admit(CURSOR);
  assert.throws(
    () => s.cells.fill('a.txt', 'A', undefined),
    /no authority revision/,
    'an undated row cannot be invalidated, so it must not be writable',
  );
  s.cells.fill('a.txt', 'A', 7);
  assert.equal(s.bundle['a.txt'], 'A');
}

// ── cell shapes round-trip exactly ──────────────────────────────────────────

{
  const s = loadStore();
  s.cells.admit(CURSOR);
  const bin = new Uint8Array([0, 1, 2, 250, 255]);
  s.cells.fill('t.txt', 'café — 日本語', 7);
  s.cells.fill('b.bin', bin, 7);
  s.cells.fill('d', { error: 'EACCES' }, 7);

  assert.equal(s.bundle['t.txt'], 'café — 日本語', 'multi-byte text survives');
  assert.deepEqual(s.bundle['b.bin'], bin, 'binary stays binary');
  assert.deepEqual(s.bundle['d'], { error: 'EACCES' }, 'a denial stays a denial');
  assert.equal(s.bundle['nope'], undefined);
  assert.equal('nope' in s.bundle, false);
  assert.equal('t.txt' in s.bundle, true);
  assert.deepEqual(Object.keys(s.bundle).sort(), ['b.bin', 'd', 't.txt']);

  delete s.bundle['d'];
  assert.equal('d' in s.bundle, false, 'delete removes the row');
}

// ── chunking past the single-value ceiling ──────────────────────────────────

{
  const s = loadStore();
  s.cells.admit(CURSOR);
  const big = new Uint8Array(RESIDENT_CHUNK_BYTES * 2 + 1234);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 0xff;
  s.cells.fill('big.bin', big, 7);
  const got = /** @type {Uint8Array} */ (s.bundle['big.bin']);
  assert.equal(got.byteLength, big.length, 'a chunked file reassembles to its size');
  assert.deepEqual(got, big, 'and to its exact bytes');

  const bigText = 'ü'.repeat(RESIDENT_CHUNK_BYTES);
  s.cells.fill('big.txt', bigText, 7);
  assert.equal(s.bundle['big.txt'], bigText, 'chunked text reassembles exactly');
}

// ── the ACQUIRE delta ───────────────────────────────────────────────────────

{
  const s = loadStore();
  s.cells.admit(CURSOR);
  s.cells.fill('a.txt', 'A@7', 7);
  s.cells.fill('b.txt', 'B@7', 7);
  s.cells.fill('e.txt', 'E@7', 7);
  s.bundle['c.txt'] = 'C-mine'; // this facet's own write…
  s.cells.stamp('c.txt', 9); // …flushed at the revision it produced
  s.cells.stamp('b.txt', 99); // an acknowledgement dates own bytes, never a row it did not write
  s.bundle['d.txt'] = 'D-unflushed'; // own bytes the authority has not acknowledged

  const applied = s.cells.admit({
    poison: false,
    epoch: 'e1',
    rev: 10,
    paths: [
      { path: 'a.txt', rev: 8 },
      { path: 'b.txt', rev: 10 },
      { path: 'c.txt', rev: 9 },
      { path: 'd.txt', rev: 10 },
    ],
  });

  assert.deepEqual(applied.dropped.sort(), ['a.txt', 'b.txt'], 'a peer write evicts, whatever was stamped');
  assert.equal(s.bundle['a.txt'], undefined);
  assert.equal(s.bundle['e.txt'], 'E@7', 'an unnamed path is untouched');
  assert.equal(s.bundle['c.txt'], 'C-mine', "the facet's own write survives its own report");
  assert.equal(s.bundle['d.txt'], 'D-unflushed', 'unacknowledged own bytes survive any report');
  assert.deepEqual(applied.cursor, { epoch: 'e1', rev: 10 });

  s.cells.admit({ poison: true, epoch: 'e2', rev: 0 });
  assert.deepEqual(
    Object.keys(s.bundle),
    ['d.txt'],
    'a poison drops every row the authority dated, and none of the own bytes it never saw',
  );
  assert.deepEqual(s.coherence.cursor(), { epoch: 'e2', rev: 0 });
}

// ── slot handover ───────────────────────────────────────────────────────────

{
  const s = loadStore();
  s.cells.admit(CURSOR);
  s.cells.fill('tenant/a.txt', 'previous tenant', 7);
  s.cells.clear();
  assert.equal(s.cells.stats().files, 0, 'a returned slot keeps no files');
  assert.equal(s.coherence.cursor(), null, 'and no cursor to vouch for them');
  assert.throws(
    () => s.bundle['tenant/a.txt'],
    /sealed/,
    'a cleared slot re-seals, so the next tenant cannot read through it',
  );
}

// ── prefix scan ─────────────────────────────────────────────────────────────

{
  const s = loadStore();
  s.cells.admit(CURSOR);
  for (const p of ['home/u/a.js', 'home/u/deep/b.js', 'home/user2/c.js', 'var/d.js']) {
    s.cells.fill(p, 'x', 7);
  }
  assert.deepEqual(
    s.cells.keysUnder('home/u/').sort(),
    ['home/u/a.js', 'home/u/deep/b.js'],
    'a prefix scan must not leak the sibling directory home/user2',
  );
  assert.deepEqual(s.cells.keysUnder('var/').sort(), ['var/d.js']);
  assert.deepEqual(s.cells.keysUnder('nothing/').sort(), []);
}

// ── a path with SQL LIKE metacharacters ─────────────────────────────────────

{
  const s = loadStore();
  s.cells.admit(CURSOR);
  s.cells.fill('od%d/a.js', 'x', 7);
  s.cells.fill('odxd/b.js', 'y', 7);
  assert.deepEqual(
    s.cells.keysUnder('od%d/').sort(),
    ['od%d/a.js'],
    "'%' in a real path must be a literal, not a wildcard",
  );
}

// ── a name question must never read the filesystem ──────────────────────────
//
// The shims ask "is anything held under this directory" constantly — node's own
// module resolution does it per candidate path. Answered through the object
// protocol (`for..in`, `Object.keys`) that question walks every key AND, via
// the descriptor trap, reads every file's BYTES. Measured on a pi-shaped store
// of 19,470 files / 95 MiB: 222 ms, 17,821 chunk queries and 87 MiB read and
// discarded, per call. At a 30 s CPU budget that is 135 calls to exhaustion,
// which is what took an agent turn past the limit. The index answers the same
// question without touching content at all.

{
  const meter = { reads: 0, contentBytes: 0 };
  const s = loadStore(meter);
  s.cells.admit(CURSOR);
  const body = 'x'.repeat(4096);
  for (let i = 0; i < 400; i++) s.cells.fill(`usr/lib/node_modules/p${i % 20}/f${i}.js`, body, 7);
  for (let i = 0; i < 400; i++) s.cells.fill(`var/other/f${i}.js`, body, 7);

  meter.contentBytes = 0; meter.reads = 0;
  assert.equal(s.cells.hasUnder('usr/lib/node_modules/p3/'), true);
  assert.equal(meter.contentBytes, 0, 'a directory-existence question must read no file content');
  assert.equal(meter.reads, 1, 'and must be one read, not one per candidate path');

  meter.contentBytes = 0;
  assert.equal(s.cells.hasUnder('usr/lib/node_modules/nope/'), false);
  assert.equal(meter.contentBytes, 0, 'a negative answer must read no file content either');

  meter.contentBytes = 0;
  const under = s.cells.keysUnder('usr/lib/node_modules/p3/');
  assert.equal(meter.contentBytes, 0, 'listing a subtree must read no file content');
  assert.ok(under.length > 0 && under.every((k) => k.startsWith('usr/lib/node_modules/p3/')),
    'and must return exactly that subtree');

  // The descriptor trap is what turned key enumeration into a full read. Even
  // the whole-set walk — still used for watch globbing outside a cwd — must
  // cost names only.
  meter.contentBytes = 0;
  let walked = 0;
  for (const k of Object.keys(s.bundle)) { if (k.length) walked++; }
  assert.equal(walked, 800, 'the walk really did visit every key');
  assert.equal(meter.contentBytes, 0, 'enumerating keys must not materialize their bytes');

  // …and the bytes are still there for anything that actually reads one.
  assert.equal(s.bundle['var/other/f7.js'], body, 'a real read still returns the content');
  assert.ok(meter.contentBytes > 0, 'which is what makes the assertion above non-vacuous');
}

// ── a store that outlives its process ─────────────────────────────────────
//
// A store can outlive its process: a durable app-slot's, or one a new session
// incarnation re-attaches. Its
// authority rows are still dated and reconcile as usual, but the previous
// process's unflushed writes never reached the authority: they are not files.
{
  const storage = facetStorage(facetSql());
  const make = createResidentStore;
  const first = make();
  first.bind({ storage });
  first.cells.admit(CURSOR);
  first.cells.fill('lib/x.js', 'X', 5);
  first.bundle['tmp/unflushed.txt'] = 'never written back';
  // The rows the store left, read by a second binding over the same storage.
  const rows = kvTables(storage);
  assert.deepEqual(rows.fileAllPaths().sort(), ['lib/x.js', 'tmp/unflushed.txt']);

  const next = make();
  next.bind({ storage });
  assert.deepEqual(rows.fileAllPaths().sort(), ['lib/x.js'], 'the dead process\'s unflushed write is dropped; dated rows stay');
  assert.deepEqual(rows.chunkParts('tmp/unflushed.txt'), [], 'with its bytes');
}

// ── a subtree-scoped or structural report covers everything under it ───────
{
  const s = loadStore();
  s.cells.admit({ poison: false, paths: [], epoch: 'e1', rev: 5 });
  s.cells.fill('d/a.txt', 'A', 4);
  s.cells.fill('d/sub/b.txt', 'B', 6);
  s.cells.fill('dx.txt', 'X', 4);
  s.bundle['d/own.txt'] = 'mine';
  const applied = s.cells.admit({ poison: false, paths: [{ path: 'd', rev: 6, subtree: true }], epoch: 'e1', rev: 6 });
  assert.deepEqual(applied.dropped.sort(), ['d/a.txt'], 'a row under it stamped below the report goes');
  assert.equal(s.bundle['d/sub/b.txt'], 'B', 'a row stamped at the report stays');
  assert.equal(s.bundle['d/own.txt'], 'mine', "the facet's own bytes stay");
  assert.equal(s.bundle['dx.txt'], 'X', 'a sibling that only shares the prefix is not covered');
  s.cells.admit({ poison: false, paths: [{ path: 'd', rev: 7, structural: true }], epoch: 'e1', rev: 7 });
  assert.equal(s.bundle['d/sub/b.txt'], undefined, 'a structural report covers the subtree too');
}

console.log('facet-resident-store: ok');
