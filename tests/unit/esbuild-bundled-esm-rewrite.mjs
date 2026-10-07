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

{
  // A declaration without its semicolon ends where the parse says, not at
  // the next `;`: the statement after it stays in place.
  const out = rewriteBundledEsmToCjs('import x from "x"\nconst y = x; export { y };', absoluteUrl);
  assert.ok(out, 'a semicolon-free import takes the bounded path');
  const record = { exports: {}, require: (name) => { assert.equal(name, 'x'); return { __esModule: true, default: 'x-default' }; } };
  new Function('exports', 'require', 'module', '__filename', '__dirname', out.code)(record.exports, undefined, record, '/chunk.js', '/');
  assert.equal(record.exports.y, 'x-default');
}
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
{
  // A default export evaluates where it stands, before the statements after it.
  const middle = rewriteBundledEsmToCjs(
    'const order = ["first"]; export default order.join(); order.push("later");',
    absoluteUrl,
  );
  assert.ok(middle, 'a default export before later statements takes the bounded path');
  const record = { exports: {}, require() { throw new Error('unexpected require'); } };
  new Function('exports', 'require', 'module', '__filename', '__dirname', middle.code)(record.exports, undefined, record, '/chunk.js', '/');
  assert.equal(record.exports.default, 'first', 'read before the later push');
}
assert.equal(
  rewriteBundledEsmToCjs(
    'import x from "y"; var a = { class: "x" }; if (a) { await boot(); } export { a };',
    absoluteUrl,
  ),
  null,
  'class and function property keys cannot hide later top-level await',
);

// ── dynamic import is left as written ─────────────────────────────────────
// The bounded path converts declarations only. A cell's import() calls are
// routed to the process's ESM loader by the parse in the esbuild facet
// (dynamic-import-rewrite.ts, tests/unit/dynamic-import-rewrite.mjs).
{
  const out = rewriteBundledEsmToCjs(
    'import { a } from "dep";\n'
    + 'async function boot() { const { createServer } = await import("node:http"); return createServer(a); }\n'
    + 'const api = { import(id) { return id; } };\n'
    + 'export { boot, api };',
    absoluteUrl,
  );
  assert.ok(out, 'the fixture is rewritable, an import-named method included');
  assert.match(out.code, /await import\("node:http"\)/, 'the dynamic import survives for the facet to route');
}
// A module factory's cell reads import.meta from its module's metadata, bound
// by the facet's rewrite of every MetaProperty, so any property survives the
// bounded rewrite for that pass — Vite's 2 MiB dev-server chunk reads
// `import.meta.dirname` and `.env` and otherwise went to esbuild whole, where
// one transform took esbuild's memory from 28 to 172 MiB.
{
  const out = rewriteBundledEsmToCjs(
    'import { a } from "dep";\n'
    + 'const here = import.meta.dirname ?? import.meta.url;\n'
    + 'const mode = import.meta.env?.MODE;\n'
    + 'const meta = import.meta;\n'
    + 'export { a, here, mode, meta };',
    absoluteUrl,
    true,
  );
  assert.ok(out, 'any import.meta property is rewritable in a module factory');
  assert.match(out.code, /import\.meta\.dirname \?\? import\.meta\.url/, 'left for the metadata pass');
  assert.match(out.code, /const meta = import\.meta;/);
  assert.equal(rewriteBundledEsmToCjs('const d = import.meta.dirname;\nexport { d };', absoluteUrl), null,
    'outside a module factory, a property it cannot bind still takes esbuild');
}
console.log('esbuild-bundled-esm-rewrite: ok');
