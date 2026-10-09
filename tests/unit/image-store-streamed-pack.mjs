#!/usr/bin/env bun
// A resident launch's code pack is written as it streams: encoded, digested
// and written a module at a time, never encoded whole. An astro project's
// second `astro dev` carries a pack of 3,460 modules (24.2 M characters,
// 33.6 MiB as the strings the session holds, two-byte ones at two bytes a
// character); encoding it whole beside those strings reset the session's
// isolate ("Durable Object's isolate exceeded its memory limit"), where the
// first launch's 17.9 M characters had fit.
//
// Pinned on the buffers the store allocates, which this runtime can observe
// where it cannot observe a heap: none may be the size of the image.

import assert from 'node:assert/strict';
import { ImageStore, FACET_IMAGE_WRITE_SLICE_BYTES } from '../../packages/fabric/src/image-store.ts';
import { decodeCommonJsPackBytes, encodeCommonJsPack, facetImageDigest, facetImagePath } from '../../packages/fabric/src/process-fabric.ts';

// The disk: each file its written pieces, kept as the store hands them over
// (copied with the native constructor, so the disk's own copies are not
// counted as the store's buffers), joined only when a test reads one back.
const NativeUint8Array = globalThis.Uint8Array;
const files = new Map();
const writes = [];
const sizeOf = (path) => files.get(path)?.reduce((n, piece) => n + piece.byteLength, 0) ?? null;
const contents = (path) => {
  const pieces = files.get(path);
  const out = new NativeUint8Array(sizeOf(path));
  let offset = 0;
  for (const piece of pieces) { out.set(piece, offset); offset += piece.byteLength; }
  return out;
};
const copy = (bytes) => { const out = new NativeUint8Array(bytes.byteLength); out.set(bytes); return out; };
const blobs = () => ({
  mkdirp() {},
  sizeOf,
  writeFile(path, bytes) { writes.push(bytes.byteLength); files.set(path, [copy(bytes)]); },
  writeRange(path, offset, bytes) {
    writes.push(bytes.byteLength);
    assert.equal(offset, sizeOf(path), 'a pack grows from where it ends');
    files.get(path).push(copy(bytes));
  },
  list: () => [],
  unlink(path) { files.delete(path); },
});
const sameBytes = (a, b) => a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
const store = new ImageStore(blobs, () => true);
const pacer = { chunks: 0, async spend() {} };

// 96 modules of 64 KiB-ish each (6 MiB, many slices), some two-byte and some
// with characters UTF-8 writes as three and four bytes.
const modules = {};
for (let i = 0; i < 96; i++) {
  const body = i % 7 === 0 ? 'é€😀'.repeat(8 * 1024) : `module.exports = ${i};\n`.repeat(3 * 1024);
  modules[`node_modules/pkg/${i}.js`] = body;
}
const expected = new TextEncoder().encode(encodeCommonJsPack(modules).join(''));
const largestModuleBytes = Math.max(...Object.values(modules).map((text) => new TextEncoder().encode(text).byteLength));
const allowed = Math.max(FACET_IMAGE_WRITE_SLICE_BYTES, largestModuleBytes) * 2;
assert.ok(expected.byteLength > 2 * allowed, `the pack (${expected.byteLength} bytes) is larger than any buffer the store may hold (${allowed})`);

// What the store allocates while it materializes: every Uint8Array made, and
// every encode's output.
let largest = 0;
const nativeEncode = TextEncoder.prototype.encode;
class Watched extends NativeUint8Array {
  constructor(...args) { super(...args); if (this.byteLength > largest) largest = this.byteLength; }
}
const watch = async (run) => {
  largest = 0;
  globalThis.Uint8Array = Watched;
  TextEncoder.prototype.encode = function (text) {
    const out = nativeEncode.call(this, text);
    if (out.byteLength > largest) largest = out.byteLength;
    return out;
  };
  try { return await run(); } finally {
    globalThis.Uint8Array = NativeUint8Array;
    TextEncoder.prototype.encode = nativeEncode;
  }
};

const pack = encodeCommonJsPack(modules);
const paths = await watch(() => store.materialize(3, [['code pack', pack]], pacer));
const path = paths['code pack'];
assert.equal(path, facetImagePath(await facetImageDigest(expected)), 'the pack is named by the digest of its bytes');
const stored = contents(path.replace(/^\/+/, ''));
assert.ok(sameBytes(stored, expected), 'and holds exactly them');
assert.deepEqual(Object.keys(decodeCommonJsPackBytes(stored)), Object.keys(modules), 'which decode to every module');
assert.ok(largest <= allowed, `no buffer the size of the image: the largest was ${largest} bytes, the pack ${expected.byteLength}`);
assert.ok(writes.every((n) => n <= FACET_IMAGE_WRITE_SLICE_BYTES), 'each write is one slice at most');
assert.ok(writes.slice(0, -1).every((n) => n === FACET_IMAGE_WRITE_SLICE_BYTES), 'and every slice but the last is whole, so no write reads a partial chunk back');
assert.ok(pack.every((part) => part === ''), 'the pack\'s parts are released as they are written');
console.log('  a code pack is encoded, digested and written a module at a time');

// The same pack again: already stored at its digest, so nothing is written,
// and nothing the size of the image is made to find that out.
writes.length = 0;
const again = await watch(() => store.materialize(4, [['code pack', encodeCommonJsPack(modules)]], pacer));
assert.equal(again['code pack'], path, 'the same pack names the same image');
assert.equal(writes.length, 0, 'an image already stored is not written again');
assert.ok(largest <= allowed, `nor encoded whole to be recognized: the largest buffer was ${largest} bytes`);
console.log('  a pack already stored is recognized without a whole copy and not rewritten');

// A pack cut short by a reset (a shorter file at its path) is written again.
const cut = path.replace(/^\/+/, '');
files.set(cut, [contents(cut).slice(0, FACET_IMAGE_WRITE_SLICE_BYTES)]);
writes.length = 0;
await store.materialize(5, [['code pack', encodeCommonJsPack(modules)]], pacer);
assert.ok(sameBytes(contents(cut), expected), 'a partial image is replaced whole');
console.log('  a partial pack is rewritten');

console.log('image-store-streamed-pack: ok');
