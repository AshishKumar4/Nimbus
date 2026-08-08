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
import { Database } from 'bun:sqlite';
import {
  FACET_RESIDENT_STORE_SOURCE,
  RESIDENT_CHUNK_BYTES,
} from '../../packages/worker/src/vfs/facet-resident-store.ts';

/** workerd's `ctx.storage.sql`: exec(query, ...params) → synchronous cursor. */
function sqlShim() {
  const db = new Database(':memory:');
  return {
    exec(query, ...params) {
      const normalized = params.map((p) => (p instanceof Uint8Array ? p : p));
      if (/^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE)/i.test(query)) {
        db.query(query).run(...normalized);
        return [];
      }
      return db.query(query).all(...normalized);
    },
    get databaseSize() { return 0; },
  };
}

/** Evaluate the shipped source and hand back its internals. */
function loadStore() {
  const factory = new Function(
    FACET_RESIDENT_STORE_SOURCE
      + '\nreturn { __residentBind, __residentAdmit, __residentPopulate, __residentClear,'
      + ' __residentStamp, __residentCursor, __residentStats, __residentKeysUnder,'
      + ' __residentSeal, bundle: __nimbusResidentBundle };',
  );
  const store = factory();
  store.__residentBind({ storage: { sql: sqlShim() } });
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
  s.__residentAdmit(CURSOR);
  s.bundle['a'] = 'x';
  assert.equal(s.bundle['a'], 'x');
}

{
  const s = loadStore();
  assert.throws(
    () => s.__residentAdmit({ poison: false, paths: [] }),
    /no cursor/,
    'an acquire result with no cursor must leave the store sealed',
  );
  assert.throws(() => s.bundle['a'], /sealed/, 'still sealed after a refused admit');
}

// ── provenance is mandatory ─────────────────────────────────────────────────

{
  const s = loadStore();
  s.__residentAdmit(CURSOR);
  assert.throws(
    () => s.__residentPopulate('a.txt', 'A', undefined),
    /no authority revision/,
    'an undated row cannot be invalidated, so it must not be writable',
  );
  s.__residentPopulate('a.txt', 'A', 7);
  assert.equal(s.bundle['a.txt'], 'A');
}

// ── cell shapes round-trip exactly ──────────────────────────────────────────

{
  const s = loadStore();
  s.__residentAdmit(CURSOR);
  const bin = new Uint8Array([0, 1, 2, 250, 255]);
  s.__residentPopulate('t.txt', 'café — 日本語', 7);
  s.__residentPopulate('b.bin', bin, 7);
  s.__residentPopulate('d', { error: 'EACCES' }, 7);

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
  s.__residentAdmit(CURSOR);
  const big = new Uint8Array(RESIDENT_CHUNK_BYTES * 2 + 1234);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 0xff;
  s.__residentPopulate('big.bin', big, 7);
  const got = s.bundle['big.bin'];
  assert.equal(got.byteLength, big.length, 'a chunked file reassembles to its size');
  assert.deepEqual(got, big, 'and to its exact bytes');

  const bigText = 'ü'.repeat(RESIDENT_CHUNK_BYTES);
  s.__residentPopulate('big.txt', bigText, 7);
  assert.equal(s.bundle['big.txt'], bigText, 'chunked text reassembles exactly');
}

// ── the ACQUIRE delta ───────────────────────────────────────────────────────

{
  const s = loadStore();
  s.__residentAdmit(CURSOR);
  s.__residentPopulate('a.txt', 'A@7', 7);
  s.__residentPopulate('b.txt', 'B@7', 7);
  s.__residentPopulate('c.txt', 'C@7', 7);
  s.__residentStamp('c.txt', 9); // this facet's own flushed write

  const applied = s.__residentAdmit({
    poison: false,
    epoch: 'e1',
    rev: 9,
    paths: [{ path: 'a.txt', rev: 8 }, { path: 'c.txt', rev: 9 }],
  });

  assert.deepEqual(applied.dropped, ['a.txt'], 'a peer write evicts');
  assert.equal(s.bundle['a.txt'], undefined);
  assert.equal(s.bundle['b.txt'], 'B@7', 'an unnamed path is untouched');
  assert.equal(s.bundle['c.txt'], 'C@7', "the facet's own write survives its own invalidation");
  assert.deepEqual(applied.cursor, { epoch: 'e1', rev: 9 });

  s.__residentAdmit({ poison: true, epoch: 'e2', rev: 0 });
  assert.equal(s.__residentStats().files, 0, 'poison drops everything');
  assert.deepEqual(s.__residentCursor(), { epoch: 'e2', rev: 0 });
}

// ── slot handover ───────────────────────────────────────────────────────────

{
  const s = loadStore();
  s.__residentAdmit(CURSOR);
  s.__residentPopulate('tenant/a.txt', 'previous tenant', 7);
  s.__residentClear();
  assert.equal(s.__residentStats().files, 0, 'a returned slot keeps no files');
  assert.equal(s.__residentCursor(), null, 'and no cursor to vouch for them');
  assert.throws(
    () => s.bundle['tenant/a.txt'],
    /sealed/,
    'a cleared slot re-seals, so the next tenant cannot read through it',
  );
}

// ── prefix scan ─────────────────────────────────────────────────────────────

{
  const s = loadStore();
  s.__residentAdmit(CURSOR);
  for (const p of ['home/u/a.js', 'home/u/deep/b.js', 'home/user2/c.js', 'var/d.js']) {
    s.__residentPopulate(p, 'x', 7);
  }
  assert.deepEqual(
    s.__residentKeysUnder('home/u/').sort(),
    ['home/u/a.js', 'home/u/deep/b.js'],
    'a prefix scan must not leak the sibling directory home/user2',
  );
  assert.deepEqual(s.__residentKeysUnder('var/').sort(), ['var/d.js']);
  assert.deepEqual(s.__residentKeysUnder('nothing/').sort(), []);
}

// ── a path with SQL LIKE metacharacters ─────────────────────────────────────

{
  const s = loadStore();
  s.__residentAdmit(CURSOR);
  s.__residentPopulate('od%d/a.js', 'x', 7);
  s.__residentPopulate('odxd/b.js', 'y', 7);
  assert.deepEqual(
    s.__residentKeysUnder('od%d/').sort(),
    ['od%d/a.js'],
    "'%' in a real path must be a literal, not a wildcard",
  );
}

console.log('facet-resident-store: ok');
