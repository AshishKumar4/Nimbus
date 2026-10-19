#!/usr/bin/env bun
// Each arm of a paired bench runs its side's whole tree (tests/bench/lib/
// isolated-core.mjs): every module of it, a workspace package's included, is
// the arm's own copy (not the other side's, not another arm's, not the
// harness's); third-party code is the harness's store, the same for every
// arm; a side on another lockfile is refused. The guard fails a bench whose
// arm, while it is made, loads a module not its own (the harness's, another
// arm's, an unrelated checkout's), however it is reached (an import, a
// require, a third-party module's own import); which, once arms exist, loads
// one that is no arm's (a bundle's lazy import, the harness's own); which
// loads the harness's workspace code at all, before any arm too; and (node,
// which names an import's importer) whose arm lazily imports another arm's;
// and whose arm reuses a module another arm (or checkout) loaded first, or
// reaches a shared store module that holds one (under Bun, read from the
// module graph's sources). Under Bun and under node; and a bundle's input
// outside its arm's tree.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { armImports, armTree, assertArmsInside, importBundle, loadIsolatedCore } from '../bench/lib/isolated-core.mjs';

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
    await assert.rejects(loadIsolatedCore(leaky, cleanup, { sources, modules: [module], harness }), /while an arm is made, it loads only its own tree's modules/, module);
  }
  assertArmsInside();

  // Another arm's module, or an unrelated checkout's, loaded while an arm is made; an unrelated one later.
  const elsewhere = armTree(base, cleanup, { harness });
  put(join(root, 'unrelated/x.mjs'), 'export const unrelated = true;');
  put(join(root, 'unrelated/later.mjs'), 'export const unrelated = true;');
  put(join(leaky, 'packages/b/src/cross.mjs'), `export * from ${JSON.stringify(join(elsewhere, 'packages/b/src/helper.mjs'))};`);
  put(join(leaky, 'packages/b/src/unrelated.mjs'), `export * from ${JSON.stringify(join(root, 'unrelated/x.mjs'))};`);
  put(join(leaky, 'packages/b/src/unrelated-later.mjs'), `export const later = () => import([${JSON.stringify(join(root, 'unrelated'))}, 'later.mjs'].join('/'));`);
  for (const module of ['cross.mjs', 'unrelated.mjs']) {
    await assert.rejects(loadIsolatedCore(leaky, cleanup, { sources, modules: [module], harness }), /while an arm is made, it loads only its own tree's modules/, module);
  }
  const unrelatedLater = (await loadIsolatedCore(leaky, cleanup, { sources, modules: ['unrelated-later.mjs'], harness }))['unrelated-later.mjs'];
  await unrelatedLater.later();
  assert.throws(() => assertArmsInside(), /unrelated\/later\.mjs/, 'a module that is no arm\'s, loaded later, is caught');

  // Another arm's module already loaded, reused by the arm being made (no new load to see): caught by its graph.
  put(join(elsewhere, 'packages/b/src/preloaded.mjs'), 'export const token = {};');
  const preloaded = await import(pathToFileURL(join(elsewhere, 'packages/b/src/preloaded.mjs')).href);
  put(join(leaky, 'packages/b/src/reuse.mjs'), `export * from ${JSON.stringify(join(elsewhere, 'packages/b/src/preloaded.mjs'))};`);
  await assert.rejects(loadIsolatedCore(leaky, cleanup, { sources, modules: ['reuse.mjs'], harness }), /preloaded\.mjs, imported by [^,]*reuse\.mjs, not its arm's own/);
  assert.ok(preloaded.token);

  // A shared store module that holds an arm's module would give it to every arm: caught when an arm reaches it.
  const capturing = armTree(leaky, cleanup, { harness });
  put(join(harness, 'node_modules/.bun/capture@1/node_modules/capture/package.json'), JSON.stringify({ name: 'capture', exports: './index.mjs' }));
  put(join(harness, 'node_modules/.bun/capture@1/node_modules/capture/index.mjs'), `export * from ${JSON.stringify(join(capturing, 'packages/b/src/helper.mjs'))};`);
  link('../../../node_modules/.bun/capture@1/node_modules/capture', join(capturing, 'packages/b/node_modules/capture'));
  put(join(capturing, 'packages/b/src/captured.mjs'), "export * from 'capture';");
  await assert.rejects(armImports(capturing, ['packages/b/src/captured.mjs']), /helper\.mjs, imported by [^,]*capture\/index\.mjs, a shared store module, from outside the store/);

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
  // `first`: a harness workspace module the bench loads itself, before any arm.
  // `cross`: the arm's module `later` lazily imports another arm's (made first) helper.
  const script = (modules, first, cross = false) => `
    import { armTree, assertArmsInside, loadIsolatedCore } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../bench/lib/isolated-core.mjs')).href)};
    import { join } from 'node:path';
    const cleanups = [];
    ${first === undefined ? '' : `await import(${JSON.stringify(pathToFileURL(first).href)});`}
    try {
      ${cross ? `globalThis.crossTarget = join(armTree(${JSON.stringify(base)}, (dispose) => cleanups.push(dispose), { harness: ${JSON.stringify(harness)} }), 'packages/b/src/helper.mjs');` : ''}
      const arm = await loadIsolatedCore(${JSON.stringify(leaky)}, (dispose) => cleanups.push(dispose), {
        sources: ${JSON.stringify(sources)}, modules: ${JSON.stringify(modules)}, harness: ${JSON.stringify(harness)},
      });
      ${cross ? 'await Object.values(arm)[0].later(); assertArmsInside();' : ''}
      console.log(Object.values(arm)[0].version);
    } finally { for (const dispose of cleanups) dispose(); }
  `;
  put(join(leaky, 'packages/b/src/cross-later.mjs'), "export const version = 'leaky'; export const later = () => import(globalThis.crossTarget);");
  const node = (modules, first, cross) => spawnSync('node', ['--input-type=module', '-e', script(modules, first, cross)], { encoding: 'utf8' });
  const fine = node(['main.mjs']);
  assert.equal(fine.status, 0, fine.stderr);
  assert.equal(fine.stdout.trim(), 'leaky');
  // The bench's own harness workspace code, loaded before any arm, fails too, under both runtimes.
  const first = join(harness, 'packages/a/src/mod.mjs');
  const runtimes = {
    node: node(['main.mjs'], first),
    bun: spawnSync(process.execPath, ['-e', script(['main.mjs'], first)], { encoding: 'utf8', cwd: root }),
  };
  for (const [runtime, run] of Object.entries(runtimes)) {
    assert.notEqual(run.status, 0, runtime);
    assert.match(run.stderr, /no workspace package code of the harness's[\s\S]*packages\/a\/src\/mod\.mjs/, runtime);
  }
  for (const module of ['leak.mjs', 'required.cjs', 'bridged.mjs', 'cross.mjs', 'unrelated.mjs']) {
    const leaked = node([module]);
    assert.notEqual(leaked.status, 0, module);
    assert.match(leaked.stderr, /while an arm is made, it loads only its own tree's modules/, module);
  }
  // Under node, a module loaded before (another checkout's) reused by the arm being made is caught by its import edge.
  put(join(root, 'unrelated/preloaded.mjs'), 'export const token = {};');
  put(join(leaky, 'packages/b/src/reuse-node.mjs'), `export * from ${JSON.stringify(join(root, 'unrelated/preloaded.mjs'))}; export const version = 'leaky';`);
  const reused = node(['reuse-node.mjs'], join(root, 'unrelated/preloaded.mjs'));
  assert.notEqual(reused.status, 0);
  assert.match(reused.stderr, /unrelated\/preloaded\.mjs, imported by [^,]*reuse-node\.mjs, not its arm's own/);
  // And a shared store module that holds an arm's module.
  const storeScript = `
    import { armImports, armTree } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../bench/lib/isolated-core.mjs')).href)};
    import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const cleanups = [];
    try {
      const tree = armTree(${JSON.stringify(leaky)}, (dispose) => cleanups.push(dispose), { harness: ${JSON.stringify(harness)} });
      const store = ${JSON.stringify(join(harness, 'node_modules/.bun/capture@1/node_modules/capture'))};
      writeFileSync(join(store, 'index.mjs'), 'export * from ' + JSON.stringify(join(tree, 'packages/b/src/helper.mjs')) + ';');
      mkdirSync(join(tree, 'packages/b/node_modules'), { recursive: true });
      symlinkSync('../../../node_modules/.bun/capture@1/node_modules/capture', join(tree, 'packages/b/node_modules/capture'));
      writeFileSync(join(tree, 'packages/b/src/captured.mjs'), "export * from 'capture';");
      await armImports(tree, ['packages/b/src/captured.mjs']);
    } finally { for (const dispose of cleanups) dispose(); }
  `;
  const captured = spawnSync('node', ['--input-type=module', '-e', storeScript], { encoding: 'utf8' });
  assert.notEqual(captured.status, 0);
  assert.match(captured.stderr, /helper\.mjs, imported by [^,]*capture\/index\.mjs, a shared store module, from outside the store/);
  // Under node, an arm's lazy import of another arm's module is caught too (its importer is named).
  const crossed = node(['cross-later.mjs'], undefined, true);
  assert.notEqual(crossed.status, 0);
  assert.match(crossed.stderr, /packages\/b\/src\/helper\.mjs, imported by [^,]*cross-later\.mjs, not its arm's own/);
} finally {
  for (const dispose of cleanups.reverse()) dispose();
  rmSync(root, { recursive: true, force: true });
}

console.log('isolated-core: ok');
