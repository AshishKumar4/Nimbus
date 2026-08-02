#!/usr/bin/env bun
// wasm-memory-limits — a wasm process must be able to run out of memory
// without taking the isolate with it.
//
// Every wasm binary Nimbus ships defines its own linear memory with limits
// flags 0x00: a minimum and NO maximum. Measured on the real production
// binaries: bash.async.wasm min 8 pages / max none, busybox.wasm min 2 / none,
// opentui.wasm min 260 / none. Unbounded growth is therefore the shipped
// default, and `memory.grow` keeps succeeding right up to the point where the
// isolate is killed — so the guest never learns it ran out of memory, and the
// supervisor sees a process that simply vanished.
//
// Measured on prod workerd (throwaway DO, 2026-08-02): a Durable Object
// sustains ~200 MiB of live wasm linear memory and then dies, with no
// difference between memory that was written to and memory merely reserved.
// Meanwhile the real bash binary run uncapped against a memory-exhausting
// script climbed to 3.4 GiB RSS before the wasm32 address-space ceiling
// finally handed it a NULL — 17x past the point where a DO is already gone.
//
// withMemoryLimit installs the declared maximum that makes the failure land
// inside the guest instead. Capped at 256 MiB, that same script produces
// `bash: xrealloc: cannot allocate 67108992 bytes` and exit 2 — bash's own
// error path, isolate intact.
//
// This test pins the mechanism, not the numbers: the limit must be installed
// where a guest grow can see it, it must only ever tighten, and it must never
// produce a module that cannot instantiate.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readMemoryLimits,
  withMemoryLimit,
  accountLinearMemory,
  measureResidentBytes,
  growWithinLimit,
  WasmOutOfMemoryError,
  WASM_PAGE_BYTES,
} from '../../packages/worker/src/runtime/wasm-memory.ts';

const BASH = new Uint8Array(
  readFileSync(new URL('../../packages/worker/wasm/bash/bash.async.wasm', import.meta.url)),
);

// ── The shipped hazard is real and this is what detects it ──────────────
const shipped = readMemoryLimits(BASH);
assert.ok(shipped, 'bash.async.wasm declares a linear memory');
assert.equal(shipped.imported, false,
  'bash defines its own memory, so the host cannot choose limits at instantiation');
assert.equal(shipped.maxPages, null,
  'the shipped binary declares NO maximum — this is the unbounded-growth hazard');

// ── Capping installs a maximum a guest grow can actually see ────────────
const capped = withMemoryLimit(BASH, 256 * 1024 * 1024);
const cappedLimits = readMemoryLimits(capped);
assert.equal(cappedLimits.maxPages, (256 * 1024 * 1024) / WASM_PAGE_BYTES,
  'the declared maximum is the requested cap in pages');
assert.equal(cappedLimits.minPages, shipped.minPages,
  'the minimum is untouched — capping must not change what the module needs to start');
assert.equal(cappedLimits.flags & 1, 1, 'the has-maximum bit is set');

// The rewritten module must still be a valid module. A cap that produced an
// uncompilable binary would trade a rare OOM for a total outage.
const mod = new WebAssembly.Module(capped);
assert.equal(WebAssembly.Module.imports(mod).length,
  WebAssembly.Module.imports(new WebAssembly.Module(BASH)).length,
  'rewriting the memory section leaves every import intact');

// ── The cap only ever tightens ──────────────────────────────────────────
const tight = withMemoryLimit(capped, 64 * 1024 * 1024);
assert.equal(readMemoryLimits(tight).maxPages, (64 * 1024 * 1024) / WASM_PAGE_BYTES,
  'a tighter cap replaces a looser one');
const loose = withMemoryLimit(tight, 512 * 1024 * 1024);
assert.equal(readMemoryLimits(loose).maxPages, (64 * 1024 * 1024) / WASM_PAGE_BYTES,
  'a looser cap must NOT raise an existing maximum');

// A module already at the requested cap is returned unchanged, so repeated
// capping in a runtime start path allocates nothing.
assert.equal(withMemoryLimit(tight, 64 * 1024 * 1024), tight,
  'a no-op cap returns the same buffer rather than a copy');

// ── A cap below the declared minimum is refused, not silently applied ───
assert.throws(
  () => withMemoryLimit(BASH, 4 * WASM_PAGE_BYTES),
  RangeError,
  'capping below the module minimum would yield a module that cannot instantiate',
);
assert.throws(() => withMemoryLimit(BASH, 0), RangeError, 'a zero cap is refused');

// ── Accounting is exact, and says so by matching the engine ─────────────
const memory = new WebAssembly.Memory({ initial: 4, maximum: 16 });
const usage = accountLinearMemory(memory, { minPages: 4, maxPages: 16, flags: 1 });
assert.equal(usage.bytes, memory.buffer.byteLength,
  'reported bytes ARE the engine-committed size, not an estimate');
assert.equal(usage.pages, 4);
assert.equal(usage.limitBytes, 16 * WASM_PAGE_BYTES);
assert.equal(accountLinearMemory(memory).limitBytes, null,
  'with no declared limits the ceiling is reported as unknown, never as a guess');

// Residency skips all-zero pages and counts the rest whole.
assert.equal(measureResidentBytes(memory), 0, 'a fresh memory is entirely zero');
new Uint8Array(memory.buffer)[2 * WASM_PAGE_BYTES + 17] = 0xff;
assert.equal(measureResidentBytes(memory), WASM_PAGE_BYTES,
  'one written byte makes exactly one page resident');

// ── Host-initiated growth refuses to cross the cap, as ENOMEM ───────────
const before = growWithinLimit(memory, 2, 16 * WASM_PAGE_BYTES);
assert.equal(before, 4, 'growWithinLimit returns the previous size in pages');
assert.equal(memory.buffer.byteLength, 6 * WASM_PAGE_BYTES);

let refused;
try {
  growWithinLimit(memory, 100, 16 * WASM_PAGE_BYTES);
} catch (e) {
  refused = e;
}
assert.ok(refused instanceof WasmOutOfMemoryError, 'crossing the cap raises WasmOutOfMemoryError');
assert.equal(refused.code, 'ENOMEM', 'the failure carries an errno a runtime can report');
assert.equal(memory.buffer.byteLength, 6 * WASM_PAGE_BYTES,
  'a refused grow leaves the memory untouched');

// ── Modules with no memory, and imported memories, are left alone ───────
// wat: (module) — the smallest valid module.
const EMPTY = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
assert.equal(readMemoryLimits(EMPTY), null, 'a module without a memory reports none');
assert.equal(withMemoryLimit(EMPTY, 1 << 20), EMPTY, 'and is returned unchanged');

console.log('wasm-memory-limits: ok');
