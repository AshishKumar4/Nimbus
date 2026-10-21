#!/usr/bin/env bun
// The resident store's two backings answer alike. The store decides and its
// tables only store: kvTables (a long-running process's, in its facet's
// key-value storage, written unconfirmed so the output gate holds nothing)
// and heapTables (a one-shot's heap) sit behind the same operations. Seeded
// random sequences of those operations (puts, deletes, revision changes, the
// dated drops, chunk copies, namespace edits) run on both, and every answer
// must be equal: rows, key order, byte content and counts.
//
// The one thing allowed to differ is bytes(): the facet's database counts
// what it stores, the heap counts its rows and payload. The heap's own count
// is checked against a direct sum of what it holds. Pages of big files (the
// page table: put, use, delete, the least recently used first) are among
// the operations.

import assert from 'node:assert/strict';

import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { heapTables, RK_OWN_WRITE } from '../../packages/worker/src/vfs/resident/tables.ts';
import { kvTables } from '../../packages/worker/src/vfs/resident/kv-tables.ts';
import { fakeDoKv } from './lib/fake-do-kv.mjs';
import { RESIDENT_ROW_BYTES, utf8Length } from '../../packages/worker/src/vfs/resident/cell-cost.ts';
import { prefixEnd } from '../../packages/worker/src/vfs/resident/namespace.ts';
import { FACET_OWN_WRITE_MEMORY_BYTES } from '../../packages/platform/src/limits.ts';

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
// UTF-8, the storage's order. And names holding the characters a key's
// encoding reserves (U+0001, and NUL below it), placed so a key that does not
// escape them aliases two rows: ('a', 'b\u0001c') and ('a\u0001b', 'c'), and
// 'a' scanned as a prefix of 'a\u0001b'.
const PATHS = ['a', 'a/b', 'a/b/c', 'a/bc', 'a0', 'a.', 'ab', 'b', 'b/x', 'é/f', '😀', '😀/g', '\ue000', '\ue000/h', '\ufffd', 'z',
  'a\u0001b', 'a\u0001b/c', 'a/b\u0001c', 'a\u0000', 'a\u0001\u0001'];
const DIRS = ['', 'a', 'a/b', 'b', '😀', '\ue000', 'a\u0001b', 'a\u0000'];
const NAMES = ['x', 'y', 'b', 'é', '😀', '\ue000', '\ufffd', 'c', 'b\u0001c', 'b\u0000', '\u0001'];
const REVS = () => [RK_OWN_WRITE, 0, 3, 7];

const reads = (t, rand) => {
  const path = PATHS[Math.floor(rand() * PATHS.length)];
  const from = PATHS[Math.floor(rand() * PATHS.length)];
  const prefix = `${from}/`;
  const to = prefixEnd(prefix);
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
    page: t.pageGet(path, pick3(rand), Math.floor(rand() * 3)), oldest: t.pageOldest(4), pageBytes: t.pageBytes(), pageUsed: t.pageMaxUsed(),
  };
};
const pick3 = (rand) => [3, 7, 9][Math.floor(rand() * 3)];

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
    case 'pagePut': return t.pagePut(op[1], op[2], op[3], op[4], op[5]);
    case 'pageUse': t.pageUse(op[1], op[2], op[3], op[4]); break;
    case 'pageDelete': t.pageDelete(op[1], op[2], op[3]); break;
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
  if (r < 0.96) { const prefix = `${pick(DIRS)}/`; return ['nsDeleteParents', prefix, prefixEnd(prefix)]; }
  if (r < 0.965) return ['nsClear'];
  // Stamps from a small range, so ties in 'used' are ordered by key.
  if (r < 0.985) return ['pagePut', path, pick3(rand), Math.floor(rand() * 3), bytes(), Math.floor(rand() * 6)];
  if (r < 0.993) return ['pageUse', path, pick3(rand), Math.floor(rand() * 3), Math.floor(rand() * 6)];
  return ['pageDelete', path, pick3(rand), Math.floor(rand() * 3)];
}

/** What the in-memory backing holds, summed directly: its bytes() must equal it. */
function heldBytes(t) {
  let total = t.fileAllPaths().length * RESIDENT_ROW_BYTES;
  for (const path of new Set([...t.fileAllPaths(), ...PATHS])) {
    for (const cell of t.chunkParts(path)) total += RESIDENT_ROW_BYTES + (cell.txt != null ? utf8Length(cell.txt) : cell.bin ? cell.bin.byteLength : 0);
  }
  for (const { parent, name } of t.nsKeys()) {
    const row = t.nsGet(parent, name);
    total += RESIDENT_ROW_BYTES + 2 * (parent.length + name.length + (row.target?.length ?? 0));
  }
  for (const row of t.pageOldest(1 << 20)) total += RESIDENT_ROW_BYTES + row.size;
  return total;
}

