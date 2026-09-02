#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hasTopLevelModuleSyntax } from '../../packages/core/src/runtime/javascript-ast.ts';

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
assert.equal(hasTopLevelModuleSyntax('async function load() { return import("x"); }'), false);
assert.equal(hasTopLevelModuleSyntax('const url = import.meta.url;'), false);

// Pi 0.84.3 changed its executable from dist/cli.js to a split ESM bundle
// whose largest chunk is 3.7 MiB. The old detector built a complete Acorn AST
// just to answer yes/no; that one call retained about 80 MiB and reset the
// 128 MiB session isolate before Pi could start. Exercise the public helper in
// a constrained process: a streaming syntax detector fits, an AST does not.
const moduleUrl = new URL('../../packages/core/dist/runtime/javascript-ast.js', import.meta.url).href;
const stress = spawnSync('node', [
  '--max-old-space-size=48',
  '--input-type=module',
  '--eval',
  [
    `import { hasTopLevelModuleSyntax } from ${JSON.stringify(moduleUrl)};`,
    'const source = "export default [" + "0,".repeat(1400000) + "];";',
    'if (!hasTopLevelModuleSyntax(source)) process.exit(2);',
  ].join('\n'),
], { encoding: 'utf8', timeout: 30_000 });
assert.equal(
  stress.status,
  0,
  `large-module detection exceeded a 48 MiB heap: ${stress.error?.message ?? stress.stderr?.slice(-1200) ?? 'no child diagnostics'}`,
);

console.log('javascript-ast: ok');
