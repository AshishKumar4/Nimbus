#!/usr/bin/env bun
/**
 * `import.meta.resolve` must throw on an unresolvable specifier.
 *
 * Node answers ERR_MODULE_NOT_FOUND, and packages are written against that:
 * the standard shape is a try/catch that turns the failure into something the
 * user can act on. Handing the bare specifier back instead passes "unresolved"
 * off as a URL, so `fileURLToPath` downstream yields a path that was never on
 * disk and the eventual error names a phantom file.
 *
 * Observed cost: typescript@7's `getExePath` wraps its resolve in exactly that
 * try/catch and reports "Unable to resolve @typescript/typescript-linux-x64.
 * Either your platform is unsupported, or you are missing the package on
 * disk." With the specifier echoed back the catch never ran, and the user got
 * "Executable not found: @typescript/typescript-linux-x64/lib/tsc" — a path
 * that is not a path, blamed on a line that is not the real failure.
 */

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
  '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + generateShimsCode() + '\n;return globalThis.__nimbusImportMetaResolve;',
);

const bundle = {
  'home/user/package.json': JSON.stringify({ name: 'app', type: 'module' }),
  'home/user/app.js': 'export const x = 1;\n',
  'home/user/lib/dep.js': 'export const y = 2;\n',
  'home/user/node_modules/present/package.json': JSON.stringify({ name: 'present', main: 'index.js' }),
  'home/user/node_modules/present/index.js': 'module.exports = 1;\n',
};

const resolve = factory(
  bundle, {}, {}, {}, {}, null,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/app.js', '/home/user',
);

const parent = 'file:///home/user/app.js';

// ── an installed package resolves to a real file URL ──
assert.equal(resolve('present', parent), 'file:///home/user/node_modules/present/index.js');

// ── relative and absolute specifiers keep resolving without a lookup ──
assert.equal(resolve('./lib/dep.js', parent), 'file:///home/user/lib/dep.js');
assert.equal(resolve('file:///anything', parent), 'file:///anything');

// ── the regression: a missing package throws, and never answers with itself ──
assert.throws(
  () => resolve('@typescript/typescript-linux-x64/package.json', parent),
  (error) => {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND', "must carry Node's error code");
    assert.match(error.message, /@typescript\/typescript-linux-x64/, 'must name the specifier');
    assert.match(error.message, /home\/user\/app\.js/, 'must name the importer');
    return true;
  },
);

// A bare name with no scope fails the same way.
assert.throws(() => resolve('definitely-not-installed', parent), { code: 'ERR_MODULE_NOT_FOUND' });

console.log('import-meta-resolve-missing: ok');
