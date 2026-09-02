#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { rewriteBundledEsmToCjs } from '../../packages/core/src/runtime/esbuild-service.ts';

const source = [
  'import { createRequire as makeRequire } from "node:module";',
  'const require = makeRequire(import.meta.url);',
  'import defaultThing,{\nvalue as alias\n}from"./dep.js";import"./side.js";',
  `const payload = "${'x'.repeat(600_000)}";`,
  'let counter = 0; function increment() { counter++; }',
  'const url = import.meta.url;',
  'const resolved = import.meta.resolve("./asset.js");',
  'function use() { return [defaultThing, alias, require("local"), url, resolved, payload.length]; }',
  'export{payload,counter,increment,use};',
].join('');
const absoluteUrl = 'file:///home/user/node_modules/pkg/chunk.js';
const transformed = rewriteBundledEsmToCjs(source, absoluteUrl);
assert.ok(transformed, 'bundler-emitted ESM should use the bounded rewrite');
assert.doesNotMatch(transformed.code, /(^|[;\n])\s*(?:import|export)\b/);
assert.match(transformed.code, /module\.require\("\.\/dep\.js"\)/);

let sideEffects = 0;
const module = { exports: {}, require: null };
const moduleRequire = (specifier) => {
  if (specifier === 'node:module') return { createRequire: () => (id) => id === 'local' ? 'local' : null };
  if (specifier === './dep.js') return { __esModule: true, default: 'default', value: 'dep' };
  if (specifier === './side.js') { sideEffects++; return {}; }
  throw new Error(`unexpected module: ${specifier}`);
};
module.require = moduleRequire;
const previousResolve = globalThis.__nimbusImportMetaResolve;
globalThis.__nimbusImportMetaResolve = (specifier, base) => new URL(specifier, base).href;
try {
  const execute = new Function(
    'exports', 'require__nimbus_unused', 'module', '__filename', '__dirname',
    transformed.code,
  );
  execute(module.exports, undefined, module, '/home/user/node_modules/pkg/chunk.js', '/home/user/node_modules/pkg');
} finally {
  globalThis.__nimbusImportMetaResolve = previousResolve;
}

assert.equal(sideEffects, 1);
assert.equal(module.exports.payload.length, 600_000);
assert.equal(module.exports.counter, 0);
module.exports.increment();
assert.equal(module.exports.counter, 1, 'named exports remain live bindings');
assert.deepEqual(module.exports.use(), [
  'default',
  'dep',
  'local',
  absoluteUrl,
  'file:///home/user/node_modules/pkg/asset.js',
  600_000,
]);

const defaultModule = rewriteBundledEsmToCjs(
  `const value = "${'y'.repeat(600_000)}";export default value;`,
  absoluteUrl,
);
assert.ok(defaultModule, 'final default expressions are safe bundler exports');
const defaultRecord = { exports: {}, require() { throw new Error('unexpected require'); } };
new Function('exports', 'require', 'module', '__filename', '__dirname', defaultModule.code)(
  defaultRecord.exports, undefined, defaultRecord, '/chunk.js', '/',
);
assert.equal(defaultRecord.exports.default.length, 600_000);

assert.equal(
  rewriteBundledEsmToCjs('import x from "x"\nconst y = x; export { y };', absoluteUrl),
  null,
  'semicolon-free imports cannot absorb and reorder the next statement',
);
assert.equal(
  rewriteBundledEsmToCjs('const dir = import.meta.dirname; export { dir };', absoluteUrl),
  null,
  'unsupported import.meta members use the full transformer',
);
assert.equal(
  rewriteBundledEsmToCjs('await boot(); export { boot };', absoluteUrl),
  null,
  'top-level await uses the full transformer',
);
assert.ok(
  rewriteBundledEsmToCjs(
    'const load = () => run(async () => await value); export { load };',
    absoluteUrl,
  ),
  'await inside an arrow expression is not top-level',
);
assert.equal(
  rewriteBundledEsmToCjs(
    'const load = () => 1, value = await boot(); export { load };',
    absoluteUrl,
  ),
  null,
  'top-level await after an arrow expression must not be hidden',
);
assert.ok(
  rewriteBundledEsmToCjs(
    'const iterator = { async *[Symbol.asyncIterator]() { await read(); } }; export { iterator };',
    absoluteUrl,
  ),
  'await inside a computed async method is not top-level',
);
assert.equal(
  rewriteBundledEsmToCjs('export default initialize(); const later = 1;', absoluteUrl),
  null,
  'moving a default export across later statements is not safe',
);
assert.equal(
  rewriteBundledEsmToCjs(
    'import x from "y"; var a = { class: "x" }; if (a) { await boot(); } export { a };',
    absoluteUrl,
  ),
  null,
  'class and function property keys cannot hide later top-level await',
);

console.log('esbuild-bundled-esm-rewrite: ok');
