#!/usr/bin/env bun
// wasm-process-image — a swap image must restore the process exactly, or
// refuse to restore at all.
//
// A half-written image that restores as corruption is far worse than an OOM,
// so every failure mode here is a throw, never a partial restore: a truncated
// body, a digest mismatch, a missing chunk, an image whose globals the target
// instance does not have. The store's commit point is the manifest write, so
// chunks written before a crash are unreferenced rather than half-visible.
//
// Zero-page elision is the property that makes checkpointing affordable.
// Measured on the real bash.async.wasm mid-execution: 136.6 MiB of live
// linear memory produced a 0.75 MiB image, because bash reserves a large
// Asyncify arena it mostly never writes. That is pinned here as behaviour —
// pages that are zero must not reach the store — rather than as a number.

import assert from 'node:assert/strict';
import {
  captureProcessImage,
  restoreProcessImage,
  WasmSwapStore,
  WasmImageIntegrityError,
  WasmImageMissingError,
  SWAP_CHUNK_BYTES,
} from '../../packages/worker/src/runtime/wasm-process-image.ts';
import { WASM_PAGE_BYTES } from '../../packages/worker/src/runtime/wasm-memory.ts';

// A module with a memory and one mutable global, hand-assembled so the test
// depends on no build artefact:
//   (module (memory (export "memory") 4) (global (export "g") (mut i32) i32.const 0))
const MODULE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x04,                                // memory: min 4
  0x06, 0x06, 0x01, 0x7f, 0x01, 0x41, 0x00, 0x0b,              // global: mut i32 = 0
  0x07, 0x0e, 0x02, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79,  // export "memory"
  0x02, 0x00, 0x01, 0x67, 0x03, 0x00,                          // export "g"
]);
const MODULE = new WebAssembly.Module(MODULE_BYTES);
const fresh = () => new WebAssembly.Instance(MODULE, {});

