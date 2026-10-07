#!/usr/bin/env bun
// The resident store's two backings answer alike. The store decides and
// its tables only store: __residentTablesOnSql (a process facet's SQLite)
// and __residentTablesInMemory (a one-shot's heap) sit behind the same
// operations. Seeded random sequences of those operations (puts,
// deletes, revision changes, the dated drops, chunk copies, namespace
// edits) run on both, and every answer must be equal: rows, key order,
// byte content and counts.
//
// The one thing allowed to differ is bytes(): SQLite counts pages, the
// heap counts its rows and payload. The in-memory backing's own count is
// checked against a direct sum of what it holds.

import assert from 'node:assert/strict';

import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const STORE_API = 'onSql: __residentTablesOnSql, inMemory: __residentTablesInMemory, OWN: __RK_OWN_WRITE, ROW: __RESIDENT_ROW_BYTES,'
  + ' nsReady: __nsReady, markReady: __nsMarkReady, replaceNamespace: __nsReplace, LINK: __NS_LINK,'
  + ' utf8: __residentUtf8Length, prefixEnd: __residentPrefixEnd, bindInMemory: __residentBindInMemory,'
  + ' adopt: __residentAdoptModuleBundle, fill: __residentFill, get: __residentGet, setStorage: __residentSetStorage,'
  + ' storageMiss: __residentStorageMiss, bytes: __residentDbBytes, bundle: __nimbusResidentBundle, heldMax: __RESIDENT_HELD_MAX_BYTES';
/** The shipped store source in a fresh module scope: one store per call. */
const freshStore = () => new Function(`${FACET_RESIDENT_STORE_SOURCE}\nreturn { ${STORE_API} };`)();
const store = freshStore();

/** A row as a plain value: blobs as byte arrays, whichever form the backing returned. */
function plain(value) {
  if (value === undefined || value === null) return value ?? null;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = plain(value[key]);
    return out;
  }
  return value;
}