const SEQUENCES = 300;
const STEPS = 120;
let compared = 0;
for (let seed = 1; seed <= SEQUENCES; seed++) {
  const rand = prng(seed);
  const heap = heapTables();
  const kv = kvTables(fakeDoKv());
  const ops = [];
  for (let i = 0; i < STEPS; i++) {
    const op = randomOp(rand);
    ops.push(op);
    let heapError = null;
    let kvError = null;
    let heapAnswer;
    let kvAnswer;
    const failure = (error) => (String(error.message).includes('UNIQUE') ? 'unique' : String(error.message).includes('CHECK') ? 'check' : error.message);
    try { heapAnswer = step(heap, op); } catch (error) { heapError = failure(error); }
    try { kvAnswer = step(kv, op); } catch (error) { kvError = failure(error); }
    const where = () => `seed ${seed} step ${i}: ${JSON.stringify(ops.slice(-6), (_k, v) => (v instanceof Uint8Array ? [...v] : v))}`;
    assert.equal(kvError, heapError, `${where()}: the backings fail differently`);
    assert.equal(kvAnswer, heapAnswer, `${where()}: the backings answer the step differently`);
    const readSeed = Math.floor(rand() * 2 ** 31);
    const fromHeap = plain(reads(heap, prng(readSeed)));
    const fromKv = plain(reads(kv, prng(readSeed)));
    for (const key of Object.keys(fromHeap)) {
      assert.deepEqual(fromKv[key], fromHeap[key], `${where()}: the backings answer ${key} differently: kv ${JSON.stringify(fromKv[key])}, heap ${JSON.stringify(fromHeap[key])}`);
    }
    assert.equal(heap.bytes(), heldBytes(heap), `${where()}: the heap's byte count is not what it holds`);
    compared++;
  }
}

// A read hands back a copy: writing into it changes nothing held.
{
  const heap = heapTables();
  heap.chunkAddBin('p', 0, new Uint8Array([1, 2, 3]));
  heap.chunkFirst('p').bin[0] = 9;
  assert.deepEqual([.../** @type {Uint8Array} */ (heap.chunkFirst('p').bin)], [1, 2, 3], 'a read is a copy');
}

// The heap backing's budget, one for everything a one-shot holds: the
// store's tables and the own writes held beside them. Near it the store
// degrades as the durable one does near the session's limit. A fill that does
// not fit is refused, so the read is an honest miss. An own write is held if
// it fits what the cap leaves and reads back; one that does not fit is named
// storage (ENOSPC in the shims). The total never exceeds the budget, and no
// ledger is asked: the heap has no row there to grow.
{
  const s = createResidentStore();
  const BUDGET = 256 * 1024;
  s.bindInMemory(BUDGET);
  let grants = 0;
  s.admission.setStorage(undefined, { fsStorageGrant: async () => { grants++; return { granted: 1 << 30 }; } });
  s.sync.adoptModuleBundle({}, { epoch: 'e', rev: 1 });
  const text = (n, c) => c.repeat(n);
  assert.equal(s.cells.fill('home/user/a.txt', text(64 * 1024, 'a'), 2), true, 'a fill within the budget is held');
  assert.equal(s.cells.get('home/user/a.txt'), text(64 * 1024, 'a'));
  assert.equal(s.cells.fill('home/user/big.txt', text(512 * 1024, 'b'), 2), false, 'a fill past the budget is refused');
  assert.equal(s.cells.get('home/user/big.txt'), undefined, 'and its read is a miss, not partial bytes');
  // Own writes: the first fits what is left and is held; the second does not.
  s.bundle['home/user/mine.bin'] = new Uint8Array(96 * 1024).fill(7);
  assert.equal(s.cells.get('home/user/mine.bin')?.[0], 7, 'an own write that fits what the budget leaves reads back');
  assert.equal(s.cells.storageMiss('home/user/mine.bin'), false);
  assert.ok(s.admission.dbBytes() <= BUDGET, `tables and held writes hold ${s.admission.dbBytes()} B, within the ${BUDGET} B budget`);
  s.bundle['home/user/more.bin'] = new Uint8Array(160 * 1024).fill(9);
  assert.equal(s.cells.storageMiss('home/user/more.bin'), true, 'one that does not fit is named the storage\'s (ENOSPC), not EAGAIN');
  assert.ok(s.admission.dbBytes() <= BUDGET, `and the total stays ${s.admission.dbBytes()} B, within the budget`);
  assert.ok(FACET_OWN_WRITE_MEMORY_BYTES > BUDGET, 'the facet\'s own held bound is not what limits a one-shot');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(grants, 0, 'the heap backing never asks the ledger for room');
}

