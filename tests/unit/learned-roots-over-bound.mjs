#!/usr/bin/env bun
// Modules earlier runs executed never make the next launch fail on its bound.
//
// What a run executed and the launch's map lacked is learned, and the next
// launch roots it in the required graph (executedModules), so a module and
// the siblings it imports arrive together. But the required graph is bounded
// (VFS_BUNDLE_MAX_BYTES), and past the bound a launch fails: `nuxt dev`'s
// first run loaded rollup, nitropack and more as runtime code, and its second
// failed before it started, "require closure for …/@nuxt/cli/bin/nuxi.mjs
// exceeds the 18874368-byte snapshot bound (19516296 bytes staged)". The
// first run, without them, had got further.
//
// When the learned roots are what takes the required closure past the bound,
// the launch walks them again as optional roots, phase 2's first tier: each
// one's closure staged whole within the bound or not at all (never a module
// without what it imports), evictable, and never the launch's failure. A
// closure past the bound by itself still fails by name.

import assert from 'node:assert/strict';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { ClosureBoundExceededError } from '../../packages/core/src/runtime/require-resolver.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { launchFs } from './lib/launch-fs.mjs';

const identityEsbuild = new EsbuildService(undefined, {
  transformHost: async (requests) => requests.map(({ code }) => ({ code, map: '', warnings: [] })),
});
const APP = 'home/user/app';
const NM = `${APP}/node_modules`;
const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'app' }),
  [`${APP}/entry.js`]: 'require("./small.js");\n',
  [`${APP}/small.js`]: 'module.exports = 1;\n',
  // Two modules an earlier run executed, each with a sibling it requires.
  [`${NM}/one/index.js`]: `require("./part.js");\nmodule.exports = "${'1'.repeat(30_000)}";\n`,
  [`${NM}/one/part.js`]: 'module.exports = 1;\n',
  [`${NM}/two/index.js`]: `require("./part.js");\nmodule.exports = "${'2'.repeat(30_000)}";\n`,
  [`${NM}/two/part.js`]: 'module.exports = 2;\n',
};
const build = (executedModules, maxBundleBytes) => buildPrefetchBundle(launchFs(files).fs, {
  scriptPath: `${APP}/entry.js`, cwd: '/' + APP, entryCode: files[`${APP}/entry.js`], esbuild: identityEsbuild,
  executedModules, maxBundleBytes,
});
const learned = [{ path: `${NM}/one/index.js` }, { path: `${NM}/two/index.js` }];

// Room for both: they are required roots, as before.
{
  const state = await build(learned, 200_000);
  for (const path of [`${NM}/one/index.js`, `${NM}/one/part.js`, `${NM}/two/index.js`, `${NM}/two/part.js`]) {
    assert.equal(typeof state.bundle[path], 'string', `staged: ${path}`);
  }
}

// Room for one: the launch starts, with its own closure and what fits.
{
  let state;
  try { state = await build(learned, 45_000); } catch (error) {
    assert.fail(`the learned roots failed the launch: ${error instanceof ClosureBoundExceededError ? 'closure-exceeds-bound' : error}`);
  }
  assert.equal(typeof state.bundle[`${APP}/entry.js`], 'string', 'the entry is staged');
  assert.equal(typeof state.bundle[`${APP}/small.js`], 'string', 'and its closure');
  const staged = [`${NM}/one/index.js`, `${NM}/two/index.js`].filter((path) => typeof state.bundle[path] === 'string');
  assert.equal(staged.length, 1, `as many learned roots as fit (${staged})`);
  for (const pkg of ['one', 'two']) {
    const parts = [`${NM}/${pkg}/index.js`, `${NM}/${pkg}/part.js`].map((path) => typeof state.bundle[path] === 'string');
    assert.equal(parts[0], parts[1], `${pkg} is staged whole or not at all`);
  }
}

// A closure past the bound by itself still fails, by name.
await assert.rejects(build([], 10), (error) => error instanceof ClosureBoundExceededError);

console.log('learned-roots-over-bound: ok');
