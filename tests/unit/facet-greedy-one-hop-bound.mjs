#!/usr/bin/env bun
// facet-greedy-one-hop-bound — the speculative main-entry oversample is
// bounded to what a computed require can plausibly name.
//
// Measured before this (2026-09-14): `node -e "import('got')"` in got's
// repo has a one-file static closure, yet the greedy pass read every
// installed package's main — 1,526 files / 10.9 MB from 706 packages —
// which every later pass re-scanned and esbuild-wasm transformed, and the
// exec path's 20 s bundle deadline fired on a program that reads none of it.
// A bound that followed edges from the project's devDependencies reached
// all 772 packages (a library's dev toolchain reaches the whole tree).
//
// The rule: ONE `dependencies` hop from every package the project itself
// declares or that owns a file in the static closure, plus those roots.
// Never devDependencies, never a second hop. Measured on the real got tree:
// 10 packages / 18 files / 0.07 MB (got's runtime deps exactly); on a
// consumer app whose closure already holds express: +0 files.
//
// The project's own dependencies became hop roots (2026-09-21) because a bin
// resolves from the project root, not from its own package: `nuxt dev` runs
// `@nuxt/cli/bin/nuxi.mjs`, which resolves `@nuxt/kit` — a devDependency of
// `@nuxt/cli`, a dependency of the project's `nuxt` — out of the project's
// node_modules. See facet-bundle-project-dep-hop.

import assert from 'node:assert/strict';
import { greedyAddMainEntries, speculativePackageDirs } from '../../packages/worker/src/facets/manager.ts';
import { launchFs } from './lib/launch-fs.mjs';

const pkg = (root, name, deps = {}, devDeps = {}) => ({
  [`${root}/package.json`]: JSON.stringify({ name, main: 'index.js', dependencies: deps, devDependencies: devDeps }),
  [`${root}/index.js`]: `module.exports = '${name}';`,
});
const NM = 'home/user/app/node_modules';

// A library repo shape: the project declares one runtime dep and a heavy
// dev toolchain; the runtime dep has its own deps; the toolchain's deps are
// a second hop and the toolchain itself is dev-only.
const files = {
  'home/user/app/package.json': JSON.stringify({ name: 'app', dependencies: { got: '*' }, devDependencies: { ava: '*', typescript: '*' } }),
  ...pkg(`${NM}/got`, 'got', { keyv: '*', 'p-cancelable': '*' }),
  ...pkg(`${NM}/keyv`, 'keyv', { 'json-buffer': '*' }),
  ...pkg(`${NM}/p-cancelable`, 'p-cancelable'),
  ...pkg(`${NM}/json-buffer`, 'json-buffer'),
  ...pkg(`${NM}/ava`, 'ava', { chalk: '*' }),
  ...pkg(`${NM}/chalk`, 'chalk'),
  ...pkg(`${NM}/typescript`, 'typescript'),
  ...pkg(`${NM}/unrelated`, 'unrelated'),
};
const vfs = launchFs(files).fs;
const name = (dir) => dir.replace(/^.*node_modules\//, '');

// ── 1. empty closure: the project's runtime deps, one hop out ───────────────
{
  assert.deepEqual((await speculativePackageDirs(vfs, 'home/user/app', {})).map(name),
    ['got', 'keyv', 'p-cancelable'],
    'the project\'s runtime dependencies and one hop from them; json-buffer is a second hop, ava/typescript are dev');
  const bundle = {};
  const budget = { totalBytes: 0, fileCount: 0 };
  (await greedyAddMainEntries(vfs, '/home/user/app', bundle, budget));
  assert.deepEqual(Object.keys(bundle).sort(), [
    `${NM}/got/index.js`, `${NM}/got/package.json`,
    `${NM}/keyv/index.js`, `${NM}/keyv/package.json`,
    `${NM}/p-cancelable/index.js`, `${NM}/p-cancelable/package.json`,
  ]);
  assert.equal(bundle[`${NM}/json-buffer/index.js`], undefined, 'no second hop from a project dependency');
  assert.equal(bundle[`${NM}/ava/index.js`], undefined, 'no devDependencies of the project');
  console.log('  empty closure → the project\'s runtime deps, one hop out');
}

// ── 2. closure owning got: got's runtime deps, one hop ──────────────────────
{
  const closure = { [`${NM}/got/index.js`]: files[`${NM}/got/index.js`] };
  assert.deepEqual((await speculativePackageDirs(vfs, 'home/user/app', closure)).map(name), ['got', 'keyv', 'p-cancelable'],
    'got and its direct runtime deps; json-buffer is a second hop, ava/typescript are dev, unrelated is unreachable');
  const bundle = { ...closure };
  const budget = { totalBytes: 0, fileCount: 1 };
  (await greedyAddMainEntries(vfs, '/home/user/app', bundle, budget));
  assert.equal(bundle[`${NM}/keyv/index.js`] !== undefined, true);
  assert.equal(bundle[`${NM}/p-cancelable/index.js`] !== undefined, true);
  assert.equal(bundle[`${NM}/json-buffer/index.js`], undefined, 'no second hop');
  assert.equal(bundle[`${NM}/ava/index.js`], undefined, 'no devDependencies');
  assert.equal(bundle[`${NM}/unrelated/index.js`], undefined, 'nothing reachable names it');
  console.log('  closure owning got → one runtime hop from got');
}

// ── 3. nested node_modules resolve the way require does ─────────────────────
{
  const nested = launchFs({
    'home/user/app/package.json': JSON.stringify({ name: 'app', dependencies: { a: '*' } }),
    ...pkg(`${NM}/a`, 'a', { b: '*' }),
    ...pkg(`${NM}/a/node_modules/b`, 'b'),
    ...pkg(`${NM}/b`, 'b-hoisted-other-version'),
  }).fs;
  const closure = { [`${NM}/a/index.js`]: 'x' };
  assert.deepEqual((await speculativePackageDirs(nested, 'home/user/app', closure)), [`${NM}/a`, `${NM}/a/node_modules/b`], 'the nearest node_modules wins');
  console.log('  nested node_modules resolve nearest-first');
}

console.log('facet-greedy-one-hop-bound: ok');
