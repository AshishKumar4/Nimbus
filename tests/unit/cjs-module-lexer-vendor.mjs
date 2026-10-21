#!/usr/bin/env bun
// cjs-module-lexer.ts vendors cjs-module-lexer's JavaScript build in a
// factory. It must name what the pinned package names, and the pin must be
// exact and Node 22.23.4's: then a copy that drifts from the package fails
// here, and so does a pin Node does not run. Checked by behavior: both
// lexers over a corpus of CommonJS sources (the export forms Node's loader
// relies on, and the installed packages' own files), with the same answers.

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { createCjsLexer } from '../../packages/core/src/runtime/cjs-module-lexer.ts';

const corePackage = new URL('../../packages/core/package.json', import.meta.url);
const pinned = JSON.parse(await readFile(corePackage, 'utf8')).dependencies?.['cjs-module-lexer'];
assert.match(pinned, /^\d+\.\d+\.\d+$/, `cjs-module-lexer is pinned to one version, not ${pinned}`);
assert.equal(pinned, '2.2.0', "the pin is Node 22.23.4's own (process.versions.cjs_module_lexer)");

const fromCore = createRequire(corePackage);
const upstreamPath = fromCore.resolve('cjs-module-lexer');
const installed = JSON.parse(await readFile(join(dirname(upstreamPath), 'package.json'), 'utf8'));
assert.equal(installed.version, pinned, 'the installed cjs-module-lexer is the pinned one');
const upstream = fromCore('cjs-module-lexer');
upstream.initSync();

const forms = [
  'exports.a = 1; exports["b"] = 2; module.exports.c = 3;',
  'Object.defineProperty(exports, "d", { enumerable: true, get: function () { return x.d; } });',
  'module.exports = { e, f: 1, "g": 2, ...rest };',
  'module.exports = require("./other.js");',
  '__exportStar(require("./star.js"), exports); __export(require("./star2.js"));',
  'var _x = require("./x"); Object.keys(_x).forEach(function (k) { if (k === "default" || k === "__esModule") return; exports[k] = _x[k]; });',
  'exports.__esModule = true; exports.default = function () {};',
  '#!/usr/bin/env node\nexports.shebang = 1;',
  'const s = `${a}`; /re`gex/.test(s); exports.afterTemplate = 1;',
  'if (process.env.NODE_ENV === "production") { module.exports = require("./p.js"); } else { module.exports = require("./d.js"); }',
  'exports.\\u0061scii = 1; exports["\\u{1F600}"] = 2;',
  'import("x"); export const notCommonJs = 1;',
  'module.exports = { a, b: c, d() {}, [e]: 1 };',
];
const lexed = (lex, source) => {
  try { const { exports, reexports } = lex(source); return { exports: [...exports], reexports: [...reexports] }; }
  catch (error) { return { error: error?.message ?? String(error) }; }
};
const vendored = createCjsLexer();
let checked = 0;
const same = (source, label) => {
  assert.deepEqual(lexed(vendored, source), lexed(upstream.parse, source), `the vendored lexer names what the package names: ${label}`);
  checked++;
};
for (const [i, source] of forms.entries()) same(source, `form ${i}`);

// The installed packages' own CommonJS: what the lexer meets in practice.
const roots = ['acorn', 'semver', 'ini', 'nopt', 'hosted-git-info', 'npm-package-arg', 'css-tree', 'esbuild-wasm', 'magic-string']
  .map((name) => { try { return dirname(fromCore.resolve(name + '/package.json')); } catch { return null; } })
  .filter((dir) => dir !== null);
const files = [];
async function collect(dir, depth) {
  if (depth > 4 || files.length >= 400) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') await collect(path, depth + 1); }
    else if (/\.(?:c?js)$/.test(entry.name) && (await stat(path)).size < 4 * 1024 * 1024) files.push(path);
    if (files.length >= 400) return;
  }
}
for (const root of roots) await collect(root, 0);
assert.ok(files.length >= 50, `a corpus of installed CommonJS (${files.length} files)`);
for (const path of files) same(await readFile(path, 'utf8'), path);

console.log(`cjs-module-lexer-vendor OK: the vendored lexer matches cjs-module-lexer ${pinned} on ${checked} sources`);
