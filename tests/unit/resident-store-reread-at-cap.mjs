#!/usr/bin/env bun
// A resident store at its cap keeps a file whose bytes it is handed
// again, whichever way they come: a read's write-through (fill) of the
// same content held as text, as bytes, or in several chunks, and a delta
// that pushes the same bytes with no content key to say so. Each used to
// remove the row before asking whether the replacement fit, and at the
// cap it did not: the store's size is the file SQLite allocated, which a
// delete does not shrink. A changed file's bytes still replace the row, or,
// with no room for them, leave no row: never the old bytes.

import assert from 'node:assert/strict';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { RESIDENT_CHUNK_BYTES } from '../../packages/worker/src/vfs/facet-resident-limits.ts';
import { facetSql } from './lib/resident-body.mjs';

const enc = new TextEncoder();
const CURSOR = { poison: false, paths: [], epoch: 'e1', rev: 7 };
const STAT = (size) => ({ type: 'file', size, mode: 0o100644, uid: 1000, gid: 1000, atime: 0, mtime: 0, ctime: 0, ino: 1 });
const FILES = {
  'home/user/app/src/App.tsx': 'export const App = () => <div className="text-red-500">naïve 日本語</div>;\n'.repeat(30),
  // More text than one chunk holds.
  'home/user/app/src/big.ts': `export const big = ${JSON.stringify('é'.repeat(RESIDENT_CHUNK_BYTES))};\n`,
  // A surrogate pair straddling two chunks of text.
  'home/user/app/src/emoji.txt': 'a'.repeat(Math.floor(RESIDENT_CHUNK_BYTES / 3) - 1) + '😀z',
  // More bytes than one chunk holds.
  'home/user/app/public/blob.bin': Uint8Array.from({ length: RESIDENT_CHUNK_BYTES * 2 + 17 }, (_, i) => (i * 31) & 255),
};

// A process facet's store over its SQLite, holding FILES as a launch's fills
// leave them (text as text); then its allowance is exactly what it holds,
// and the session's ledger has no more.
const store = createResidentStore();
store.bind({ storage: { sql: facetSql() } });
store.cells.admit(CURSOR);
const ledger = { fsStorageGrant: async () => ({ granted: 0 }) };
store.admission.setStorage({ facet: 'proc-slot-0', grant: 64 * 1024 * 1024 }, ledger);
for (const [path, body] of Object.entries(FILES)) assert.ok(store.cells.fill(path, body, 7), `${path} is seeded`);
store.admission.setStorage({ facet: 'proc-slot-0', grant: 0 }, ledger);
const t = store.coherence.require();
const read = (path) => store.bundle[path];
const bytesOf = (body) => (typeof body === 'string' ? enc.encode(body) : body);

for (const [path, body] of Object.entries(FILES)) {
  assert.ok(store.cells.fill(path, bytesOf(body), 8), `${path}: a read of the same bytes is taken`);
  assert.ok(store.cells.has(path), `${path} is still held after a read of the same bytes, at the cap`);
  assert.equal(t.fileRev(path), 8, `${path} is dated at the read`);
  assert.deepEqual(bytesOf(read(path)), bytesOf(body), `${path} reads as before`);
}
{
  const path = 'home/user/app/src/App.tsx';
  assert.ok(store.cells.fill(path, FILES[path], 9), 'the same text, as text');
  assert.equal(t.fileRev(path), 9);
}

// A delta pushing the same bytes, no content key.
{
  const path = 'home/user/app/src/App.tsx';
  const bytes = bytesOf(FILES[path]);
  const admitted = store.cells.admit({ poison: false, epoch: 'e1', rev: 10, paths: [{ path, rev: 10, bytes, stat: STAT(bytes.byteLength) }] });
  assert.deepEqual(admitted.dropped, [], 'nothing held is dropped');
  assert.ok(store.cells.has(path), 'the pushed file is still held, at the cap');
  assert.equal(t.fileRev(path), 10, 'dated at the delta');
}

// A changed file: never the old bytes.
{
  const path = 'home/user/app/src/big.ts';
  const changed = `export const big = ${JSON.stringify('ü'.repeat(RESIDENT_CHUNK_BYTES + 99))};\n`;
  store.cells.fill(path, enc.encode(changed), 11);
  assert.ok(!store.cells.has(path) || String(read(path)) !== FILES[path], 'a changed file is replaced or not held');
}
console.log('resident-store-reread-at-cap: ok');
