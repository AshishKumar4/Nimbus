#!/usr/bin/env bun
// Each arm of a paired bench runs its side's whole tree (tests/bench/lib/
// isolated-core.mjs): every module of it, a workspace package's included, is
// the arm's own copy (not the other side's, not another arm's, not the
// harness's); third-party code is the harness's store, the same for every
// arm; a side on another lockfile is refused; and once arms exist, a module
// loaded from the harness's repository (outside its store) fails the bench,
// however it is reached: an arm's import, a require, a third-party module's
// own import, a bundle's lazy import, the harness itself; under Bun and under
// node; and so does a bundle's input outside its arm's tree.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { armTree, assertArmsInside, importBundle, loadIsolatedCore } from '../bench/lib/isolated-core.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'isolated-core-')));
const harness = join(root, 'harness');
const base = join(harness, '.ci-base');
const cleanups = [];
const cleanup = (dispose) => cleanups.push(dispose);
const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const link = (target, path) => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
};

/** A repository's tree: workspace package `a`, and `b`, which imports it, a third-party `dep`, and a file of its own. */
function side(at, version) {
  put(join(at, 'bun.lock'), 'lockfile 1\n');
  put(join(at, 'packages/a/package.json'), JSON.stringify({ name: '@x/a', exports: { './*.js': './src/*.mjs' } }));
  put(join(at, 'packages/a/src/mod.mjs'), `export const version = '${version}'; export const token = {};`);
  put(join(at, 'packages/b/package.json'), JSON.stringify({ name: '@x/b' }));
  put(join(at, 'packages/b/src/helper.mjs'), `export const version = '${version}';`);
  put(join(at, 'packages/b/src/main.mjs'), `
    import * as a from '@x/a/mod.js';
    import * as dep from 'dep';
    import { version as helper } from './helper.mjs';
    export const version = '${version}';
    export const token = {};
    export { a, dep, helper };
  `);
}

