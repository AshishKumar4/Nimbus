#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { hasTopLevelModuleSyntax } from '../../packages/worker/src/runtime/javascript-ast.ts';

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

console.log('javascript-ast: ok');
