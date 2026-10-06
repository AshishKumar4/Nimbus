#!/usr/bin/env bun
/**
 * A barrel package's synthetic entry is built from the file a bundle's
 * import of the package resolves to (its `exports` under the import
 * conditions, then `module`, then `main`), not from a shallow read of its
 * package.json. A package whose `import` condition is itself a condition
 * map (`{ types, default }`, as most dual packages now ship) used to be
 * read through `main`, its CommonJS build, where no re-export is found.
 */

import assert from 'node:assert/strict';
import { buildSyntheticEntry } from '../../packages/worker/src/runtime/barrel-synthesizer.ts';
import { FakeVfs } from './lib/fake-require-fs.mjs';

const ICONS = {
  'app/node_modules/icons/esm/index.js': "export { default as Home } from './icons/home.js';\nexport { default as Zap } from './icons/zap.js';\n",
  'app/node_modules/icons/esm/icons/home.js': 'export default function Home() {}\n',
  'app/node_modules/icons/esm/icons/zap.js': 'export default function Zap() {}\n',
  'app/node_modules/icons/cjs/index.js': "module.exports = require('./all.js');\n",
};

for (const [label, pkg] of [
  ['a nested import condition', { exports: { '.': { import: { types: './esm/index.d.ts', default: './esm/index.js' }, require: './cjs/index.js' } }, main: 'cjs/index.js' }],
  ['a string import condition', { exports: { '.': { import: './esm/index.js', require: './cjs/index.js' } }, main: 'cjs/index.js' }],
  ['the module field', { module: 'esm/index.js', main: 'cjs/index.js' }],
]) {
  const vfs = new FakeVfs({ ...ICONS, 'app/node_modules/icons/package.json': JSON.stringify({ name: 'icons', ...pkg }) });
  const entry = buildSyntheticEntry(vfs, 'app/node_modules', 'icons', new Set(['Home']));
  assert.ok(entry, `${label}: an entry is synthesized`);
  assert.match(entry.code, /icons\/home\.js/, `${label}: Home comes from its own file`);
  assert.doesNotMatch(entry.code, /zap\.js/, `${label}: Zap, not imported, is left out`);
}

console.log('barrel-entry-resolution: ok');