try {
  side(harness, 'real');
  side(base, 'base');
  // The harness's install: the store, and links as bun's isolated linker writes them (relative).
  put(join(harness, 'node_modules/.bun/dep@1/node_modules/dep/package.json'), JSON.stringify({ name: 'dep', exports: './index.mjs' }));
  put(join(harness, 'node_modules/.bun/dep@1/node_modules/dep/index.mjs'), 'export const token = {};');
  link('.bun/dep@1/node_modules/dep', join(harness, 'node_modules/dep'));
  link('../../../a', join(harness, 'packages/b/node_modules/@x/a'));
  link('../../../node_modules/.bun/dep@1/node_modules/dep', join(harness, 'packages/b/node_modules/dep'));
  // A third-party package that reaches into the harness's own workspace code.
  put(join(harness, 'node_modules/.bun/bridge@1/node_modules/bridge/package.json'), JSON.stringify({ name: 'bridge', exports: './index.mjs' }));
  put(join(harness, 'node_modules/.bun/bridge@1/node_modules/bridge/index.mjs'), `export * from ${JSON.stringify(join(harness, 'packages/a/src/bridged.mjs'))};`);
  link('../../../node_modules/.bun/bridge@1/node_modules/bridge', join(harness, 'packages/b/node_modules/bridge'));

  const sources = { source: 'packages/b/src' };
  const load = (from) => loadIsolatedCore(from, cleanup, { sources, modules: ['main.mjs'], harness });
  const a = (await load(base))['main.mjs'];
  const n = (await load(base))['main.mjs'];
  const b = (await load(harness))['main.mjs'];
  for (const [arm, version] of [[a, 'base'], [n, 'base'], [b, 'real']]) {
    assert.equal(arm.version, version);
    assert.equal(arm.helper, version, "a module's relative import is its side's");
    assert.equal(arm.a.version, version, "a workspace package is its side's");
  }
  assert.notEqual(a.token, n.token, 'the two baseline arms are isolated');
  assert.notEqual(a.a.token, n.a.token, "and so are their workspace packages");
  assert.notEqual(a.token, b.token);
  assertArmsInside();
  const own = await import(pathToFileURL(join(harness, 'packages/b/src/main.mjs')).href);
  assert.notEqual(b.token, own.token, "the harness's own modules are not an arm's");
  assert.throws(() => assertArmsInside(), /none of the harness repository's[\s\S]*packages\/b\/src\/main\.mjs/, 'the harness loading its own after the arms exist is caught');
  assert.equal(a.dep.token, b.dep.token, "third-party code is the harness's store, shared");
  assert.equal(a.dep.token, n.dep.token);

  // An arm's tree has no dot-directory of its side's (another side laid inside it).
  const tree = armTree(harness, cleanup, { harness });
  assert.equal(existsSync(join(tree, '.ci-base')), false);
  assert.equal(existsSync(join(tree, 'packages/b/src/main.mjs')), true);

  // A side on another lockfile is refused: its third-party code would be the harness's.
  const other = join(root, 'other');
  side(other, 'other');
  put(join(other, 'bun.lock'), 'lockfile 2\n');
  assert.throws(() => armTree(other, cleanup, { harness }), /bun\.lock is not the harness's/);

  // A module that resolves outside its arm's tree fails.
  const leaky = join(root, 'leaky');
  side(leaky, 'leaky');
  const outside = join(harness, 'packages/a/src');
  put(join(outside, 'imported.mjs'), 'export const leaked = true;');
  put(join(outside, 'required.cjs'), 'exports.leaked = true;');
  put(join(outside, 'bridged.mjs'), 'export const leaked = true;');
  put(join(outside, 'lazy.mjs'), 'export const leaked = true;');
  put(join(leaky, 'packages/b/src/leak.mjs'), `export * from ${JSON.stringify(join(outside, 'imported.mjs'))};`);
  put(join(leaky, 'packages/b/src/required.cjs'), `module.exports = require(${JSON.stringify(join(outside, 'required.cjs'))});`);
  put(join(leaky, 'packages/b/src/bridged.mjs'), "export * from 'bridge';");
  // A name the bundler cannot fold: what is loaded is only known when it runs.
  put(join(leaky, 'packages/b/src/lazy.mjs'), `export const later = () => import([${JSON.stringify(outside)}, 'lazy.mjs'].join('/'));`);
  for (const module of ['leak.mjs', 'required.cjs', 'bridged.mjs']) {
    await assert.rejects(loadIsolatedCore(leaky, cleanup, { sources, modules: [module], harness }), /none of the harness repository's/, module);
  }
  assertArmsInside();

  // So does a bundle with an input outside it; one inside is imported, and what it loads later is watched.
  const bundled = await importBundle(tree, { entryPoints: [join(tree, 'packages/b/src/main.mjs')], format: 'esm', platform: 'neutral' }, join(root, 'bundle.mjs'));
  assert.equal(bundled.version, 'real');
  const leakyTree = armTree(leaky, cleanup, { harness });
  await assert.rejects(importBundle(leakyTree, { entryPoints: [join(leakyTree, 'packages/b/src/leak.mjs')], format: 'esm', platform: 'neutral' }, join(root, 'leak.mjs')),
    /every input of a bundle/);
  const lazy = await importBundle(leakyTree, { entryPoints: [join(leakyTree, 'packages/b/src/lazy.mjs')], format: 'esm', platform: 'neutral' }, join(root, 'lazy.mjs'));
  assertArmsInside();
  assert.equal((await lazy.later()).leaked, true);
  assert.throws(() => assertArmsInside(), /packages\/a\/src\/lazy\.mjs/, "a bundle's lazy import is watched");

  // Under node, its resolve hook guards an arm.
  const script = (modules) => `
    import { loadIsolatedCore } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../bench/lib/isolated-core.mjs')).href)};
    const cleanups = [];
    try {
      const arm = await loadIsolatedCore(${JSON.stringify(leaky)}, (dispose) => cleanups.push(dispose), {
        sources: ${JSON.stringify(sources)}, modules: ${JSON.stringify(modules)}, harness: ${JSON.stringify(harness)},
      });
      console.log(Object.values(arm)[0].version);
    } finally { for (const dispose of cleanups) dispose(); }
  `;
  const node = (modules) => spawnSync('node', ['--input-type=module', '-e', script(modules)], { encoding: 'utf8' });
  const fine = node(['main.mjs']);
  assert.equal(fine.status, 0, fine.stderr);
  assert.equal(fine.stdout.trim(), 'leaky');
  for (const module of ['leak.mjs', 'required.cjs', 'bridged.mjs']) {
    const leaked = node([module]);
    assert.notEqual(leaked.status, 0, module);
    assert.match(leaked.stderr, /none of the harness repository's/, module);
  }
} finally {
  for (const dispose of cleanups.reverse()) dispose();
  rmSync(root, { recursive: true, force: true });
}

console.log('isolated-core: ok');
