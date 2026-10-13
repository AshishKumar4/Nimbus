#!/usr/bin/env bun
// What Node's linker checks of a module, as a launch's staging reads it
// (core dynamic-import-rewrite.ts readModuleImportSites, `bindings`): by
// static specifier, the names its import or re-export reads of that module
// (`default` a default import's) and whether it is `export *`; and the
// names the module exports itself. A module the lexer reads and one only
// the grammar reads (a string import name) give the same answer.

import assert from 'node:assert/strict';
import { readModuleImportSites } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';

const DECLARATIONS = [
  "import d, { a as b } from './x';",
  "import * as ns from './y';",
  "import './side';",
  "export { q as r, s, default } from './z';",
  "export * from './star';",
  "export * as nsx from './nsx';",
  "import /* c */ { /* d */ g /* e */ } /* f */ from './g';",
  "import from from './from';",
  "import e, * as all from './both';",
  "import j from './data.json' with { type: 'json' };",
  'export const k = 1, m = 2;',
  'export function f() {}',
  'export default class {}',
];
const IMPORTS = [['default', 'a'], [], [], ['q', 's', 'default'], [], [], ['g'], ['default'], ['default'], ['default']];
const EXPORTS = ['default', 'f', 'k', 'm', 'nsx', 'r', 's'];

function bindingsOf(text) {
  const { statics, bindings } = readModuleImportSites(text);
  assert.ok(bindings, 'its bindings are read');
  assert.equal(bindings.imports.length, statics.length, 'one entry per static specifier');
  return { imports: bindings.imports.map((names) => [...names]), stars: [...bindings.stars], exports: [...bindings.exports].sort() };
}

assert.deepEqual(bindingsOf(DECLARATIONS.join('\n')), { imports: IMPORTS, stars: [4], exports: EXPORTS }, 'as the lexer reads it');

// A string import name is the grammar's to read.
assert.deepEqual(
  bindingsOf([...DECLARATIONS, "import { 'a-b' as ab } from './strings';", "export { k as 'k-k' };"].join('\n')),
  { imports: [...IMPORTS, ['a-b']], stars: [4], exports: [...EXPORTS, 'k-k'].sort() },
  'as the grammar reads it',
);

console.log('module bindings ok');
