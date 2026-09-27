#!/usr/bin/env bun
// facet-greedy-root-conditional-exports — the speculative main-entry pass
// resolves a package's root entry the way Node does, through the shared
// exports resolver, instead of reading `exports["."]` by hand.
//
// on-change@6.0.2 (nuxt's dependency) declares its root as a conditional map
// with no "." key: `{ types: './source/index.d.ts', default: './source/index.js' }`
// and has neither `main` nor `module`. The hand-written leaf walk looked only
// under `exports["."]`, found nothing, and guessed `index.js`, which does not
// exist. Measured on the throwaway (2026-09-26, rp2-nuxt-s2): the launch's
// module map lacked `on-change/source/index.js` and nuxt dev exited 1 with
// "not in this launch's module map".
//
// The other shapes stay as they were, in the runtime resolver's order
// (require-resolver.ts resolvePkgSubpathEx): a "." subpath map, nested
// conditions, array fallbacks, a denied root (`null`) with nothing to fall
// back to, legacy module/main, and a package the closure reached through a
// subpath only (no main-entry guess at all).

import assert from 'node:assert/strict';
import { greedyAddMainEntries } from '../../packages/worker/src/facets/manager.ts';
import { launchFs } from './lib/launch-fs.mjs';

const NM = 'home/user/app/node_modules';
const pkg = (name, meta, files) => {
  const root = `${NM}/${name}`;
  const out = { [`${root}/package.json`]: JSON.stringify({ name, ...meta }) };
  for (const [rel, text] of Object.entries(files)) out[`${root}/${rel}`] = text;
  return out;
};

const deps = {
  'root-conditional': '*', 'dot-map': '*', 'nested': '*', 'fallback': '*', 'missing-entry': '*',
  'denied': '*', 'legacy-main': '*', 'legacy-module': '*', 'subpath-only': '*',
};
const files = {
  'home/user/app/package.json': JSON.stringify({ name: 'app', dependencies: deps }),
  // on-change's shape: a root conditional map, no ".", no main.
  ...pkg('root-conditional', { type: 'module', exports: { types: './source/index.d.ts', default: './source/index.js' } },
    { 'source/index.js': 'export default 1;\n', 'source/index.d.ts': 'export default number;\n' }),
  // A "." subpath map with a condition object under it.
  ...pkg('dot-map', { exports: { '.': { require: './dist/index.cjs', import: './dist/index.mjs' }, './package.json': './package.json' } },
    { 'dist/index.cjs': 'module.exports = 2;\n', 'dist/index.mjs': 'export default 2;\n' }),
  // Nested conditions: node → default.
  ...pkg('nested', { exports: { '.': { node: { default: './lib/node.js' }, default: './lib/browser.js' } } },
    { 'lib/node.js': 'module.exports = 3;\n', 'lib/browser.js': 'module.exports = 0;\n' }),
  // Array fallback: the first target the conditions can resolve. Existence
  // is not part of the exports contract; a declared-but-missing entry falls
  // through to main/index in the same order the runtime uses.
  ...pkg('fallback', { exports: [{ 'not-a-condition': './never.js' }, './present.js'] }, { 'present.js': 'module.exports = 4;\n' }),
  ...pkg('missing-entry', { exports: './gone.js', main: 'real.js' }, { 'real.js': 'module.exports = 8;\n' }),
  // A denied root and no main: nothing to guess, and the subpath is not the root.
  ...pkg('denied', { exports: { '.': null, './sub': './sub.js' } }, { 'sub.js': 'module.exports = 5;\n' }),
  // No exports: module, then main.
  ...pkg('legacy-main', { main: 'lib/main.js' }, { 'lib/main.js': 'module.exports = 6;\n' }),
  ...pkg('legacy-module', { module: 'esm/index.js', main: 'cjs/index.js' },
    { 'esm/index.js': 'export default 7;\n', 'cjs/index.js': 'module.exports = 7;\n' }),
  // Reached by the closure through a subpath: the main entry is not a guess.
  ...pkg('subpath-only', { exports: { '.': './big/index.js', './small': './small.js' } },
    { 'big/index.js': 'module.exports = "big";\n', 'small.js': 'module.exports = "small";\n' }),
};

const vfs = launchFs(files).fs;
const closure = { [`${NM}/subpath-only/small.js`]: files[`${NM}/subpath-only/small.js`] };
const bundle = { ...closure };
const budget = { totalBytes: 0, fileCount: 1 };
await greedyAddMainEntries(vfs, '/home/user/app', bundle, budget, new Set(Object.keys(closure)));

const has = (path) => bundle[`${NM}/${path}`] !== undefined;

// The case measured on the throwaway.
assert.ok(has('root-conditional/source/index.js'), 'a root conditional map with no "." resolves to its default target');
assert.ok(!has('root-conditional/source/index.d.ts'), 'the types condition is not a code entry');
assert.ok(!has('root-conditional/index.js'), 'no fallback guess at index.js when exports says otherwise');

// The shapes that already worked.
assert.ok(has('dot-map/dist/index.cjs'), '"." with require/import: the require target');
assert.ok(has('nested/lib/node.js'), 'nested node → default');
assert.ok(has('fallback/present.js'), 'array fallback lands on the existing target');
assert.ok(has('missing-entry/real.js') && !has('missing-entry/gone.js'), 'a declared entry the disk lacks falls through to main');
assert.ok(!has('denied/sub.js') && !has('denied/index.js'), 'a denied root ("." null) stages no entry and does not reach for a subpath');
assert.ok(has('legacy-main/lib/main.js'), 'main without exports');
assert.ok(has('legacy-module/esm/index.js') && !has('legacy-module/cjs/index.js'), 'module before main without exports, as the runtime resolves it');
assert.ok(!has('subpath-only/big/index.js'), 'a package the closure reached by subpath gets no main-entry guess');

// Every package.json in the speculative set is staged; that is resolution metadata.
for (const name of Object.keys(deps)) assert.ok(has(`${name}/package.json`), `${name}/package.json staged`);

console.log('facet-greedy-root-conditional-exports: ok');
