#!/usr/bin/env bun
// wasi-threads-load-contract — what a threads binary must declare, and what
// happens when it doesn't.
//
// Every unsupported shape has to fail at LOAD, naming the remedy, rather than
// part-way through a run: a module that spawns threads over a memory its
// siblings cannot see, or whose libc futex still compiles to
// memory.atomic.wait32, does not misbehave gradually — it corrupts or traps
// deep inside libc with nothing pointing back at the build line.
//
// The decision is made from the binary because the JS API exposes an import's
// name but not its type, and the host must create the shared memory at exactly
// the limits the module declares or instantiation fails.

import assert from 'node:assert/strict';
import {
  inspectWasmThreads,
  wasiThreadsLoadError,
  WASI_THREADS_NAMESPACE,
  NIMBUS_THREADS_NAMESPACE,
  WASI_THREAD_START_EXPORT,
} from '../../packages/core/src/runtime/wasi-threads.ts';

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name} — ${e && e.message ? e.message : e}`);
    failures++;
  }
};

const enc = new TextEncoder();
const uleb = (n) => {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};
const str = (s) => { const b = [...enc.encode(s)]; return [...uleb(b.length), ...b]; };
const section = (id, payload) => [id, ...uleb(payload.length), ...payload];

const importFunc = (mod, name) => [...str(mod), ...str(name), 0x00, ...uleb(0)];
const importMemory = (mod, name, { min, max, shared }) => [
  ...str(mod), ...str(name), 0x02,
  (max === null ? 0 : 1) | (shared ? 2 : 0),
  ...uleb(min),
  ...(max === null ? [] : uleb(max)),
];
const importGlobal = (mod, name) => [...str(mod), ...str(name), 0x03, 0x7f, 0x00];
const importTable = (mod, name) => [...str(mod), ...str(name), 0x01, 0x70, 0x00, ...uleb(1)];
const exportFunc = (name, idx) => [...str(name), 0x00, ...uleb(idx)];

function wasm({ imports = [], exports = [], custom = null } = {}) {
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (custom) bytes.push(...section(0, [...str(custom.name), ...enc.encode(custom.body)]));
  if (imports.length) bytes.push(...section(2, [...uleb(imports.length), ...imports.flat()]));
  if (exports.length) bytes.push(...section(7, [...uleb(exports.length), ...exports.flat()]));
  return new Uint8Array(bytes);
}

const SHARED_MEM = importMemory('env', 'memory', { min: 256, max: 1024, shared: true });
const SPAWN = importFunc(WASI_THREADS_NAMESPACE, 'thread-spawn');
const FUTEX = importFunc(NIMBUS_THREADS_NAMESPACE, 'futex_wait');
const THREAD_START = exportFunc(WASI_THREAD_START_EXPORT, 3);

// ── a complete, supported threads build ──────────────────────────────────────
{
  const info = inspectWasmThreads(wasm({
    imports: [importFunc('wasi_snapshot_preview1', 'fd_write'), FUTEX, SPAWN, SHARED_MEM],
    exports: [exportFunc('_start', 1), exportFunc('memory', 0), THREAD_START],
  }));
  check('a complete threads build is recognised', () =>
    assert.deepEqual(info, {
      spawns: true,
      futex: true,
      memory: { module: 'env', name: 'memory', initial: 256, maximum: 1024, shared: true },
      threadStart: true,
    }));
  check('a complete threads build loads', () => assert.equal(wasiThreadsLoadError(info), null));
}

// ── every import kind is stepped over correctly ──────────────────────────────
{
  const info = inspectWasmThreads(wasm({
    imports: [
      importGlobal('env', '__stack_pointer'),
      importTable('env', '__indirect_function_table'),
      SHARED_MEM,
      importFunc('wasi_snapshot_preview1', 'proc_exit'),
      SPAWN,
      FUTEX,
    ],
    exports: [THREAD_START],
  }));
  check('globals and tables between the imports do not derail the walk', () =>
    assert.deepEqual([info.spawns, info.futex, info.threadStart, info.memory.initial],
      [true, true, true, 256]));
}

// ── the decision is structural, not a substring search ───────────────────────
{
  const info = inspectWasmThreads(wasm({
    custom: { name: '.debug_str', body: 'wasi\0thread-spawn\0nimbus_threads\0futex_wait' },
    exports: [exportFunc('_start', 0)],
  }));
  check('debug strings naming the imports do not fake a threads build', () =>
    assert.deepEqual([info.spawns, info.futex, info.memory, info.threadStart],
      [false, false, null, false]));
  check('a program that does not ask for threads is not this check\'s business', () =>
    assert.equal(wasiThreadsLoadError(info), null));
}

// ── each unsupported shape fails loudly, with the remedy ─────────────────────
const remedy = /--target=wasm32-wasip1-threads .*--shared-memory.*nimbus-threads\.c/s;

{
  const err = wasiThreadsLoadError(inspectWasmThreads(wasm({
    imports: [SPAWN, FUTEX],
    exports: [THREAD_START],
  })));
  check('a module that defines its own memory is rejected', () =>
    assert.match(err || '', /defines its own memory/));
  check('the own-memory rejection carries the build line', () => assert.match(err || '', remedy));
}

{
  const err = wasiThreadsLoadError(inspectWasmThreads(wasm({
    imports: [SPAWN, FUTEX, importMemory('env', 'memory', { min: 2, max: 4, shared: false })],
    exports: [THREAD_START],
  })));
  check('a module importing an UNSHARED memory is rejected', () =>
    assert.match(err || '', /non-shared memory/));
}

{
  const err = wasiThreadsLoadError(inspectWasmThreads(wasm({
    imports: [SPAWN, FUTEX, importMemory('env', 'memory', { min: 2, max: null, shared: true })],
    exports: [THREAD_START],
  })));
  check('a shared memory without a maximum is rejected', () =>
    assert.match(err || '', /must declare a maximum/));
}

{
  const err = wasiThreadsLoadError(inspectWasmThreads(wasm({
    imports: [SPAWN, FUTEX, SHARED_MEM],
    exports: [exportFunc('_start', 1)],
  })));
  check(`a module that does not export ${WASI_THREAD_START_EXPORT} is rejected`, () =>
    assert.match(err || '', new RegExp(`does not export ${WASI_THREAD_START_EXPORT}`)));
}

{
  // The one a stock wasi-sdk build lands on: everything right except the futex
  // shim, so every contended lock would hit memory.atomic.wait32 and trap.
  const err = wasiThreadsLoadError(inspectWasmThreads(wasm({
    imports: [SPAWN, SHARED_MEM],
    exports: [THREAD_START],
  })));
  check('a stock threads build without the futex shim is rejected', () =>
    assert.match(err || '', /not linked against the Nimbus futex shim/));
  check('the futex rejection explains what would otherwise happen at runtime', () =>
    assert.match(err || '', /memory\.atomic\.wait32.*Atomics\.wait cannot be called in this context/s));
  // "Link the shim" is a dead end for the reader who already did. An old
  // wasi-libc has no __wasilibc_futex_wait_maybe_busy to call, so the linker
  // drops the definition as unreachable and the build reports nothing — the
  // module arrives here looking exactly like one that never linked it.
  check('the futex rejection names the toolchain floor that silently strips the shim', () =>
    assert.match(err || '', /wasi-sdk 27 or newer/));
  check('the futex rejection names the hook whose absence causes the strip', () =>
    assert.match(err || '', /__wasilibc_futex_wait_maybe_busy/));
}

// ── malformed input is answered, not thrown at ───────────────────────────────
{
  check('a non-wasm blob reports no threads', () =>
    assert.deepEqual(inspectWasmThreads(enc.encode('#!/bin/sh\necho hi\n')),
      { spawns: false, futex: false, memory: null, threadStart: false }));
  check('an empty blob reports no threads', () =>
    assert.deepEqual(inspectWasmThreads(new Uint8Array(0)),
      { spawns: false, futex: false, memory: null, threadStart: false }));
  check('a truncated section stops the walk instead of over-reading', () => {
    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x02, 0x40, 0x01]);
    assert.equal(inspectWasmThreads(bytes).spawns, false);
  });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
