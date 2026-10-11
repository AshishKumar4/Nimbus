#!/usr/bin/env bun
// moduleRequests: the modules a file's text asks for, and how, as the
// runtime-code interpreter's parser reads it. The import() prefetch
// (node-shims.ts __nimbusStageImport) walks a late module's closure with it,
// and resolves each request by its kind: a static import or export-from is
// evaluated through the module's scoped require, so it resolves under
// require's conditions; import() under import's.

import assert from 'node:assert/strict';
import { moduleRequests } from '../../packages/core/src/interpreter/index.ts';

const requests = (text, path = 'pkg/index.js') => moduleRequests(path, text).map((r) => `${r.kind}:${r.specifier}`).sort();

// ── every form, with its kind ──
assert.deepEqual(requests([
  'import a from "static-default";',
  'import * as b from "static-namespace";',
  'import "static-bare";',
  'export { c } from "export-named";',
  'export * from "export-all";',
  'export * as d from "export-all-as";',
  'const e = await import("dynamic");',
  'const f = require("required");',
].join('\n')), [
  'dynamic:dynamic', 'require:required', 'static:export-all', 'static:export-all-as', 'static:export-named',
  'static:static-bare', 'static:static-default', 'static:static-namespace',
]);

// ── spelled as the language reads it, not as text matches ──
assert.deepEqual(requests([
  'import a from /* where it comes from */ "after-comment";',
  'import b from "\\u0065scaped";',
  'const c = require(`template`);',
  'const d = import(`dynamic-template`);',
].join('\n')), ['dynamic:dynamic-template', 'require:template', 'static:after-comment', 'static:escaped']);

// ── not requests ──
assert.deepEqual(requests([
  '// import x from "in-a-comment";',
  'const s = "import y from \\"in-a-string\\"";',
  'const t = `require("in-a-template")`;',
  'const computed = require(name);',
  'const substituted = import(`./${name}.js`);',
  'obj.require("a-method");',
  'const r = require;',
].join('\n')), []);

// ── CommonJS text (no module syntax) is read as a script ──
assert.deepEqual(requests('"use strict";\nconst path = require("path");\nmodule.exports = require("./lib/" + "x");\nreturn;\n', 'pkg/index.cjs'),
  ['require:path']);

// ── a nested require, and a property value that holds one ──
assert.deepEqual(requests('export const loaders = { a: () => require("nested-a"), b: { c: import("nested-c") } };\n'),
  ['dynamic:nested-c', 'require:nested-a']);

// ── a require createRequire made, by any name ──
assert.deepEqual(requests([
  'import { createRequire } from "node:module";',
  'import module from "node:module";',
  'const __require = createRequire(import.meta.url);',
  'const req = module.createRequire(import.meta.url);',
  'const a = __require("by-binding");',
  'const b = req(`by-member-binding`);',
  'const c = __require.resolve("resolved-only");',
  'const notMade = load("not-a-require-binding");',
].join('\n')), ['require:by-binding', 'require:by-member-binding', 'static:node:module', 'static:node:module']);

// ── a function that passes its first parameter to a require loads what its
// callers name (@vitejs/plugin-vue resolves vue/compiler-sfc so) ──
assert.deepEqual(requests([
  'import { createRequire } from "node:module";',
  'function tryResolveCompiler(root) {',
  '  const vueMeta = tryRequire("vue/package.json", root);',
  '  if (vueMeta && vueMeta.version.split(".")[0] >= 3) return tryRequire("vue/compiler-sfc", root);',
  '}',
  'const _require = createRequire(import.meta.url);',
  'function tryRequire(id, from) {',
  '  try {',
  '    return from ? _require(_require.resolve(id, { paths: [from] })) : _require(id);',
  '  } catch (e) {}',
  '}',
  'const load = (name) => require(name);',
  'const loadOptional = function (name, fallback = null) { try { return require.resolve(name); } catch { return fallback; } };',
  'export const a = load("arrow-wrapper"), b = loadOptional("expression-wrapper");',
  'export const c = tryRequire(computed, root);',
].join('\n')), [
  'require:arrow-wrapper', 'require:expression-wrapper', 'require:vue/compiler-sfc', 'require:vue/package.json', 'static:node:module',
]);

// ── a function whose first parameter reaches no require names no module ──
assert.deepEqual(requests([
  'function label(id) { return "[" + id + "]"; }',
  'function second(options, id) { return require(id); }',
  'export const a = label("not-a-module"), b = second("not-a-module-either", "x");',
].join('\n')), []);

// ── text the parser cannot read asks for nothing ──
assert.deepEqual(requests('import a from "x"; const = ;'), []);
assert.deepEqual(requests('import type { T } from "types-only";\n', 'pkg/index.ts'), []);

console.log('interpreter-module-requests: ok');
