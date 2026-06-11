#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { hasTopLevelModuleSyntax, hasTopLevelAwait } from '../../packages/worker/src/runtime/javascript-ast.ts';

assert.equal(hasTopLevelModuleSyntax('const x = 1; module.exports = x;'), false);
assert.equal(hasTopLevelModuleSyntax('export function f() { return 1; }'), true);
assert.equal(
  hasTopLevelModuleSyntax(`
export function strip(input) {
  return input.replace(/"(?:\\\\.|[^"\\\\])*"|\\/\\/[^\\n]*/g, "");
}
`),
  true,
);
assert.equal(hasTopLevelModuleSyntax('const text = "export function nope() {}";'), false);

// ── hasTopLevelAwait ──
assert.equal(hasTopLevelAwait('const x = 1;'), false);
assert.equal(hasTopLevelAwait('await foo();'), true);
assert.equal(hasTopLevelAwait('for await (const x of gen()) {}'), true);
// Regression: a default-value object parameter must NOT make an internal
// await read as top-level (the prior brace-depth heuristic false-positived,
// routing @bluwy/giget-core's download-template.js into the broken two-pass
// ESM→require rewrite → "Cannot use import statement outside a module").
assert.equal(
  hasTopLevelAwait('async function f(input, options = {}) { return await g(input); }'),
  false,
  'default-value object param must not false-positive TLA',
);
assert.equal(
  hasTopLevelAwait('export async function downloadTemplate(input, options = {}) { const t = await provider(input); return t; }'),
  false,
);
// await inside a nested arrow with a destructured default param — still not TLA.
assert.equal(
  hasTopLevelAwait('const run = async ({ a = {} } = {}) => { await a.go(); };'),
  false,
);
// `await` appearing only in a string/comment must not count.
assert.equal(hasTopLevelAwait('const s = "await foo()"; // await bar()'), false);

console.log('javascript-ast: ok');
