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

// Their emits can be what takes it past the bound, after a walk that fit:
// the walk counts files, the map counts emits (nuxt dev's second run, "21068298
// bytes staged, stopped at …/node-forge/lib/tls.js"). The same holds.
{
  // A lowering whose emit is half again its file, as a real one's CommonJS wrapper is.
  const lowering = new EsbuildService(undefined, {
    transformHost: async (requests) => requests.map(({ code }) => ({ code: code + '\n//' + '~'.repeat(code.length >> 1), map: '', warnings: [] })),
  });
  const typed = {
    ...files,
    [`${NM}/three/index.ts`]: `import "./part.ts";\nexport const three: string = "${'3'.repeat(30_000)}";\n`,
    [`${NM}/three/part.ts`]: 'export const part: number = 3;\n',
    [`${NM}/four/index.ts`]: `import "./part.ts";\nexport const four: string = "${'4'.repeat(30_000)}";\n`,
    [`${NM}/four/part.ts`]: 'export const part: number = 4;\n',
  };
  const roots = [{ path: `${NM}/three/index.ts` }, { path: `${NM}/four/index.ts` }];
  let state;
  try {
    state = await buildPrefetchBundle(launchFs(typed).fs, {
      scriptPath: `${APP}/entry.js`, cwd: '/' + APP, entryCode: typed[`${APP}/entry.js`], esbuild: lowering,
      executedModules: roots, maxBundleBytes: 80_000,
    });
  } catch (error) {
    assert.fail(`the learned roots' emits failed the launch: ${error instanceof ClosureBoundExceededError ? 'closure-exceeds-bound' : error}`);
  }
  assert.equal(typeof state.bundle[`${APP}/small.js`], 'string', 'the launch starts with its own closure');
  for (const pkg of ['three', 'four']) {
    const parts = [`${NM}/${pkg}/index.ts`, `${NM}/${pkg}/part.ts`].map((path) => typeof state.bundle[path] === 'string');
    assert.equal(parts[0], parts[1], `${pkg} is staged whole or not at all`);
  }
}

// A root cut by the bound takes back everything it staged, its traversal
// included: two learned roots share S, the first stages S and overflows, and
// the second, which fits, is staged with S rather than published without it.
{
  const shared = {
    ...files,
    [`${NM}/a/index.js`]: 'require("../shared/s.js");\nrequire("./big.js");\nmodule.exports = "a";\n',
    [`${NM}/a/big.js`]: `module.exports = "${'a'.repeat(40_000)}";\n`,
    [`${NM}/b/index.js`]: 'require("../shared/s.js");\nmodule.exports = "b";\n',
    [`${NM}/shared/s.js`]: `module.exports = "${'s'.repeat(10_000)}";\n`,
  };
  const state = await buildPrefetchBundle(launchFs(shared).fs, {
    scriptPath: `${APP}/entry.js`, cwd: '/' + APP, entryCode: shared[`${APP}/entry.js`], esbuild: identityEsbuild,
    executedModules: [{ path: `${NM}/a/index.js` }, { path: `${NM}/b/index.js` }], maxBundleBytes: 30_000,
  });
  assert.equal(state.bundle[`${NM}/a/index.js`], undefined, 'the root that cannot fit is not staged');
  assert.equal(state.bundle[`${NM}/a/big.js`], undefined);
  assert.equal(typeof state.bundle[`${NM}/b/index.js`], 'string', 'the root that fits is');
  assert.equal(typeof state.bundle[`${NM}/shared/s.js`], 'string', 'with the dependency it shares with the root that was cut');
}

// A learned root's closure is one group through the map's own admission too:
// a dependency larger than its root, which the walk admitted, is not evicted
// alone when the emits take the map past its bound.
{
  const lowering = new EsbuildService(undefined, {
    transformHost: async (requests) => requests.map(({ code }) => ({ code: code + '\n//' + '~'.repeat(code.length >> 1), map: '', warnings: [] })),
  });
  const grouped = {
    ...files,
    [`${NM}/r/index.ts`]: 'import "./dep.ts";\nexport const r: number = 1;\n',
    // Its file fits the walk's bound; its emit (half again) does not.
    [`${NM}/r/dep.ts`]: `export const dep: string = "${'d'.repeat(50_000)}";\n`,
  };
  const state = await buildPrefetchBundle(launchFs(grouped).fs, {
    scriptPath: `${APP}/entry.js`, cwd: '/' + APP, entryCode: grouped[`${APP}/entry.js`], esbuild: lowering,
    executedModules: [{ path: `${NM}/r/index.ts` }], maxBundleBytes: 70_000,
  });
  assert.equal(typeof state.bundle[`${APP}/small.js`], 'string', 'the launch starts with its own closure');
  const kept = [`${NM}/r/index.ts`, `${NM}/r/dep.ts`].map((path) => typeof state.bundle[path] === 'string');
  assert.equal(kept[0], kept[1], `the learned root and its dependency are kept or evicted together (root ${kept[0]}, dependency ${kept[1]})`);
}

// Groups overlap: a root records its whole static closure, the optional
// cells an earlier root staged included, and pruning removes a cell only when
// no group it survives in includes it. A and B share S; A stages S, B reuses
// it, and B is also read evidence (an earlier run read its source), so B's
// group survives the pruning that removes A's: S stays with it.
{
  const lowering = new EsbuildService(undefined, {
    transformHost: async (requests) => requests.map(({ code }) => ({ code: code + '\n//' + '~'.repeat(code.length >> 1), map: '', warnings: [] })),
  });
  const overlapping = {
    ...files,
    [`${NM}/a/index.ts`]: `import "../shared/s.ts";\nexport const a: string = "${'a'.repeat(20_000)}";\n`,
    [`${NM}/b/index.ts`]: 'import "../shared/s.ts";\nexport const b: number = 1;\n',
    [`${NM}/shared/s.ts`]: `export const s: string = "${'s'.repeat(20_000)}";\n`,
  };
  const state = await buildPrefetchBundle(launchFs(overlapping).fs, {
    scriptPath: `${APP}/entry.js`, cwd: '/' + APP, entryCode: overlapping[`${APP}/entry.js`], esbuild: lowering,
    executedModules: [{ path: `${NM}/a/index.ts` }, { path: `${NM}/b/index.ts` }],
    observedReads: new Set([`${NM}/b/index.ts`]), maxBundleBytes: 50_000,
  });
  assert.equal(typeof state.bundle[`${NM}/b/index.ts`], 'string', 'the observed root survives the pruning');
  assert.equal(typeof state.bundle[`${NM}/shared/s.ts`], 'string', 'and keeps the dependency it shares with the root that was pruned');
  assert.equal(state.bundle[`${NM}/a/index.ts`], undefined, 'the other root was pruned');
}

// A closure past the bound by itself still fails, by name.
await assert.rejects(build([], 10), (error) => error instanceof ClosureBoundExceededError);

console.log('learned-roots-over-bound: ok');
