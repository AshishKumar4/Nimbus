#!/usr/bin/env bun
// wasm-refusal-learned — a compile of wasm bytes the launch does not carry is
// named when it is refused, and the bytes are learned for the next launch of
// the command, which carries them by digest.
//
// A Worker compiles wasm only from its launch's module map. An image that
// comes from no file (a 286-byte module nuxt dev compiles at startup, built
// in memory) has no path for the closure walk to record, so the seam refused
// it on every launch, and its caller caught the refusal and carried on
// without it: silently, and never learned. A refused image that validates is
// a module Node would have compiled: the seam now says so on stderr, once per
// image, and records it as runtime code (commonjs-cell.ts, RUNTIME CODE), the
// way code a launch could not compile is; the next launch stages it as a wasm
// member registered by its digest. Bytes that do not validate fail under Node
// too, and are neither named nor learned.
import assert from 'node:assert/strict';
import {
  COMMONJS_CELL_IMPORTS, COMMONJS_CELL_RUNTIME_SOURCE, RUNTIME_INTERPRETER_PRIMORDIALS_MODULE,
  RUNTIME_WASM_MAX_BYTES, parseRuntimeCodeEntry, runtimeCodeCharge, runtimeCodeKey,
} from '../../packages/core/src/_shared/commonjs-cell.ts';
import { learnedWasmImages } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { importModuleSet } from './lib/module-map-bundle.mjs';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';

// A valid module: one function exported as "f" (24 + 7 bytes), then a custom section.
const moduleWith = (custom) => {
  const head = [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 4, 1, 2, 0, 11];
  const name = [1, 112];
  const payload = name.length + custom;
  const size = [];
  for (let n = payload; ; ) { const b = n & 0x7f; n >>>= 7; if (n === 0) { size.push(b); break; } size.push(b | 0x80); }
  const bytes = new Uint8Array(head.length + 1 + size.length + payload);
  bytes.set(head); bytes[head.length] = 0; bytes.set(size, head.length + 1); bytes.set(name, head.length + 1 + size.length);
  return bytes;
};
const image = moduleWith(250);
assert.ok(WebAssembly.validate(image), 'fixture validates');
const invalid = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 5, 1, 3, 0, 255, 11]);
assert.equal(WebAssembly.validate(invalid), false, 'fixture does not validate');
const oversized = moduleWith(RUNTIME_WASM_MAX_BYTES);
assert.ok(WebAssembly.validate(oversized) && oversized.byteLength > RUNTIME_WASM_MAX_BYTES, 'fixture validates and is over the limit');

// ── the launch's runtime records a refused image as runtime code ──
{
  const { flush } = await importModuleSet({
    'main.js': `${COMMONJS_CELL_IMPORTS}
const __NIMBUS_CODE_CELLS = [];
const __NIMBUS_RUNTIME_CODE = [];
${COMMONJS_CELL_RUNTIME_SOURCE}
export const flush = __nimbusFlushRuntimeCode;`,
    [RUNTIME_INTERPRETER_PRIMORDIALS_MODULE]: { cjs: nodeFacetSources('').interpreterPrimordials },
  }, 'main.js');
  const runtime = globalThis.__nimbusRuntimeCode;
  assert.equal(runtime.recordWasm(image), true, 'an image under the limit is recorded');
  assert.equal(runtime.recordWasm(new Uint8Array(image)), true, 'the same bytes again are the same entry');
  assert.equal(runtime.recordWasm(oversized), false, 'an image over the limit is not');
  const reports = [];
  await flush({ async reportRuntimeCode(entries) { reports.push(entries); } });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].length, 1, 'one entry for one image');
  const [entry] = reports[0];
  assert.equal(entry.kind, 'wasm');
  assert.deepEqual(new Uint8Array(Buffer.from(entry.bytes, 'base64')), image, 'its bytes, as base64');
  assert.deepEqual(parseRuntimeCodeEntry(entry), entry, 'the supervisor accepts it');
  assert.equal(parseRuntimeCodeEntry({ kind: 'wasm', bytes: 'not base64!' }), null, 'and refuses bytes that are not base64');
  assert.ok(runtimeCodeCharge(entry) >= entry.bytes.length, 'charged at least its bytes');
  assert.match(runtimeCodeKey(entry), /^[0-9a-f]{64}$/);

  // ── the next launch carries it, by its bytes ──
  const learned = learnedWasmImages(new Map([
    ['k1', { kind: 'module', path: 'home/user/a.js', text: 'x' }],
    [runtimeCodeKey(entry), entry],
  ]));
  assert.deepEqual(learned.map((bytes) => [...bytes]), [[...image]], 'a learned image is staged; other runtime code is not an image');
  console.log('  a refused image is recorded as runtime code, and staged by the next launch');
}

