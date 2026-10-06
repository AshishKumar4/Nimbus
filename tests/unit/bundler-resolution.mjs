#!/usr/bin/env bun
/**
 * Both bundles Nimbus builds resolve an import the same way: the pre-bundle
 * over its slice (prebundle-slice.ts) and EsbuildService's builds over the
 * session filesystem (makeVfsPlugin), through bundler-resolution.ts. The same
 * tree is laid out on disk, as a slice, and as a VFS, and each import is
 * resolved by real esbuild (native, the tree on disk) and by both plugins.
 * Where Nimbus's bundler policy is its own (a `.js` import of a `.ts` file
 * from JavaScript), esbuild is not asked. The slice plugin answers each
 * resolve already settled, as the build facet needs.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { prebundleSlice } from '../../packages/core/src/runtime/prebundle-slice.ts';
import { FakeVfs } from './lib/fake-require-fs.mjs';

const json = (value) => JSON.stringify(value);
const TREE = {
  'app/package.json': json({ name: 'app', imports: { '#cfg': { browser: './cfg.browser.js', default: './cfg.js' } } }),
  'app/cfg.js': 'export default "node";',
  'app/cfg.browser.js': 'export default "browser";',
  'app/both.js': 'export default "js";',
  'app/both.ts': 'export default "ts";',
  'app/only-ts.ts': 'export default 1;',
  'app/dir/index.js': 'export default 1;',
  // A nested package.json without `imports` is the scope of what is under it.
  'app/sub/package.json': json({ name: 'sub' }),
  'app/sub/entry.js': 'export default 1;',
  'app/node_modules/dual/package.json': json({
    name: 'dual',
    exports: { '.': { import: './esm.mjs', require: './cjs.cjs' }, './feature': { browser: './feature.browser.js', default: './feature.js' } },
  }),
  'app/node_modules/dual/esm.mjs': 'export default 1;',
  'app/node_modules/dual/cjs.cjs': 'module.exports = 1;',
  'app/node_modules/dual/feature.js': 'export default 1;',
  'app/node_modules/dual/feature.browser.js': 'export default 1;',
  'app/node_modules/legacy/package.json': json({ name: 'legacy', main: 'lib/main.js' }),
  'app/node_modules/legacy/lib/main.js': 'module.exports = 1;',
  'app/node_modules/legacy/lib/util.js': 'module.exports = 1;',
  'app/node_modules/@scope/pkg/index.js': 'module.exports = 1;',
};

/** [label, importer directory, specifier, kind, ask esbuild, expected path or null]. */
const CASES = [
  ['coexisting .js and .ts: the named file', 'app', './both.js', 'import-statement', true, '/app/both.js'],
  ['directory index', 'app', './dir', 'import-statement', true, '/app/dir/index.js'],
  ['#imports, browser condition', 'app', '#cfg', 'import-statement', true, '/app/cfg.browser.js'],
  ['#imports only from the nearest package.json', 'app/sub', '#cfg', 'import-statement', true, null],
  ['exports, import condition', 'app', 'dual', 'import-statement', true, '/app/node_modules/dual/esm.mjs'],
  ['exports, require condition', 'app', 'dual', 'require-call', true, '/app/node_modules/dual/cjs.cjs'],
  ['exports subpath, browser condition', 'app', 'dual/feature', 'import-statement', true, '/app/node_modules/dual/feature.browser.js'],
  ['main', 'app', 'legacy', 'require-call', true, '/app/node_modules/legacy/lib/main.js'],
  ['subpath without exports', 'app', 'legacy/lib/util', 'require-call', true, '/app/node_modules/legacy/lib/util.js'],
  ['scoped index', 'app', '@scope/pkg', 'require-call', true, '/app/node_modules/@scope/pkg/index.js'],
  ['a .js name whose file is .ts', 'app', './only-ts.js', 'import-statement', false, '/app/only-ts.ts'],
];

const root = mkdtempSync(join(tmpdir(), 'bundler-resolution-'));
try {
  for (const [path, text] of Object.entries(TREE)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  /** What real esbuild bundles for one import, as a tree path; null when it cannot resolve it. */
  const esbuildResolves = async (fromDir, specifier, kind) => {
    const statement = kind === 'require-call' ? `require(${json(specifier)});` : `import ${json(specifier)};`;
    try {
      const result = await esbuild.build({
        stdin: { contents: statement, resolveDir: join(root, fromDir), loader: 'js' },
        absWorkingDir: root, bundle: true, write: false, metafile: true, logLevel: 'silent', platform: 'browser', format: 'esm',
      });
      const inputs = Object.keys(result.metafile.inputs).filter((input) => input !== '<stdin>');
      assert.equal(inputs.length, 1, `${specifier}: esbuild read ${inputs.join(', ')}`);
      return '/' + inputs[0];
    } catch {
      return null;
    }
  };

  // The slice: what a pre-bundle's plugin resolves, with no build behind it.
  let slicePlugin;
  const encoder = new TextEncoder();
  await prebundleSlice({
    specifier: 'x', entryPath: '/app/cfg.js', externals: [], bundlerVersion: 'test',
    slice: Object.entries(TREE).map(([path, text]) => ({ path, bytes: encoder.encode(text) })),
  }, async (_options, plugin) => {
    slicePlugin = plugin;
    return { failure: 'not built', errors: [], warnings: [], outputFiles: [] };
  });
  const sliceResolves = async (fromDir, specifier, kind) => {
    const result = await slicePlugin.resolve({ path: specifier, resolveDir: '/' + fromDir, importer: '', kind });
    return result?.namespace === 'nimbus-slice' ? result.path : null;
  };

  // The slice plugin answers rolldown with a promise already settled: the
  // deployed build facet's pre-bundles stopped settling when it awaited its
  // way through a resolution. Settled means its reaction runs on the first
  // microtask turn, whatever the resolution walked.
  for (const [label, fromDir, specifier, kind] of CASES) {
    let answered = false;
    slicePlugin.resolve({ path: specifier, resolveDir: '/' + fromDir, importer: '', kind }).then(() => { answered = true; });
    await Promise.resolve();
    assert.ok(answered, `pre-bundle slice: ${label} is answered on the first microtask turn`);
  }

  // The session filesystem: what EsbuildService's VFS plugin resolves.
  const vfs = new FakeVfs(TREE);
  let vfsResolve;
  new EsbuildService(vfs).makeVfsPlugin().setup({
    initialOptions: {},
    onResolve: (_filter, callback) => { vfsResolve = callback; },
    onLoad() {},
  });
  const vfsResolves = async (fromDir, specifier, kind) => {
    const result = await vfsResolve({ path: specifier, resolveDir: '/' + fromDir, importer: '', kind });
    return result && !result.external ? result.path : null;
  };

  for (const [label, fromDir, specifier, kind, askEsbuild, expected] of CASES) {
    if (askEsbuild) assert.equal(await esbuildResolves(fromDir, specifier, kind), expected, `esbuild: ${label}`);
    assert.equal(await sliceResolves(fromDir, specifier, kind), expected, `pre-bundle slice: ${label}`);
    assert.equal(await vfsResolves(fromDir, specifier, kind), expected, `VFS plugin: ${label}`);
  }
} finally {
  await esbuild.stop?.();
  rmSync(root, { recursive: true, force: true });
}

console.log(`bundler-resolution: ${CASES.length} imports resolve alike in esbuild, the pre-bundle slice and the VFS plugin`);
