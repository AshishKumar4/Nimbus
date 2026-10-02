#!/usr/bin/env bun
// A module with top-level await becomes a CommonJS body that behaves as the
// module: the transform (esbuild's contract, Oxc's engine, lib/oxc-engine.mjs)
// emits no CommonJS for it, so it emits ESM and the service lowers the
// declarations. A printer may print long import and export clauses
// across lines (serve 14's build/main.js: `import {\n resolve as resolvePath,
// ...} from "node:path"`), and each of them must still bind.

import assert from 'node:assert/strict';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { oxcEngine } from './lib/oxc-engine.mjs';

const service = new EsbuildService();
service.ensureInit = async () => {};
service._esbuild = oxcEngine;

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
  './dep.js': { __esModule: true, default: 'default-export', other: 1 },
  './side.js': {},
  './reexport.js': { x: 'X', y: 'Y', 'kebab-name': 'K', default: 'not-reexported' },
};
const loaded = [];
const require = (id) => { loaded.push(id); return modules[id]; };
const module = { exports: {} };
await new Function('exports', 'require', 'module', '__filename', '__dirname', code)(module.exports, require, module, '/x.js', '/');

const out = module.exports;
assert.deepEqual(out.answer, ['/a/b', 'c', '/', 'K'], 'multi-line and string-named imports bind');
assert.equal(out.first, 1);
assert.deepEqual(out.rest, { second: 2 }, 'destructured declarations export every binding');
assert.equal(out.default(), 'default-export', 'an __esModule default import binds .default');
assert.equal(out.namespace, modules['./dep.js'], 'a namespace import is the module');
assert.equal(out.x, 'X');
assert.equal(out.y, 'Y');
assert.equal(out['string-name'], 'X');
assert.equal(out.__esModule, true);
assert.equal(Object.hasOwn(out, 'default') && out.default !== 'not-reexported', true, 'export * leaves default alone');
assert.equal(out.text, 'import {\n  y\n} from "template";true', 'template and regex text is not a declaration');
assert.deepEqual([...new Set(loaded)], ['node:path', './dep.js', './side.js', './reexport.js'], 'requires in import order');

console.log('esbuild-tla-lowering: top-level-await modules lower every import and export shape');