// ── the seam names each refused image once, and records the ones Node would compile ──
{
  const shims = generateShimsCode();
  const seam = shims.slice(shims.indexOf('const __nimbusPrecompiledWasm ='), shims.indexOf('// ═══', shims.indexOf('WA.__nimbusPrecompiledSeam = true')));
  const refuse = () => { throw new Error('Wasm code generation disallowed by embedder'); };
  const WA = { Module: function Module() { refuse(); }, compile: async () => refuse(), instantiate: async () => refuse(), validate: (b) => WebAssembly.validate(b) };
  WA.Module.prototype = {};
  const lines = [];
  const recorded = [];
  const scope = {
    WebAssembly: WA,
    __nimbusPrecompiledWasm: new Map(),
    __nimbusPrecompiledWasmByDigest: new Map(),
    process: { stderr: { write: (text) => { lines.push(String(text)); return true; } } },
    __nimbusRuntimeCode: { recordWasm: (bytes) => { recorded.push(bytes); return bytes.byteLength <= RUNTIME_WASM_MAX_BYTES; } },
  };
  new Function('globalThis', '__BufferMod', seam)(scope, { from: (x) => x });

  assert.throws(() => scope.WebAssembly.Module(new Uint8Array(image)), /WebAssembly cannot be compiled from bytes here/);
  assert.equal(lines.length, 1, 'the refusal is named');
  assert.match(lines[0], new RegExp(`${image.byteLength} bytes`));
  assert.match(lines[0], /the next launch of this command carries it/);
  assert.equal(recorded.length, 1, 'and its bytes are recorded');
  await assert.rejects(scope.WebAssembly.compile(new Uint8Array(image)), /WebAssembly cannot be compiled from bytes here/);
  await assert.rejects(scope.WebAssembly.instantiate(new Uint8Array(image), {}), /WebAssembly cannot be compiled from bytes here/);
  assert.equal(lines.length, 1, 'once per image, however it is compiled');
  assert.equal(recorded.length, 1);

  assert.throws(() => scope.WebAssembly.Module(invalid));
  assert.equal(lines.length, 1, 'bytes that do not validate fail under Node too: not named');
  assert.equal(recorded.length, 1, 'nor learned');

  assert.throws(() => scope.WebAssembly.Module(oversized));
  assert.equal(lines.length, 2, 'an image over the limit is named');
  assert.match(lines[1], /not staged/);
  console.log('  the seam names a refused image once, and records what validates');
}

// ── an instantiate that fails after its compile is not a refusal ──
// A module that compiles and then fails to link (its imports) or traps keeps
// its own error: the seam neither names nor learns it, nor relabels it as a
// refused compile, which lost its class (nuxt dev: 286 bytes, every launch).
{
  const shims = generateShimsCode();
  const seam = shims.slice(shims.indexOf('const __nimbusPrecompiledWasm ='), shims.indexOf('// ═══', shims.indexOf('WA.__nimbusPrecompiledSeam = true')));
  const real = globalThis.WebAssembly;
  const WA = {
    Module: real.Module, compile: real.compile.bind(real), instantiate: real.instantiate.bind(real),
    validate: real.validate.bind(real), Instance: real.Instance, LinkError: real.LinkError, CompileError: real.CompileError,
  };
  const lines = [];
  const recorded = [];
  const scope = {
    WebAssembly: WA,
    __nimbusPrecompiledWasm: new Map(),
    __nimbusPrecompiledWasmByDigest: new Map(),
    process: { stderr: { write: (text) => { lines.push(String(text)); return true; } } },
    __nimbusRuntimeCode: { recordWasm: (bytes) => { recorded.push(bytes); return true; } },
  };
  new Function('globalThis', '__BufferMod', seam)(scope, { from: (x) => x });
  // A module importing m.f, a function.
  const importing = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 7, 1, 1, 109, 1, 102, 0, 0]);
  assert.ok(real.validate(importing), 'fixture validates');
  await assert.rejects(scope.WebAssembly.instantiate(importing, { m: { f: 1 } }), (error) => error instanceof real.LinkError,
    'a link failure is the LinkError it is');
  const { instance } = await scope.WebAssembly.instantiate(importing, { m: { f() {} } });
  assert.ok(instance instanceof real.Instance, 'and with its imports, it instantiates');
  assert.deepEqual(lines, [], 'nothing is named');
  assert.deepEqual(recorded, [], 'nothing is learned');
  console.log('  an instantiate that fails after its compile keeps its own error');
}

console.log('wasm-refusal-learned: ok');
