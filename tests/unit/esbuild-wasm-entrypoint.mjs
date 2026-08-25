#!/usr/bin/env bun
// The esbuild namespace this service loads must accept a precompiled
// WebAssembly.Module.
//
// Regression: `loadEsbuild()` used the bare specifier `esbuild-wasm`.
// That package ships no `exports` map, so `main` (`lib/main.js`, the Node
// CJS build) wins in every resolver that ignores the legacy `browser`
// field — Node, Bun, and the worker environment of a host bundler, since
// Vite leaves `browser` out of `resolve.mainFields` for every non-client
// environment. `lib/main.js` refuses the only initialization form a Worker
// has, and `node file.mjs` in a deployed Nimbus workspace failed with
//
//     esbuild init failed: The "wasmModule" option only works in the browser
//
// The fix names `esbuild-wasm/esm/browser.js`, the same build
// packages/worker/scripts/bundle-esbuild-wasm.mjs already stages for facets.
//
// This test drives the service's own loader rather than restating its
// specifier. A test holding its own copy would grade the copy, and nothing
// graded the resolution — which is why the defect reached production.
//
// Bun resolves like Node here, so the resolution class under test is the
// one that broke, and the assertion below fails against the pre-fix code.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadEsbuild } from '../../packages/core/src/runtime/esbuild-service.ts';

const esb = await loadEsbuild();

// Every call site reached through EsbuildService uses these.
for (const name of ['initialize', 'transform', 'build', 'stop']) {
  assert.equal(typeof esb[name], 'function', `the loaded build exports ${name}()`);
}

// The wasm the supervisor hands to initialize() is a compiled module. The
// host bundler produces it from a static `.wasm` import; here we compile the
// installed binary, which is the same bytes.
const wasmModule = await WebAssembly.compile(
  await readFile(new URL(import.meta.resolve('esbuild-wasm/esbuild.wasm'))),
);
assert.ok(wasmModule instanceof WebAssembly.Module, 'esbuild.wasm compiles');

// The assertion the defect violated. `worker: false` matches the service:
// workerd has no `new Worker`, so the build must run in-isolate.
await esb.initialize({ wasmModule, worker: false });

// Initialization alone can pass on a build that cannot do the work, so the
// probe ends where the user did: transforming a module.
const ts = await esb.transform('const x: number = 1; export default x;', {
  loader: 'ts',
  format: 'esm',
});
assert.match(ts.code, /const x = 1;/, 'a TypeScript transform returns stripped JS');

const mjs = await esb.transform('export const hello = async () => await Promise.resolve(1);', {
  loader: 'js',
  format: 'esm',
});
assert.match(mjs.code, /hello/, 'an .mjs transform returns its export');

// initialize() is once per isolate. ensureInit() reads the second failure as
// "already ready" by matching `more than once` on the message, so that string
// is a contract. This build throws synchronously and a future one may reject,
// which is why the shape is not asserted — only the message ensureInit reads.
let second;
try {
  await esb.initialize({ wasmModule, worker: false });
} catch (e) {
  second = e;
}
assert.ok(second, 'a second initialize() fails');
assert.match(
  String(second.message),
  /more than once/,
  'the second failure carries the message ensureInit() matches on',
);

console.log('esbuild-wasm-entrypoint: ok');