// Namespace replacements charge deltas, not a second row or inode; text and
// link-target growth count before storage admits the row.
{
  const s = createResidentStore();
  s.bindInMemory(4096);
  const t = s.coherence.heap;
  s.namespace.markReady(t, true);
  const put = (name, target) => s.namespace.put(t, 'home/user/' + name, {
    type: 'symlink', size: target.length, mode: 0o120777, uid: 1000, gid: 1000,
    atime: 0, mtime: 0, ctime: 0, ino: 7,
  }, 1, target);
  put('link', 'x'.repeat(500));
  const initial = s.admission.dbBytes();
  for (let i = 0; i < 20; i++) put('link', 'x'.repeat(500));
  assert.equal(s.admission.dbBytes(), initial, 'upsert does not double charge');
  assert.equal(t.nsCount(), 1);
  put('link', 'short');
  assert.ok(s.admission.dbBytes() < initial, 'shorter target releases its text cost');
  const before = s.admission.dbBytes();
  assert.throws(() => put('link', 'x'.repeat(4096)), error => error.code === 'ENOSPC');
  assert.equal(s.admission.dbBytes(), before, 'refused growth changes no stored bytes');
  assert.equal(t.nsGet('home/user', 'link').target, 'short');
  assert.equal(s.namespace.ready(), false, 'a refused namespace update is never a ready partial view');
  t.nsDelete('home/user', 'link');
  assert.equal(t.nsCount(), 0);
  assert.equal(t.nsBytes(), 0);
  assert.equal(s.admission.dbBytes(), 0);
}

{
  const s = createResidentStore();
  s.bindInMemory(2800);
  const t = s.coherence.heap;
  s.namespace.markReady(t, true);
  const row = (name, target) => ({ path: 'home/user/' + name, rev: 1, linkTarget: target,
    stat: { type: 'symlink', size: target.length, mode: 0o120777, uid: 1000, gid: 1000, atime: 0, mtime: 0, ctime: 0, ino: 1 } });
  s.namespace.replace(t, [row('a', 'x'), row('b', 'x'.repeat(1000))]);
  const bytes = s.admission.dbBytes();
  s.namespace.replace(t, [row('a', 'y'.repeat(1000)), row('b', 'y')]);
  assert.equal(t.nsGet('home/user', 'a').target, 'y'.repeat(1000));
  assert.equal(t.nsGet('home/user', 'b').target, 'y');
  assert.equal(s.admission.dbBytes(), bytes, 'same-size namespace replacement is admitted independent of row order');
  assert.equal(t.nsCount(), 2);
}

// A large file's parts, read as module loading reads them, after a program
// put setters on Array.prototype's first indexes: the heap's answer is built
// without meeting them (design-guest-loader-primordials.md §3.5), and is an
// ordinary array, as the key-value backing's is.
{
  const heap = heapTables();
  heap.chunkAddText('home/user/big.js', 1, 'b');
  heap.chunkAddText('home/user/big.js', 0, 'a');
  // A string, not an array: a push to one would meet the setter itself.
  let met = '';
  const descriptors = [0, 1].map((index) => [index, Object.getOwnPropertyDescriptor(Array.prototype, index)]);
  for (const index of [0, 1]) Object.defineProperty(Array.prototype, index, { configurable: true, set() { met += `${index} `; } });
  let parts;
  try {
    parts = heap.chunkParts('home/user/big.js');
  } finally {
    for (const [index, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(Array.prototype, index, descriptor);
      else delete Array.prototype[index];
    }
  }
  assert.equal(met, '', 'no setter on Array.prototype is met');
  assert.ok(Array.isArray(parts) && Object.getPrototypeOf(parts) === Array.prototype);
  assert.deepEqual(parts.map((part) => part.txt), ['a', 'b'], 'in part order');
}

// The kv backing writes nothing the gate holds: every write is unconfirmed (the fake refuses any other).
{
  const storage = fakeDoKv();
  const kv = kvTables(storage);
  kv.filePut('home/user/a.js', 0, 3, 1, 4, 'k1');
  kv.chunkAddText('home/user/a.js', 0, 'abc');
  kv.nsPut('home/user', 'a.js', 0, 3, 0o644, 1000, 1000, 1, 2, 3, 9, 4, null, 1, 1);
  kv.pagePut('home/user/big', 4, 0, new Uint8Array(8), 1);
  kv.dropDated();
  kv.clear();
  assert.ok(storage.writes > 0);
  // A store kept across a restart reads its rows back: a second binding over the same storage answers as the first.
  const kept = fakeDoKv();
  const first = kvTables(kept);
  first.filePut('home/user/b.js', 0, 2, 1, 5, null);
  first.chunkAddText('home/user/b.js', 0, 'hi');
  first.metaSet('epoch', 'e1');
  const second = kvTables(kept);
  assert.deepEqual(plain(second.chunkParts('home/user/b.js')), plain(first.chunkParts('home/user/b.js')));
  assert.equal(second.metaGet('epoch'), 'e1', 'the cursor survives with the rows it describes');
}

console.log(`resident-store-backings: ${compared} states compared across ${SEQUENCES} sequences; the heap answers as the facet's storage does`);
