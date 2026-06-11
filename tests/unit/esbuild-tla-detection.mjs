#!/usr/bin/env bun
// Unit test for EsbuildService.transform's top-level-await detector.
// Regression: a default-value object parameter (`async function f(opts = {})`)
// must NOT make an internal await read as top-level — the prior brace-depth
// heuristic false-positived because the `= {}` braces consumed the
// function-body tracking slot, routing @bluwy/giget-core's
// download-template.js into the broken two-pass ESM→require rewrite
// ("Cannot use import statement outside a module" at facet startup).

import assert from 'node:assert/strict';
import { hasTopLevelAwait } from '../../packages/worker/src/runtime/esbuild-service.ts';

// No await → false.
assert.equal(hasTopLevelAwait('const x = 1;'), false);
// Genuine top-level await → true.
assert.equal(hasTopLevelAwait('await foo();'), true);
assert.equal(hasTopLevelAwait('const x = await import("y");'), true);

// Await inside a function → false.
assert.equal(hasTopLevelAwait('async function f() { await g(); }'), false);

// Regression: default-value object parameter before an internal await.
assert.equal(
  hasTopLevelAwait('async function f(input, options = {}) { return await g(input); }'),
  false,
  'default-value object param must not false-positive TLA',
);
assert.equal(
  hasTopLevelAwait('export async function downloadTemplate(input, options = {}) { const t = await provider(input); return t; }'),
  false,
);
// Arrow with a destructured default param.
assert.equal(
  hasTopLevelAwait('const run = async ({ a = {} } = {}) => { await a.go(); };'),
  false,
);
// `await` only inside a string / comment must not count.
assert.equal(hasTopLevelAwait('const s = "await foo()"; // await bar()'), false);

console.log('esbuild-tla-detection: ok');
