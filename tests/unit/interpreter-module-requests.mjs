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

// ── text the parser cannot read asks for nothing ──
assert.deepEqual(requests('import a from "x"; const = ;'), []);
assert.deepEqual(requests('import type { T } from "types-only";\n', 'pkg/index.ts'), []);

console.log('interpreter-module-requests: ok');
