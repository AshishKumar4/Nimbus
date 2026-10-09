#!/usr/bin/env bun
// wasm-memory-high-offsets — a WASI guest's memory past the Workers runtime's
// ArrayBuffer cap is read and written at every offset.
//
// A Worker caps an ArrayBuffer at 128 MiB; only a WebAssembly.Memory grows
// past it, and on such a buffer `subarray` refuses a begin past the cap
// ("RangeError: Invalid array buffer length", lib/platform-subarray-limit.mjs)
// where `new Uint8Array(buffer, byteOffset, length)` does not. The WASI hosts
// took views of guest memory with subarray: rolldown pre-bundling a React
// app's dependencies grew to 152 MiB, and its writes of the pre-bundles
// failed "Bad address (os error 21)" (EFAULT, the codec's answer to a
// RangeError). Every view of guest memory at a guest pointer is now taken
// with the constructor: the filesystem codec's paths and write gathers
// (core/runtime/wasi/filesystem.ts, shared by the resident preamble, the bash
// runner and the napi-wasm loader), and the resident preamble's own paths and
// random_get.
import assert from 'node:assert/strict';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';
import { loadWasiPreamble } from './lib/wasi-authority.mjs';
import { memorySupervisor } from './lib/descriptor-supervisor.mjs';
import { simulatePlatformSubarrayLimit } from './lib/platform-subarray-limit.mjs';

const ESUCCESS = 0;
const LIMIT = 1 << 20;
const HIGH = LIMIT + 0x40000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const P = await loadWasiPreamble();

const platform = simulatePlatformSubarrayLimit(LIMIT);
try {
  const memory = new WebAssembly.Memory({ initial: 32 });
  const sup = memorySupervisor();
  P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }] });
  P.__wasiAdoptSupervisor(sup);
  const { wasiImport } = makeImportsWithoutJSPI(P, {
    argv: ['prog'], env: {}, getMemory: () => memory, stdoutWrite: () => {}, stderrWrite: () => {},
  });
  const u8 = () => new Uint8Array(memory.buffer);
  const view = () => new DataView(memory.buffer);
  const at = { path: HIGH, fd: HIGH + 0x100, iovs: HIGH + 0x200, written: HIGH + 0x300, data: HIGH + 0x1000, random: HIGH + 0x2000 };

  // A path past the cap: path_open reads it (the preamble, then the codec).
  const name = enc.encode('home/user/high.txt');
  u8().set(name, at.path);
  const opened = await wasiImport.path_open(3, 1, at.path, name.length, 1 /* O_CREAT */, -1n, -1n, 0, at.fd);
  assert.equal(opened, ESUCCESS, `a path at ${HIGH} opens (errno ${opened})`);
  const fd = view().getUint32(at.fd, true);

  // A write gathered from past the cap.
  const text = 'gathered past the ArrayBuffer cap';
  u8().set(enc.encode(text), at.data);
  view().setUint32(at.iovs, at.data, true);
  view().setUint32(at.iovs + 4, text.length, true);
  const wrote = await wasiImport.fd_write(fd, at.iovs, 1, at.written);
  assert.equal(wrote, ESUCCESS, `a write from ${at.data} succeeds (errno ${wrote}: 21 is EFAULT, "Bad address")`);
  assert.equal(view().getUint32(at.written, true), text.length);
  assert.equal(dec.decode(sup.store.get('home/user/high.txt')), text, 'and its bytes are the file');

  // random_get past the cap.
  const got = wasiImport.random_get(at.random, 4096);
  assert.equal(await got, ESUCCESS, 'random_get fills a buffer past the cap');
  assert.ok(u8().slice(at.random, at.random + 4096).some((b) => b !== 0), 'with random bytes');

  assert.equal(platform.refused, 0, 'no view of guest memory was taken with subarray past the cap');
} finally {
  platform.restore();
}
console.log('wasm-memory-high-offsets: ok');
