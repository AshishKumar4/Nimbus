#!/usr/bin/env bun
// Exercise the memory cap through guest memory.grow, not a test-only binary decoder.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withMemoryLimit, WASM_PAGE_BYTES } from '../../packages/core/src/runtime/wasm-memory.ts';

const bash = new Uint8Array(readFileSync(new URL('../../packages/worker/wasm/bash/bash.async.wasm', import.meta.url)));
const capped = withMemoryLimit(bash, 256 * 1024 * 1024);
assert.ok(WebAssembly.validate(capped), 'the shipped runtime remains a valid module');
assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(capped)), WebAssembly.Module.imports(new WebAssembly.Module(bash)), 'the cap preserves the runtime import contract');
assert.throws(() => withMemoryLimit(bash, 4 * WASM_PAGE_BYTES), RangeError, 'a cap below the shipped minimum is refused');
assert.throws(() => withMemoryLimit(bash, 0), RangeError);

// (module (memory 1) (func (export "g") (param i32) (result i32) local.get 0 memory.grow))
const grower = new Uint8Array([
  0,97,115,109,1,0,0,0,
  1,6,1,96,1,127,1,127,
  3,2,1,0,
  5,3,1,0,1,
  7,5,1,1,103,0,0,
  10,8,1,6,0,32,0,64,0,11,
]);
const guest = (bytes) => new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.g;
assert.equal(guest(grower)(20), 1, 'uncapped growth succeeds');
const limited = withMemoryLimit(grower, 8 * WASM_PAGE_BYTES);
const grow = guest(limited);
assert.equal(grow(3), 1, 'growth within the cap succeeds');
assert.equal(grow(20), -1, 'growth beyond the cap fails in the guest');
const tighter = withMemoryLimit(limited, 4 * WASM_PAGE_BYTES);
assert.equal(guest(tighter)(4), -1, 'a tighter cap is enforced');
assert.equal(guest(withMemoryLimit(tighter, 8 * WASM_PAGE_BYTES))(4), -1, 'a later looser request cannot raise the cap');
assert.equal(guest(withMemoryLimit(tighter, 4 * WASM_PAGE_BYTES))(3), 1, 'reapplying a cap preserves allowed growth');

const empty = new Uint8Array([0,97,115,109,1,0,0,0]);
assert.ok(WebAssembly.validate(withMemoryLimit(empty, 1 << 20)), 'a memoryless module remains valid');
// (module (import "env" "memory" (memory 1 100 shared)))
const threads = new Uint8Array([
  0,97,115,109,1,0,0,0,
  2,16,1,3,101,110,118,6,109,101,109,111,114,121,2,3,1,100,
]);
const memory = new WebAssembly.Memory({ initial: 1, maximum: 100, shared: true });
new WebAssembly.Instance(new WebAssembly.Module(withMemoryLimit(threads, 8 * WASM_PAGE_BYTES)), { env: { memory } });
assert.equal(memory.grow(20), 1, 'imported memory remains governed by the host');
console.log('wasm-memory-limits: guest growth, tightening, runtime validity and imported memory pass');
