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

// ── The guest actually observes the cap ─────────────────────────────────
// Everything above asserts the encoding. This asserts the mechanism the
// encoding exists for: a `memory.grow` executed INSIDE the module must return
// -1 past the cap, which is what makes dlmalloc hand the program a NULL
// instead of the engine handing the isolate a death sentence.
//
// wat: (module (memory 1) (func (export "g") (param i32) (result i32)
//                           local.get 0  memory.grow))
const GROWER = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
  0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f, // type:   (i32) -> i32
  0x03, 0x02, 0x01, 0x00,                         // func:   one, of type 0
  0x05, 0x03, 0x01, 0x00, 0x01,                   // memory: min 1, no maximum
  0x07, 0x05, 0x01, 0x01, 0x67, 0x00, 0x00,       // export: "g" -> func 0
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x20, 0x00, 0x40, 0x00, 0x0b, // code
]);

const uncapped = new WebAssembly.Instance(new WebAssembly.Module(GROWER));
assert.equal(uncapped.exports.g(20), 1,
  'uncapped, a 20-page grow succeeds — the shipped default has no ceiling to hit');

const grower = new WebAssembly.Instance(
  new WebAssembly.Module(withMemoryLimit(GROWER, 8 * WASM_PAGE_BYTES)),
);
assert.equal(grower.exports.g(3), 1,
  'a grow that stays under the cap still succeeds — the cap is a ceiling, not a freeze');
assert.equal(grower.exports.g(20), -1,
  'a grow past the cap returns -1 to the GUEST, which is how malloc learns to fail');
assert.equal(grower.exports.memory, undefined,
  'and none of this required the module to export its memory');

// ── Modules with no memory, and imported memories, are left alone ───────
// wat: (module) — the smallest valid module.
const EMPTY = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
assert.equal(readMemoryLimits(EMPTY), null, 'a module without a memory reports none');
assert.equal(withMemoryLimit(EMPTY, 1 << 20), EMPTY, 'and is returned unchanged');

// A wasi-threads build is exactly this shape: it imports a SHARED memory and
// names its own ceiling on the build line (`--import-memory --shared-memory
// --max-memory=<bytes>`). It must pass through byte-identical — rewriting a
// shared memory's limits, or capping one whose maximum the runtime already
// reserves against, would break pthread parity rather than protect anything.
// wat: (module (import "env" "memory" (memory 1 100 shared)))
const THREADS = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x02, 0x11, 0x01,                               // import section, one entry
  0x03, 0x65, 0x6e, 0x76,                         // module "env"
  0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79,       // field  "memory"
  0x02, 0x03, 0x01, 0x64,                         // memory, flags 3, min 1, max 100
]);
const threadsLimits = readMemoryLimits(THREADS);
assert.equal(threadsLimits.imported, true, 'a threads build imports its memory');
assert.equal(threadsLimits.flags & 2, 2, 'and that memory is shared');
assert.equal(withMemoryLimit(THREADS, 128 * 1024 * 1024), THREADS,
  'so the cap leaves it alone — the host chooses those limits at instantiation');

console.log('wasm-memory-limits: ok');
