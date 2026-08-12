#!/usr/bin/env bun
// wasi-abi-preview0 — the two WASI wire ABIs, and the encodings that differ.
//
// `wasi_unstable` (preview0) and `wasi_snapshot_preview1` share every function
// name and every signature, so binding the wrong one never traps — it silently
// returns wrong numbers. Exactly two encodings differ, and both were live
// defects: wasm-runner bound ONE preview1 import table to BOTH namespaces, so
// every preview0 binary got inverted lseek and read st_size out of nlink.
//
// These assertions decode the bytes the shim writes exactly as a preview0
// guest's wasi-libc would, so the layout is pinned from the caller's side.

import assert from 'node:assert';
import {
  WASI_INSTANCE_PREAMBLE_SRC,
  WASI_ABI_NAMESPACE,
} from '../../packages/core/src/runtime/wasi-instance.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Each call gets a fresh preamble evaluation: __wasiFS and fdTable are module-global. */
async function freshLayer({ abi, fileSize }) {
  const P = await new AsyncFunction(`${WASI_INSTANCE_PREAMBLE_SRC}
return { __wasiInitFS, __wasiMakeImports };`)();
  const memory = new WebAssembly.Memory({ initial: 16 });
  P.__wasiInitFS({
    root: '',
    preopens: [{ wasiPath: '/', vfsPath: '' }],
    files: { 'probe.bin': btoa('\0'.repeat(fileSize)) },
    dirs: [],
    // Modes are 3-bit effective rwx, not unix modes. The root needs one too:
    // an existing inode with no mapped mode resolves to 0, and the traversal
    // check wants the execute bit on every ancestor.
    modes: { '': 7, 'probe.bin': 7 },
  });
  const { wasiImport } = P.__wasiMakeImports({
    argv: ['probe'], env: {}, abi, getMemory: () => memory,
  });
  const dv = new DataView(memory.buffer);
  const u8 = new Uint8Array(memory.buffer);
  const pathPtr = 1024;
  const name = new TextEncoder().encode('probe.bin');
  u8.set(name, pathPtr);
  const fdOut = 2048;
  assert.equal(
    wasiImport.path_open(3, 0, pathPtr, name.length, 0, 0n, 0n, 0, fdOut), 0,
    'path_open should succeed');
  return { wasiImport, dv, u8, fd: dv.getUint32(fdOut, true) };
}

// ── fd_seek whence ──────────────────────────────────────────────────────
// The file is 100 bytes, so END-10 lands at 90 under either ABI — but the
// constant that MEANS end differs, which is the whole bug.
{
  const { wasiImport, dv, fd } = await freshLayer({ abi: 'preview0', fileSize: 100 });
  const out = 4096;
  assert.equal(wasiImport.fd_seek(fd, -10n, 1, out), 0);
  assert.equal(dv.getBigUint64(out, true), 90n, 'preview0 whence=1 must mean END');
  assert.equal(wasiImport.fd_seek(fd, 7n, 2, out), 0);
  assert.equal(dv.getBigUint64(out, true), 7n, 'preview0 whence=2 must mean SET');
  // CUR===0 under preview0, so this advances from 7 rather than resetting to 5.
  assert.equal(wasiImport.fd_seek(fd, 5n, 0, out), 0);
  assert.equal(dv.getBigUint64(out, true), 12n, 'preview0 whence=0 must mean CUR');
}
{
  const { wasiImport, dv, fd } = await freshLayer({ abi: 'preview1', fileSize: 100 });
  const out = 4096;
  assert.equal(wasiImport.fd_seek(fd, 7n, 0, out), 0);
  assert.equal(dv.getBigUint64(out, true), 7n, 'preview1 whence=0 must mean SET');
  assert.equal(wasiImport.fd_seek(fd, 5n, 1, out), 0);
  assert.equal(dv.getBigUint64(out, true), 12n, 'preview1 whence=1 must mean CUR');
  assert.equal(wasiImport.fd_seek(fd, -10n, 2, out), 0);
  assert.equal(dv.getBigUint64(out, true), 90n, 'preview1 whence=2 must mean END');
}

// ── filestat layout ─────────────────────────────────────────────────────
// 4242 is chosen so a misread cannot coincidentally equal the nlink value.
{
  const { wasiImport, dv, u8, fd } = await freshLayer({ abi: 'preview0', fileSize: 4242 });
  const statPtr = 8192;
  u8.fill(0xab, statPtr, statPtr + 72);
  assert.equal(wasiImport.fd_filestat_get(fd, statPtr), 0);
  assert.equal(dv.getUint8(statPtr + 16), 4, 'filetype must be REGULAR_FILE');
  assert.equal(dv.getUint32(statPtr + 20, true), 1, 'preview0 nlink is a u32 at +20');
  assert.equal(dv.getBigUint64(statPtr + 24, true), 4242n, 'preview0 st_size sits at +24');
  assert.equal(dv.getUint8(statPtr + 56), 0xab, 'preview0 filestat must not write past 56 bytes');
}
{
  const { wasiImport, dv, u8, fd } = await freshLayer({ abi: 'preview1', fileSize: 4242 });
  const statPtr = 8192;
  u8.fill(0xab, statPtr, statPtr + 72);
  assert.equal(wasiImport.fd_filestat_get(fd, statPtr), 0);
  assert.equal(dv.getUint8(statPtr + 16), 4, 'filetype must be REGULAR_FILE');
  assert.equal(dv.getBigUint64(statPtr + 24, true), 1n, 'preview1 nlink is a u64 at +24');
  assert.equal(dv.getBigUint64(statPtr + 32, true), 4242n, 'preview1 st_size sits at +32');
  assert.equal(dv.getUint8(statPtr + 64), 0xab, 'preview1 filestat must not write past 64 bytes');

  // The regression itself, asserted so nobody re-aliases the two namespaces
  // onto one table and calls the ABIs near-identical again.
  assert.equal(dv.getBigUint64(statPtr + 24, true), 1n,
    'a preview0 guest reading a preview1 filestat gets a size of 1, not 4242');
}

assert.equal(WASI_ABI_NAMESPACE.preview1, 'wasi_snapshot_preview1');
assert.equal(WASI_ABI_NAMESPACE.preview0, 'wasi_unstable');

console.log('wasi-abi-preview0: whence and filestat assertions passed for both ABIs');