/** Synchronous in-memory kv with the real store's measured 2 MiB value ceiling. */
class FakeKv {
  #m = new Map();
  get(k) { return this.#m.get(k); }
  put(k, v) {
    const size = v instanceof Uint8Array ? v.byteLength : String(v).length;
    if (size > SWAP_CHUNK_BYTES) throw new Error(`SQLITE_TOOBIG: ${size}`);
    this.#m.set(k, v instanceof Uint8Array ? v.slice() : v);
  }
  delete(k) { this.#m.delete(k); }
  *list({ prefix = '' } = {}) { for (const e of this.#m) if (e[0].startsWith(prefix)) yield e; }
  keys() { return [...this.#m.keys()]; }
}

// ── Zero pages never reach the store ────────────────────────────────────
{
  const inst = fresh();
  const view = new Uint8Array(inst.exports.memory.buffer);
  view[1 * WASM_PAGE_BYTES] = 0xaa;      // page 1
  view[3 * WASM_PAGE_BYTES + 99] = 0xbb; // page 3

  const { image, body } = captureProcessImage(inst);
  assert.deepEqual(image.residentPages, [1, 3], 'only written pages are carried');
  assert.equal(body.length, 2 * WASM_PAGE_BYTES, 'the body is exactly the resident pages');
  assert.equal(image.pages, 4, 'the image still describes the full address space');
}

// ── A restore reproduces memory and globals exactly ─────────────────────
{
  const source = fresh();
  const sv = new Uint8Array(source.exports.memory.buffer);
  sv[0] = 1; sv[WASM_PAGE_BYTES + 7] = 42; sv[3 * WASM_PAGE_BYTES + 4095] = 0xff;
  source.exports.g.value = 0x1234abcd;

  const { image, body } = captureProcessImage(source, { fd: 3, cwd: '/home/user' });
  assert.deepEqual(image.globals, [{ name: 'g', kind: 'number', value: 0x1234abcd }],
    'exported mutable globals are captured');

  const target = fresh();
  const hostState = restoreProcessImage(target, image, body);
  assert.deepEqual(hostState, { fd: 3, cwd: '/home/user' },
    'runner-owned state round-trips verbatim');
  assert.deepEqual(
    new Uint8Array(target.exports.memory.buffer),
    new Uint8Array(source.exports.memory.buffer),
    'restored linear memory is byte-identical, elided zero pages included',
  );
  assert.equal(target.exports.g.value, 0x1234abcd, 'globals are restored');
}

// ── Corruption is refused, never restored ───────────────────────────────
{
  const source = fresh();
  new Uint8Array(source.exports.memory.buffer)[0] = 9;
  const { image, body } = captureProcessImage(source);

  const flipped = body.slice();
  flipped[0] ^= 0xff;
  assert.throws(() => restoreProcessImage(fresh(), image, flipped), WasmImageIntegrityError,
    'a single flipped byte fails the digest');

  assert.throws(() => restoreProcessImage(fresh(), image, body.subarray(0, body.length - 1)),
    WasmImageIntegrityError, 'a truncated body is refused on length before digest');

  assert.throws(() => restoreProcessImage(fresh(), { ...image, version: 99 }, body),
    WasmImageMissingError, 'an unknown image version is refused');

  // Restoring into a dirty, larger instance would leave stale bytes showing
  // through the elided pages, so it is rejected rather than silently allowed.
  const dirty = fresh();
  dirty.exports.memory.grow(4);
  assert.throws(() => restoreProcessImage(dirty, image, body), WasmImageMissingError,
    'a restore target larger than its image is refused');
}

// ── The store: content addressing, commit ordering, sweep ───────────────
{
  const kv = new FakeKv();
  const store = new WasmSwapStore(kv);

  const source = fresh();
  new Uint8Array(source.exports.memory.buffer)[2 * WASM_PAGE_BYTES] = 77;
  source.exports.g.value = 5;

  const out = store.swapOut('pid:1', source, { pid: 1 });
  assert.equal(out.liveBytes, 4 * WASM_PAGE_BYTES);
  assert.equal(out.imageBytes, WASM_PAGE_BYTES, 'one resident page');
  assert.equal(out.elidedBytes, 3 * WASM_PAGE_BYTES, 'three zero pages never stored');
  assert.ok(store.has('pid:1'));

  const target = fresh();
  assert.deepEqual(store.swapIn('pid:1', target), { pid: 1 });
  assert.equal(new Uint8Array(target.exports.memory.buffer)[2 * WASM_PAGE_BYTES], 77);
  assert.equal(target.exports.g.value, 5);

  // Identical state checkpointed under a second key shares one copy of the bytes.
  const chunksBefore = kv.keys().filter((k) => k.includes(':blob:')).length;
  const same = store.swapOut('pid:2', source, { pid: 2 });
  assert.equal(same.contentId, out.contentId, 'identical memory yields the same content id');
  assert.equal(kv.keys().filter((k) => k.includes(':blob:')).length, chunksBefore,
    'a duplicate image writes no new chunks');

  // A missing chunk is reported, not silently restored as zeros.
  kv.delete(kv.keys().find((k) => k.includes(':blob:')));
  assert.throws(() => store.swapIn('pid:1', fresh()), WasmImageMissingError,
    'an absent chunk fails the restore');
}

// ── sweep reclaims only unreferenced chunks ─────────────────────────────
{
  const kv = new FakeKv();
  const store = new WasmSwapStore(kv);

  const a = fresh();
  new Uint8Array(a.exports.memory.buffer)[0] = 1;
  store.swapOut('keep', a, null);

  const b = fresh();
  new Uint8Array(b.exports.memory.buffer)[WASM_PAGE_BYTES] = 2;
  store.swapOut('drop', b, null);

  store.forget('drop');
  assert.equal(store.sweep().reclaimedChunks, 1, 'the forgotten image\'s chunk is reclaimed');
  assert.equal(store.sweep().reclaimedChunks, 0, 'a second sweep finds nothing');

  const target = fresh();
  store.swapIn('keep', target);
  assert.equal(new Uint8Array(target.exports.memory.buffer)[0], 1,
    'the retained image is untouched by the sweep');
}

console.log('wasm-process-image: ok');
