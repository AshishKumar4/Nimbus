#!/usr/bin/env bun
// A module with top-level await becomes a CommonJS body that behaves as the
// module: esbuild emits no CommonJS for it, so the transform emits ESM and
// lowers the declarations. esbuild prints long import and export clauses
// across lines (serve 14's build/main.js: `import {\n resolve as resolvePath,
// ...} from "node:path"`), and each of them must still bind.

import assert from 'node:assert/strict';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';

const service = new EsbuildService();
service.ensureInit = async () => {};
service._esbuild = await import('esbuild');

const source = [
  '#!/usr/bin/env node',
  'import {',
  '  resolve as resolvePath,',
  '  relative as resolveRelativePath,',
  '  sep',
  '} from "node:path";',
  'import dflt, * as dep from "./dep.js";',
  'import "./side.js";',
  'import { "kebab-name" as kebab } from "./reexport.js";',
  'import tsDefault from "./ts-cjs.js";',
  'export { tsDefault };',
  'const joined = await Promise.resolve(resolvePath("/a", "b"));',
  'export const answer = [joined, resolveRelativePath("/a", "/a/c"), sep, kebab];',
  'export let { first, ...rest } = { first: 1, second: 2 };',
  'export default function named() { return dflt; }',
  'export { dep as namespace };',
  'export * from "./reexport.js";',
  'export { x as "string-name" } from "./reexport.js";',
  'const pattern = /import {\\s*"fake"/;',
  'export const text = `import {\n  y\n} from "template";` + String(pattern.test(\'import { "fake"\'));',
].join('\n');

const { code } = await service.transform(source, { loader: 'js', format: 'cjs' });

const path = await import('node:path');
const modules = {
  'node:path': path,
  // A lowered ES module: its exports carry its namespace under the marker
  // (esm-interop.ts).
  './dep.js': (() => { const ns = { default: 'default-export', other: 1 }; return Object.defineProperty(ns, Symbol.for('nimbus.esm.namespace'), { value: ns }); })(),
  './side.js': {},
  './reexport.js': { x: 'X', y: 'Y', 'kebab-name': 'K', default: 'not-reexported' },
  // CommonJS as TypeScript emits it: Node's default import is module.exports.
  './ts-cjs.js': { __esModule: true, default: 'ts-default' },
};
const loaded = [];
const require = (id) => { loaded.push(id); return modules[id]; };
const module = { exports: {} };
await new Function('exports', 'require', 'module', '__filename', '__dirname', code)(module.exports, require, module, '/x.js', '/');

const out = module.exports;
assert.deepEqual(out.answer, ['/a/b', 'c', '/', 'K'], 'multi-line and string-named imports bind');
assert.equal(out.first, 1);
assert.deepEqual(out.rest, { second: 2 }, 'destructured declarations export every binding');
assert.equal(out.default(), 'default-export', "an ES module's default import is its default");
assert.equal(out.namespace, modules['./dep.js'], "an ES module's namespace is its exports");
assert.equal(out.tsDefault, modules['./ts-cjs.js'], "CommonJS's default import is module.exports, __esModule or not");
assert.equal(out[Symbol.for('nimbus.esm.namespace')], out, 'the lowered module is marked an ES module');
assert.equal(out.x, 'X');
assert.equal(out.y, 'Y');
assert.equal(out['string-name'], 'X');
assert.equal(out.__esModule, true);
assert.equal(Object.hasOwn(out, 'default') && out.default !== 'not-reexported', true, 'export * leaves default alone');
assert.equal(out.text, 'import {\n  y\n} from "template";true', 'template and regex text is not a declaration');
assert.deepEqual([...new Set(loaded)], ['node:path', './dep.js', './side.js', './reexport.js', './ts-cjs.js'], 'requires in import order');

console.log('esbuild-tla-lowering: top-level-await modules lower every import and export shape');
