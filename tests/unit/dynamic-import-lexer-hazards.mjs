#!/usr/bin/env bun
// Where es-module-lexer's reading of a cell can differ from the grammar's
// (import-lexer-hazards.ts), the grammar decides the cell's imports. Each row
// is a cell with such a spot ahead of its one real import(): rewritten, the
// cell must run as a script, as it reads, and that import must go to the
// process. Regexes holding import syntax are text; code the lexer could take
// for a regex, or for a string, is code.

import assert from 'node:assert/strict';
import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';

const parent = 'file:///home/user/app/main.cjs';

// [what the lexer can misread, cell, what the cell returns]
const rows = [
  // A `/` the lexer reads as a division where the grammar reads a regex.
  ['a regex after a block', "{}\n/import('fake')/.test('');\nreturn import('./x.mjs').then(m => m.value);", 7],
  ['a regex after ++ opening a line', "var a = 6;\na\n++/import('fake')/.lastIndex;\nreturn import('./x.mjs').then(m => [a, m.value]);", [6, 7]],
  ['a regex after extends', "class A extends /import('fake')/.constructor {}\nreturn import('./x.mjs').then(m => [A.name, m.value]);", ['A', 7]],
  ['a regex after of', "for (const c of /import('fake')/.source.slice(0, 1)) {}\nreturn import('./x.mjs').then(m => m.value);", 7],
  ['a regex after a with head', "with ({}) /import('fake')/.test('');\nreturn import('./x.mjs').then(m => m.value);", 7],
  ['a regex after a for await head', "return (async () => {\n  for await (const x of []) /import('fake')/.test('');\n  return import('./x.mjs').then(m => m.value);\n})();", 7],
  ['a quoted regex after a block, which the lexer cannot lex', "{}\n/[\"']/.test('x');\nreturn import('./x.mjs').then(m => m.value);", 7],
  // A `/` the lexer reads as a regex where the grammar reads a division.
  ['a division after yield, an identifier', "var yield = 8; const loaded = []; const ratio = yield / (loaded.push(import('./x.mjs')), 4) / 2;\nreturn Promise.all(loaded).then(([m]) => [ratio, m.value]);", [1, 7]],
  ['a division after a keyword member past a line break', "var o = { return: 6 };\nconst loaded = [];\nconst ratio = o.\nreturn / (loaded.push(import('./x.mjs')), 3) / 2;\nreturn Promise.all(loaded).then(([m]) => [ratio, m.value]);", [1, 7]],
  // HTML-like comments, which the lexer reads as code.
  ['an HTML open comment holding a quote', "<!-- it's\nreturn import('./x.mjs').then(m => m.value);", 7],
  ['an HTML close comment holding a quote', "var x = 1;\n--> it's\nreturn import('./x.mjs').then(m => m.value);", 7],
];

const failures = [];
for (const [misread, cell, expected] of rows) {
  const calls = [];
  globalThis.__nimbusDynamicImport = async (from, name) => {
    calls.push([from, name]);
    return { value: 7 };
  };
  try {
    const run = new Function('exports', 'require', 'module', rewriteDynamicImports(cell, parent));
    assert.deepEqual(await run({}, undefined, {}), expected);
    assert.deepEqual(calls, [[parent, './x.mjs']], 'the import goes to the process');
  } catch (error) {
    failures.push(`${misread}: ${error.message}`);
  } finally {
    delete globalThis.__nimbusDynamicImport;
  }
}
assert.deepEqual(failures, []);

// `new import(...)` stays the syntax error it is, not a constructor call.
assert.throws(() => new Function(rewriteDynamicImports("return new import('./x.mjs');", parent)), SyntaxError);

console.log(`dynamic-import-lexer-hazards OK: ${rows.length} misreadable cells read as the grammar reads them`);
