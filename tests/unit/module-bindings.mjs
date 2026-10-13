#!/usr/bin/env bun
// What Node's linker checks of a module, as a launch's staging reads it
// (core dynamic-import-rewrite.ts readModuleImportSites, `bindings`): by
// static specifier, the names its import or re-export reads of that module
// (`default` a default import's), whether it is `export *` and its `type`
// attribute (V8 drops a static import's other keys); the names the module
// exports itself, and which of them are another module's (re-exports, and
// exports of imported bindings: ResolveExport's indirect entries). A module
// the lexer reads and one only the grammar reads (a string import name)
// give the same answer.

import assert from 'node:assert/strict';
import { readModuleImportSites } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';

const DECLARATIONS = [
  "import d, { a as b } from './x';",
  "import * as ns from './y';",
  "import './side';",
  "export { q as r, s, default as zd } from './z';",
  "export * from './star';",
  "export * as nsx from './nsx';",
  "import /* c */ { /* d */ g /* e */ } /* f */ from './g';",
  "import from from './from';",
  "import e, * as all from './both';",
  "import j from './data.json' with { type: 'json' };",
  "import mj from './more.json' with { mode: 'x', type: 'json' };",
  "import mx from './mode.js' with { mode: 'x' };",
  'export { b as bb, ns as nso };',
  'export const k = 1, m = 2;',
  'export function f() {}',
  'export default class {}',
];
const IMPORTS = [['default', 'a'], [], [], ['q', 's', 'default'], [], [], ['g'], ['default'], ['default'], ['default'], ['default'], ['default']];
const TYPES = [null, null, null, null, null, null, null, null, null, 'json', 'json', null];
const EXPORTS = ['bb', 'default', 'f', 'k', 'm', 'nso', 'nsx', 'r', 's', 'zd'];
const REEXPORTS = [['bb', 0, 'a'], ['nso', 1, null], ['nsx', 5, null], ['r', 3, 'q'], ['s', 3, 's'], ['zd', 3, 'default']];

function bindingsOf(text) {
  const { statics, bindings } = readModuleImportSites(text);
  assert.ok(bindings, 'its bindings are read');
  assert.equal(bindings.imports.length, statics.length, 'one entry per static specifier');
  assert.deepEqual(statics.map((site) => site.attributes), [...bindings.types].map((type) => (type === null ? {} : { type })), 'a site checks its type alone');
  const reexports = [...bindings.reexports].map((entry) => [...entry]).sort(([a], [b]) => (a < b ? -1 : 1));
  return { imports: bindings.imports.map((names) => [...names]), stars: [...bindings.stars], exports: [...bindings.exports].sort(), types: [...bindings.types], reexports };
}

assert.deepEqual(bindingsOf(DECLARATIONS.join('\n')), { imports: IMPORTS, stars: [4], exports: EXPORTS, types: TYPES, reexports: REEXPORTS }, 'as the lexer reads it');

// A string import name is the grammar's to read.
assert.deepEqual(
  bindingsOf([...DECLARATIONS, "import { 'a-b' as ab } from './strings';", "export { k as 'k-k' };"].join('\n')),
  { imports: [...IMPORTS, ['a-b']], stars: [4], exports: [...EXPORTS, 'k-k'].sort(), types: [...TYPES, null], reexports: REEXPORTS },
  'as the grammar reads it',
);

console.log('module bindings ok');