function prng(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

// Names chosen to sit on the edges a range scan has: a prefix and its
// extension, the byte just past '/', and a name past the BMP.
// U+E000 and U+FFFD sort above a surrogate pair in UTF-16 and below it in
// UTF-8, which is SQLite's order.
const PATHS = ['a', 'a/b', 'a/b/c', 'a/bc', 'a0', 'a.', 'ab', 'b', 'b/x', 'é/f', '😀', '😀/g', '\ue000', '\ue000/h', '\ufffd', 'z'];
const DIRS = ['', 'a', 'a/b', 'b', '😀', '\ue000'];
const NAMES = ['x', 'y', 'b', 'é', '😀', '\ue000', '\ufffd'];
const REVS = () => [store.OWN, 0, 3, 7];

const reads = (t, rand) => {
  const path = PATHS[Math.floor(rand() * PATHS.length)];
  const from = PATHS[Math.floor(rand() * PATHS.length)];
  const prefix = `${from}/`;
  const to = store.prefixEnd(prefix);
  const parent = DIRS[Math.floor(rand() * DIRS.length)];
  return {
    head: t.fileHead(path), rev: t.fileRev(path), revKey: t.fileRevKey(path), ownSize: t.fileOwnSize(path),
    first: t.chunkFirst(path), parts: t.chunkParts(path),
    paths: t.filePaths(prefix, to), any: t.fileAny(prefix, to), revs: t.fileRevsIn(prefix, to),
    open: t.filePaths(from, null),
    all: t.fileAllPaths(), rows: t.fileRows(), own: t.fileOwnPaths(), stats: t.fileStats(),
    byKey: t.fileByKey('k1', path),
    meta: [t.metaGet('epoch'), t.metaGet('ns')],
    ns: t.nsGet(parent, NAMES[Math.floor(rand() * NAMES.length)]), children: t.nsChildren(parent),
    keys: t.nsKeys(), links: t.nsOfKind(2), count: t.nsCount(),
  };
};

function step(t, op) {
  switch (op[0]) {
    case 'filePut': t.filePut(...op.slice(1)); break;
    case 'fileSetRev': t.fileSetRev(op[1], op[2]); break;
    case 'fileStampOwn': t.fileStampOwn(op[1], op[2]); break;
    case 'fileDelete': t.fileDelete(op[1]); break;
    case 'chunkAddText': t.chunkAddText(op[1], op[2], op[3]); break;
    case 'chunkAddBin': t.chunkAddBin(op[1], op[2], op[3]); break;
    case 'chunkSetBin': t.chunkSetBin(op[1], op[2], op[3]); break;
    case 'chunkCopy': t.chunkCopy(op[1], op[2]); break;
    case 'chunkDelete': t.chunkDelete(op[1]); break;
    case 'dropOwn': t.dropOwn(); break;
    case 'dropDated': t.dropDated(); break;
    case 'dropDatedFiles': t.dropDatedFiles(); break;
    case 'clear': t.clear(); break;
    case 'metaSet': t.metaSet(op[1], op[2]); break;
    case 'nsPut': t.nsPut(...op.slice(1)); break;
    case 'nsDelete': t.nsDelete(op[1], op[2]); break;
    case 'nsDeleteChildren': t.nsDeleteChildren(op[1]); break;
    case 'nsDeleteParents': t.nsDeleteParents(op[1], op[2]); break;
    case 'nsClear': t.nsClear(); break;
    default: throw new Error(`unknown op ${op[0]}`);
  }
}

function randomOp(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const path = pick(PATHS);
  const bytes = () => new Uint8Array(Array.from({ length: 1 + Math.floor(rand() * 5) }, () => Math.floor(rand() * 256)));
  const r = rand();
  if (r < 0.16) return ['filePut', path, Math.floor(rand() * 3), Math.floor(rand() * 9), 1 + Math.floor(rand() * 2), pick(REVS()), rand() < 0.4 ? pick(['k1', 'k2']) : null];
  if (r < 0.22) return ['fileSetRev', path, pick(REVS())];
  if (r < 0.26) return ['fileStampOwn', path, pick([2, 5])];
  if (r < 0.31) return ['fileDelete', path];
  if (r < 0.39) return ['chunkAddText', path, Math.floor(rand() * 3), pick(['', 'text', 'é😀', 'x'.repeat(40)])];
  if (r < 0.46) return ['chunkAddBin', path, Math.floor(rand() * 3), bytes()];
  if (r < 0.51) return ['chunkSetBin', path, Math.floor(rand() * 3), bytes()];
  if (r < 0.54) return ['chunkCopy', path, pick(PATHS)];
  if (r < 0.58) return ['chunkDelete', path];
  if (r < 0.60) return ['dropOwn'];
  if (r < 0.62) return ['dropDated'];
  if (r < 0.64) return ['dropDatedFiles'];
  if (r < 0.645) return ['clear'];
  if (r < 0.67) return ['metaSet', pick(['epoch', 'ns']), pick(['0', '1', 'e2'])];
  if (r < 0.82) return ['nsPut', pick(DIRS), pick(NAMES), pick([0, 1, 2]), 7, 0o644, 1000, 1000, 1.5, 2.5, 3.5, 11, pick([0, 4]), rand() < 0.3 ? 'target' : null];
  if (r < 0.88) return ['nsDelete', pick(DIRS), pick(NAMES)];
  if (r < 0.92) return ['nsDeleteChildren', pick(DIRS)];
  if (r < 0.97) { const prefix = `${pick(DIRS)}/`; return ['nsDeleteParents', prefix, store.prefixEnd(prefix)]; }
  return ['nsClear'];
}

/** What the in-memory backing holds, summed directly: its bytes() must equal it. */
function heldBytes(t) {
  let total = t.fileAllPaths().length * store.ROW;
  for (const path of new Set([...t.fileAllPaths(), ...PATHS])) {
    for (const cell of t.chunkParts(path)) total += store.ROW + (cell.txt != null ? store.utf8(cell.txt) : cell.bin ? cell.bin.byteLength : 0);
  }
  for (const { parent, name } of t.nsKeys()) {
    const row = t.nsGet(parent, name);
    total += store.ROW + 2 * (parent.length + name.length + (row.target?.length ?? 0));
  }
  return total;
}

const SEQUENCES = 300;
const STEPS = 120;
let compared = 0;
for (let seed = 1; seed <= SEQUENCES; seed++) {
  const rand = prng(seed);
  const sql = store.onSql(createSqliteVfsTestHarness().sql);
  const heap = store.inMemory();
  const ops = [];
  for (let i = 0; i < STEPS; i++) {
    const op = randomOp(rand);
    ops.push(op);
    let sqlError = null;
    let heapError = null;
    try { step(sql, op); } catch (error) { sqlError = String(error.message).includes('UNIQUE') ? 'unique' : String(error.message).includes('CHECK') ? 'check' : error.message; }
    try { step(heap, op); } catch (error) { heapError = String(error.message).includes('UNIQUE') ? 'unique' : String(error.message).includes('CHECK') ? 'check' : error.message; }
    const where = () => `seed ${seed} step ${i}: ${JSON.stringify(ops.slice(-6), (_k, v) => (v instanceof Uint8Array ? [...v] : v))}`;
    assert.equal(heapError, sqlError, `${where()}: the backings fail differently`);
    const readSeed = Math.floor(rand() * 2 ** 31);
    const fromHeap = plain(reads(heap, prng(readSeed)));
    const fromSql = plain(reads(sql, prng(readSeed)));
    for (const key of Object.keys(fromSql)) {
      assert.deepEqual(fromHeap[key], fromSql[key], `${where()}: the backings answer ${key} differently: heap ${JSON.stringify(fromHeap[key])}, sqlite ${JSON.stringify(fromSql[key])}`);
    }
    assert.equal(heap.bytes(), heldBytes(heap), `${where()}: the heap's byte count is not what it holds`);
    compared++;
  }
}

// A read hands back a copy: writing into it changes nothing held.
{
  const heap = store.inMemory();
  heap.chunkAddBin('p', 0, new Uint8Array([1, 2, 3]));
  heap.chunkFirst('p').bin[0] = 9;
  assert.deepEqual([...heap.chunkFirst('p').bin], [1, 2, 3], 'a read is a copy');
}

// The heap backing's budget, one for everything a one-shot holds: the
// store's tables and the own writes held beside them. Near it the store
// degrades as the durable one does near the session's limit. A fill that does
// not fit is refused, so the read is an honest miss. An own write is held if
// it fits what the cap leaves and reads back; one that does not fit is named
// storage (ENOSPC in the shims). The total never exceeds the budget, and no
// ledger is asked: the heap has no row there to grow.
{
  const s = freshStore();
  const BUDGET = 256 * 1024;
  s.bindInMemory(BUDGET);
  let grants = 0;
  s.setStorage(undefined, { fsStorageGrant: async () => { grants++; return { granted: 1 << 30 }; } });
  s.adopt({}, { epoch: 'e', rev: 1 });
  const text = (n, c) => c.repeat(n);
  assert.equal(s.fill('home/user/a.txt', text(64 * 1024, 'a'), 2), true, 'a fill within the budget is held');
  assert.equal(s.get('home/user/a.txt'), text(64 * 1024, 'a'));
  assert.equal(s.fill('home/user/big.txt', text(512 * 1024, 'b'), 2), false, 'a fill past the budget is refused');
  assert.equal(s.get('home/user/big.txt'), undefined, 'and its read is a miss, not partial bytes');
  // Own writes: the first fits what is left and is held; the second does not.
  s.bundle['home/user/mine.bin'] = new Uint8Array(96 * 1024).fill(7);
  assert.equal(s.get('home/user/mine.bin')?.[0], 7, 'an own write that fits what the budget leaves reads back');
  assert.equal(s.storageMiss('home/user/mine.bin'), false);
  assert.ok(s.bytes() <= BUDGET, `tables and held writes hold ${s.bytes()} B, within the ${BUDGET} B budget`);
  s.bundle['home/user/more.bin'] = new Uint8Array(160 * 1024).fill(9);
  assert.equal(s.storageMiss('home/user/more.bin'), true, 'one that does not fit is named the storage\'s (ENOSPC), not EAGAIN');
  assert.ok(s.bytes() <= BUDGET, `and the total stays ${s.bytes()} B, within the budget`);
  assert.ok(s.heldMax > BUDGET, 'the facet\'s own held bound is not what limits a one-shot');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(grants, 0, 'the heap backing never asks the ledger for room');
}

// Namespace replacements charge deltas, not a second row or inode; text and
// link-target growth count before storage admits the row.
{
  const s = freshStore();
  const t = s.bindInMemory(4096);
  s.markReady(t, true);
  const put = (name, target) => t.nsPut('home/user', name, s.LINK, target.length, 0o120777, 1000, 1000, 0, 0, 0, 7, 1, target);
  put('link', 'x'.repeat(500));
  const initial = s.bytes();
  for (let i = 0; i < 20; i++) put('link', 'x'.repeat(500));
  assert.equal(s.bytes(), initial, 'upsert does not double charge');
  assert.equal(t.nsCount(), 1);
  put('link', 'short');
  assert.ok(s.bytes() < initial, 'shorter target releases its text cost');
  const before = s.bytes();
  assert.throws(() => put('link', 'x'.repeat(4096)), error => error.code === 'ENOSPC');
  assert.equal(s.bytes(), before, 'refused growth changes no stored bytes');
  assert.equal(t.nsGet('home/user', 'link').target, 'short');
  assert.equal(s.nsReady(), false, 'a refused namespace update is never a ready partial view');
  t.nsDelete('home/user', 'link');
  assert.equal(t.nsCount(), 0);
  assert.equal(t.nsBytes(), 0);
  assert.equal(s.bytes(), 0);
}

{
  const s = freshStore();
  const t = s.bindInMemory(2800);
  s.markReady(t, true);
  const row = (name, target) => ({ path: 'home/user/' + name, rev: 1, linkTarget: target,
    stat: { type: 'symlink', size: target.length, mode: 0o120777, uid: 1000, gid: 1000, atime: 0, mtime: 0, ctime: 0, ino: 1 } });
  s.replaceNamespace(t, [row('a', 'x'), row('b', 'x'.repeat(1000))]);
  const bytes = s.bytes();
  s.replaceNamespace(t, [row('a', 'y'.repeat(1000)), row('b', 'y')]);
  assert.equal(t.nsGet('home/user', 'a').target, 'y'.repeat(1000));
  assert.equal(t.nsGet('home/user', 'b').target, 'y');
  assert.equal(s.bytes(), bytes, 'same-size namespace replacement is admitted independent of row order');
  assert.equal(t.nsCount(), 2);
}

console.log(`resident-store-backings: ${compared} states compared across ${SEQUENCES} sequences; the heap answers as SQLite does`);
