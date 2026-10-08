#!/usr/bin/env bun
// lowerEsModule, the one lowering of an ES module to the CommonJS a cell runs,
// as the transform host completes it (dynamic-import-rewrite.ts binding
// import.meta and routing import()) and as a cell runs it: the wrapper's
// require and module are its arguments. Imports stay live, a default export
// evaluates where it stands, top-level await takes the async body, and every
// line of the module, and every column outside a use of an import, is where
// the source has it.

import assert from 'node:assert/strict';
import { lowerEsModule } from '../../packages/core/src/runtime/async-module-lowering.ts';
import { rewriteDynamicImports } from '../../packages/core/src/runtime/dynamic-import-rewrite.ts';
import { MODULE_BODY_MARK } from '../../packages/core/src/runtime/javascript-ast.ts';

const url = 'file:///home/user/node_modules/pkg/chunk.js';
const lowered = (source) => rewriteDynamicImports(lowerEsModule(source, 'node').code, url, true);
// Runs lowered code as a cell's wrapper does (commonjs-cell.ts: strict, in a
// block, which its own `const require` shadows); its result, an async body's promise.
const run = (code, require, meta = {}) => {
  const module = { exports: {}, __nimbusImportMeta: meta };
  const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', `"use strict";{${code}\n}`);
  const result = wrapper(module.exports, require, module, '/chunk.js', '/');
  return { module, result };
};
const noRequire = () => { throw new Error('unexpected require'); };

{
  const source = [
    'import { createRequire as makeRequire } from "node:module";',
    'const require = makeRequire(import.meta.url);',
    'import defaultThing,{\nvalue as alias\n}from"./dep.js";import"./side.js";',
    'let counter = 0; function increment() { counter++; }',
    'const url = import.meta.url;',
    'function use() { return [defaultThing, alias, require("local"), url]; }',
    'export{counter,increment,use};',
  ].join('');
  let sideEffects = 0;
  const { module } = run(lowered(source), (specifier) => {
    if (specifier === 'node:module') return { createRequire: () => (id) => id === 'local' ? 'local' : null };
    if (specifier === './dep.js') return { __esModule: true, default: 'default', value: 'dep' };
    if (specifier === './side.js') { sideEffects++; return {}; }
    throw new Error(`unexpected module: ${specifier}`);
  }, { url });
  assert.equal(sideEffects, 1);
  assert.equal(module.exports.counter, 0);
  module.exports.increment();
  assert.equal(module.exports.counter, 1, 'named exports remain live bindings');
  assert.deepEqual(module.exports.use(), ['default', 'dep', 'local', url]);
}

{
  // A declaration without its semicolon ends where the parse says, not at the next `;`.
  const { module } = run(lowered('import x from "x"\nconst y = x; export { y };'), (name) => {
    assert.equal(name, 'x');
    return { __esModule: true, default: 'x-default' };
  });
  assert.equal(module.exports.y, 'x-default');
}

{
  // A default export evaluates where it stands, before the statements after it.
  const { module } = run(lowered('const order = ["first"]; export default order.join(); order.push("later");'), noRequire);
  assert.equal(module.exports.default, 'first', 'read before the later push');
}

// Top-level await, and only it, takes the async body.
for (const [source, async] of [
  ['const boot = async () => {}; await boot(); export { boot };', true],
  ['const load = () => run(async () => await value); export { load };', false],
  ['const load = () => 1, value = await boot(); export { load };', true],
  ['const iterator = { async *[Symbol.asyncIterator]() { await read(); } }; export { iterator };', false],
  ['import x from "y"; var a = { class: "x" }; if (a) { await boot(); } export { a };', true],
  ['for await (const x of xs) use(x); export {};', true],
  ['class C { async m() { for await (const x of xs); } } export { C };', false],
]) {
  assert.equal(lowerEsModule(source, 'node').code.includes('return (async () => {'), async, source);
}
{
  const { module, result } = run(lowered('export let db; db = await Promise.resolve("connected");'), noRequire);
  await result;
  assert.equal(module.exports.db, 'connected');
}

// import() goes to the process's loader, and any import.meta member reads the module's metadata.
{
  const code = lowered('import { a } from "dep";\nexport async function boot() { return [a, await import("node:http")]; }\nexport const here = import.meta.dirname ?? import.meta.url;\n');
  assert.doesNotMatch(code, /\bimport\(/, 'the dynamic import is routed');
  const { module } = run(code, () => ({ a: 1 }), { dirname: '/home/user/node_modules/pkg' });
  assert.equal(module.exports.here, '/home/user/node_modules/pkg');
}

// Lines and columns: what the lowering adds sits on the first line before
// MODULE_BODY_MARK; past it, each line is the source's own, a removed
// declaration as spaces, and import.meta's binding keeps the line count.
{
  const source = [
    '#!/usr/bin/env node',
    'import fs from "node:fs";',
    'import {',
    '  join',
    '} from "node:path";',
    'export const a = 1;',
    'export function f() {',
    '  throw new Error("x " + typeof fs);',
    '}',
    'export default class Thing {}',
    'export * from "./more.js";',
    'console.log(import.meta.url, join);',
  ].join('\n');
  const code = lowered(source);
  const body = code.slice(code.indexOf(MODULE_BODY_MARK) + MODULE_BODY_MARK.length);
  const lines = body.split('\n');
  const wanted = source.split('\n');
  assert.ok(lines.length > wanted.length, 'a line per source line, then only what follows the source');
  assert.ok(lines[wanted.length - 1].startsWith('console.log('), 'the last line is the last line');
  assert.equal(code.slice(0, code.indexOf(MODULE_BODY_MARK)).includes('\n'), false, 'the lowering adds no line');
  assert.equal(lines[0], '//' + wanted[0].slice(2), 'the hashbang, a comment');
  for (const at of [1, 2, 3, 4, 10]) assert.equal(lines[at].trim(), '', `a removed declaration leaves its line: ${wanted[at]}`);
  assert.equal(lines[5], '       const a = 1;', 'export keywords leave spaces');
  assert.ok(lines[7].startsWith('  throw new Error("x " + typeof '), 'the throw keeps its column; the import it reads is rewritten');
  assert.equal(lines[9], '               class Thing {}', 'a default class keeps its column');
}
console.log('esbuild-bundled-esm-rewrite: ok');
