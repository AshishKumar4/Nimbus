#!/usr/bin/env bun
// A module the map stages as an optional unit (a module an earlier run
// executed, the greedy pass's guess at a package's main) carries what it loads
// synchronously, a require wrapper's loads included: whole, or not at all.
//
// @vitejs/plugin-vue resolves the project's compiler through a require
// wrapper, tryRequire("vue/compiler-sfc", root). Staged as a module other
// nuxt runs had executed, it came without what that loads: the staged module
// runs as the map's own, so no import() prefetch fetches for it, and nuxt's
// first `nuxt dev` failed "Failed to resolve vue/compiler-sfc" on the
// synchronous read of vue/compiler-sfc/register-ts.js, never staged
// (throwaway, 2026-10-09). In the launch's required closure the same loads
// stay optional (require-resolver.mjs): past the bound, they are left out
// and the launch goes on.

import assert from 'node:assert/strict';
import { buildPrefetchBundle, greedyAddMainEntries } from '../../packages/worker/src/facets/manager.ts';
import { launchFs } from './lib/launch-fs.mjs';

const APP = 'home/user/app';
const NM = `${APP}/node_modules/`;
const pluginVue = [
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
  'export default function vue() { return { configResolved(config) { tryResolveCompiler(config.root); } }; }',
].join('\n');
const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'app', dependencies: { '@vitejs/plugin-vue': '*', vue: '*' } }),
  [`${APP}/index.js`]: 'console.log("the entry reaches no plugin");\n',
  [NM + '@vitejs/plugin-vue/package.json']: JSON.stringify({ name: '@vitejs/plugin-vue', main: 'dist/index.mjs', exports: { '.': './dist/index.mjs' } }),
  [NM + '@vitejs/plugin-vue/dist/index.mjs']: pluginVue,
  [NM + 'vue/package.json']: JSON.stringify({
    name: 'vue', version: '3.5.0', main: 'index.js',
    exports: { '.': { import: './index.mjs', require: './index.js' }, './compiler-sfc': { import: './compiler-sfc/index.mjs', require: './compiler-sfc/index.js' }, './package.json': './package.json' },
  }),
  [NM + 'vue/index.js']: 'module.exports = {};\n',
  [NM + 'vue/compiler-sfc/index.js']: "module.exports = require('@vue/compiler-sfc');\nrequire('./register-ts.js');\n",
  [NM + 'vue/compiler-sfc/index.mjs']: "export * from '@vue/compiler-sfc';\nimport './register-ts.js';\n",
  [NM + 'vue/compiler-sfc/register-ts.js']: "if (typeof require !== 'undefined') { require('@vue/compiler-sfc').registerTS(() => null); }\n",
  [NM + '@vue/compiler-sfc/package.json']: JSON.stringify({ name: '@vue/compiler-sfc', main: 'dist/compiler-sfc.cjs.js' }),
  [NM + '@vue/compiler-sfc/dist/compiler-sfc.cjs.js']: `exports.parse = () => {}; exports.registerTS = () => {}; // ${'x'.repeat(4000)}\n`,
};
const LOADED = ['vue/compiler-sfc/index.js', 'vue/compiler-sfc/register-ts.js', '@vue/compiler-sfc/dist/compiler-sfc.cjs.js'];
const PLUGIN = NM + '@vitejs/plugin-vue/dist/index.mjs';

// 1. A module other runs executed joins the map with what its wrapper loads.
{
  // The project declares no plugin: only what the runs learned brings it.
  const learnedOnly = { ...files, [`${APP}/package.json`]: JSON.stringify({ name: 'app' }) };
  const state = await buildPrefetchBundle(launchFs(learnedOnly).fs, {
    scriptPath: `/${APP}/index.js`, cwd: `/${APP}`, entryCode: files[`${APP}/index.js`],
    learnedFor: async () => [PLUGIN],
  });
  assert.ok(state.bundle[PLUGIN] !== undefined, 'the module other runs executed is in the map');
  for (const path of LOADED) {
    assert.ok(state.bundle[NM + path] !== undefined, `with what tryRequire("vue/compiler-sfc", root) loads: ${path}`);
  }
  assert.equal(state.bundle[NM + 'vue/compiler-sfc/index.mjs'], undefined, "require()'s branch, not import()'s");
  console.log('  a learned module carries its require wrapper\'s loads');
}

// 2. The greedy pass's guess at a package's main carries them too, as one group.
{
  const bundle = {};
  const { groups } = await greedyAddMainEntries(launchFs(files).fs, '/' + APP, bundle, { totalBytes: 0, fileCount: 0 });
  assert.ok(bundle[PLUGIN] !== undefined, "the guess at plugin-vue's main is staged");
  const group = groups.find((g) => g.root === PLUGIN);
  assert.ok(group, 'as a group of its own');
  for (const path of LOADED) {
    assert.ok(bundle[NM + path] !== undefined, `with what its wrapper loads: ${path}`);
    assert.ok(group.members.has(NM + path), `kept or evicted with it: ${path}`);
  }
  console.log('  a guessed main entry carries its require wrapper\'s loads, in its group');
}

// 3. Whole, or not at all: a guess whose wrapper's loads do not fit is no guess.
{
  const bundle = {};
  const fitsAlone = Buffer.byteLength(pluginVue) + Buffer.byteLength(files[NM + '@vitejs/plugin-vue/package.json']) + 512;
  await greedyAddMainEntries(launchFs(files).fs, '/' + APP, bundle, { totalBytes: 0, fileCount: 0 }, new Set(), { maxBundleBytes: fitsAlone });
  assert.equal(bundle[PLUGIN], undefined, 'plugin-vue is not staged without what its wrapper loads');
  console.log('  a guess whose wrapper\'s loads do not fit is not staged');
}

console.log('facet-unit-wrapper-loads: OK');
