#!/usr/bin/env bun
// A napi binding's WASI opens and descriptor-status changes reach the host's
// fs as Linux would take them (WRT-10, WRT-11), through the staged loader
// (napi-wasm-loader.mjs, as a deploy stages it) over this process's own fs:
//
//   - path_open without SYMLINK_FOLLOW of a final symlink is refused as
//     open(2) with O_NOFOLLOW refuses it here: ELOOP, and ENOTDIR with
//     O_DIRECTORY; read-only, writable and creating opens alike;
//   - fd_fdstat_set_flags that changes APPEND, which the host's descriptor
//     cannot change (Node has no fcntl F_SETFL), is refused with ENOTSUP and
//     the descriptor goes on as it was; one that changes nothing succeeds.
//
// The binding is a reactor of a few lines (`_initialize` runs the calls and
// leaves each errno in memory) with the exports emnapi takes a module by.
//
// Red before: the loader opened without O_NOFOLLOW, so each open reached the
// link's target, and set_flags answered success while the host's descriptor
// kept its old mode.

import assert from 'node:assert/strict';
import { constants, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import wabtInit from 'wabt';
import { NAPI_WASM_LOADER, NAPI_WASM_TRAMPOLINE } from '../../packages/worker/src/napi-wasm-artifacts.generated.ts';

const WASI_ERRNO = { ELOOP: 32, ENOTDIR: 54, ENOTSUP: 58, ENOENT: 44, EEXIST: 20, EISDIR: 31 };
const staged = (asset) => readFileSync(new URL(`../../packages/worker/public${asset.path}`, import.meta.url));

const root = mkdtempSync(join(tmpdir(), 'napi-wasi-open-flags-'));
try {
  writeFileSync(join(root, 'f'), 'abc');
  mkdirSync(join(root, 'sub'));
  symlinkSync('f', join(root, 'lf'));
  symlinkSync('sub', join(root, 'ld'));
  const rel = (name) => join(root, name).slice(1);

  // Paths at 0x1000 on, each [ptr, len] at 0x100 + 8i; write data at 0x3100.
  const PATHS = [rel('lf'), rel('ld'), rel('g'), rel('h')];
  const RO = (1n << 1n) | (1n << 2n) | (1n << 3n) | (1n << 5n) | (1n << 21n);
  const RW = RO | (1n << 6n);
  const wabt = await wabtInit();
  const WAT = `(module
    (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "fd_seek" (func $fd_seek (param i32 i64 i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "fd_fdstat_set_flags" (func $set_flags (param i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
    (import "env" "memory" (memory 1))
    (export "memory" (memory 0))
    (table (export "__indirect_function_table") 1 funcref)
    (global $heap (mut i32) (i32.const 0x8000))
    (func $malloc (export "malloc") (param $n i32) (result i32) (local $p i32)
      (local.set $p (global.get $heap))
      (global.set $heap (i32.and (i32.add (i32.add (global.get $heap) (local.get $n)) (i32.const 7)) (i32.const -8)))
      (local.get $p))
    (func (export "free") (param i32))
    (func (export "emnapi_create_env") (result i32) (call $malloc (i32.const 64)))
    (func (export "emnapi_delete_env") (param i32))
    (func (export "napi_register_wasm_v1") (param i32 i32) (result i32) (i32.const 0))
    (func $open (param $i i32) (param $lookup i32) (param $oflags i32) (param $rights i64) (param $fdflags i32) (result i32)
      (call $path_open (i32.const 3) (local.get $lookup)
        (i32.load (i32.add (i32.const 0x100) (i32.shl (local.get $i) (i32.const 3))))
        (i32.load (i32.add (i32.const 0x104) (i32.shl (local.get $i) (i32.const 3))))
        (local.get $oflags) (local.get $rights) (i64.const 0) (local.get $fdflags) (i32.const 0x3200)))
    (func $result (param $i i32) (param $v i32)
      (i32.store (i32.add (i32.const 0x2000) (i32.shl (local.get $i) (i32.const 2))) (local.get $v)))
    (func $write (param $fd i32) (param $buf i32) (param $len i32)
      (i32.store (i32.const 0x3000) (local.get $buf))
      (i32.store (i32.const 0x3004) (local.get $len))
      (drop (call $fd_write (local.get $fd) (i32.const 0x3000) (i32.const 1) (i32.const 0x3204))))
    (func $closeOpened (param $e i32)
      (if (i32.eqz (local.get $e)) (then (drop (call $fd_close (i32.load (i32.const 0x3200)))))))
    (func (export "_initialize") (local $fd i32) (local $e i32)
      ;; 0-3: a final symlink opened without following it; 4: followed.
      (local.set $e (call $open (i32.const 0) (i32.const 0) (i32.const 0) (i64.const ${RO}) (i32.const 0)))
      (call $result (i32.const 0) (local.get $e)) (call $closeOpened (local.get $e))
      (local.set $e (call $open (i32.const 0) (i32.const 0) (i32.const 0) (i64.const ${RW}) (i32.const 0)))
      (call $result (i32.const 1) (local.get $e)) (call $closeOpened (local.get $e))
      (local.set $e (call $open (i32.const 0) (i32.const 0) (i32.const 1) (i64.const ${RW}) (i32.const 0)))
      (call $result (i32.const 2) (local.get $e)) (call $closeOpened (local.get $e))
      (local.set $e (call $open (i32.const 1) (i32.const 0) (i32.const 2) (i64.const ${RO}) (i32.const 0)))
      (call $result (i32.const 3) (local.get $e)) (call $closeOpened (local.get $e))
      (local.set $e (call $open (i32.const 0) (i32.const 1) (i32.const 0) (i64.const ${RO}) (i32.const 0)))
      (call $result (i32.const 4) (local.get $e)) (call $closeOpened (local.get $e))
      ;; 5-7: g, a plain descriptor: "abc", back to 0, a set that changes nothing, then APPEND, then "d".
      (call $result (i32.const 5) (call $open (i32.const 2) (i32.const 1) (i32.const 9) (i64.const ${RW}) (i32.const 0)))
      (local.set $fd (i32.load (i32.const 0x3200)))
      (call $write (local.get $fd) (i32.const 0x3100) (i32.const 3))
      (drop (call $fd_seek (local.get $fd) (i64.const 0) (i32.const 0) (i32.const 0x3208)))
      (call $result (i32.const 6) (call $set_flags (local.get $fd) (i32.const 0)))
      (call $result (i32.const 7) (call $set_flags (local.get $fd) (i32.const 1)))
      (call $write (local.get $fd) (i32.const 0x3103) (i32.const 1))
      (drop (call $fd_close (local.get $fd)))
      ;; 8-9: h, an appending descriptor: "ab", APPEND cleared, back to 0, then "c".
      (call $result (i32.const 8) (call $open (i32.const 3) (i32.const 1) (i32.const 9) (i64.const ${RW}) (i32.const 1)))
      (local.set $fd (i32.load (i32.const 0x3200)))
      (call $write (local.get $fd) (i32.const 0x3104) (i32.const 2))
      (call $result (i32.const 9) (call $set_flags (local.get $fd) (i32.const 0)))
      (drop (call $fd_seek (local.get $fd) (i64.const 0) (i32.const 0) (i32.const 0x3208)))
      (call $write (local.get $fd) (i32.const 0x3106) (i32.const 1))
      (drop (call $fd_close (local.get $fd)))))`;
  const parsed = wabt.parseWat('binding.wat', WAT, {});
  let binding;
  try { parsed.validate(); binding = new WebAssembly.Module(parsed.toBinary({}).buffer); } finally { parsed.destroy(); }

  const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  let at = 0x1000;
  PATHS.forEach((path, i) => {
    const encoded = new TextEncoder().encode(path);
    bytes.set(encoded, at);
    view.setUint32(0x100 + 8 * i, at, true);
    view.setUint32(0x104 + 8 * i, encoded.length, true);
    at += encoded.length + 8;
  });
  bytes.set(new TextEncoder().encode('abcdabc'), 0x3100);

  const loaderFile = join(root, 'napi-wasm-loader.mjs');
  writeFileSync(loaderFile, staged(NAPI_WASM_LOADER));
  const { createNapiWasmBinding } = await import(pathToFileURL(loaderFile).href);
  createNapiWasmBinding({
    fs, env: {}, writeStdout() {}, writeStderr() {},
    binding, trampoline: new WebAssembly.Module(staged(NAPI_WASM_TRAMPOLINE)), memoryPages: 1, memory, name: 'flags-probe',
  });
  const result = (i) => view.getUint32(0x2000 + 4 * i, true);

  // What open(2) with O_NOFOLLOW answers here, for each open the binding made.
  const host = (name, flags) => {
    try { closeSync(openSync(join(root, name), flags | constants.O_NOFOLLOW)); return 0; } catch (error) { return WASI_ERRNO[error.code] ?? error.code; }
  };
  const answered = {
    readNoFollow: result(0), writeNoFollow: result(1), createNoFollow: result(2), directoryNoFollow: result(3), readFollowed: result(4),
    openPlain: result(5), setUnchanged: result(6), setAppend: result(7), plainBytes: readFileSync(join(root, 'g'), 'utf8'),
    openAppending: result(8), clearAppend: result(9), appendingBytes: readFileSync(join(root, 'h'), 'utf8'),
  };
  assert.deepEqual(answered, {
    readNoFollow: host('lf', constants.O_RDONLY),
    writeNoFollow: host('lf', constants.O_WRONLY),
    createNoFollow: host('lf', constants.O_WRONLY | constants.O_CREAT),
    directoryNoFollow: host('ld', constants.O_RDONLY | constants.O_DIRECTORY),
    readFollowed: 0,
    openPlain: 0,
    setUnchanged: 0,
    setAppend: WASI_ERRNO.ENOTSUP,
    // The descriptor still writes where it is: "d" over the "a" at 0.
    plainBytes: 'dbc',
    openAppending: 0,
    clearAppend: WASI_ERRNO.ENOTSUP,
    // Still appending: "c" lands at the end, not over the "a" at 0.
    appendingBytes: 'abc',
  });
  assert.equal(readFileSync(join(root, 'f'), 'utf8'), 'abc', 'no open reached the link\'s target');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('napi-wasi-open-flags: no-follow opens and descriptor-status changes as the host takes them');
