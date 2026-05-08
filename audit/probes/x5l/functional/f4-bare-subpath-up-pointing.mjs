// X.5-L functional probe — bare-spec subpath whose nested package.json
// `main` field uses an UP-POINTING relative path (`../dist/...`).
//
// This is the verbatim shape of react-remove-scroll-bar/constants:
//
//   pkg-b/constants/package.json:
//     { "main": "../dist/es5/constants.js", "module": "../dist/es2015/constants.js" }
//
// The `..` must normalize correctly. If the fix uses naive
// concatenation without normalizePath, the resulting probe path will
// be e.g. `node_modules/pkg-b/constants/../dist/es5/constants.js`
// and the `vfs.exists` check will miss.
//
// Pre-fix: FAIL.
// Post-fix: PASS — normalizePath collapses `constants/..`.

import { makeVfs, check, summary, reset } from '../_helpers.mjs';
import { prefetchForRequire } from '../../../../src/runtime/require-resolver.ts';

reset();

console.log('X.5-L functional/f4-bare-subpath-up-pointing — `../dist/...` in nested-pkg main resolves');

const vfs = makeVfs({
  'home/user/app/package.json': JSON.stringify({ name: 'app', version: '0.0.0' }),

  'home/user/app/node_modules/pkg-a/package.json': JSON.stringify({
    name: 'pkg-a', version: '1.0.0', main: 'index.js',
  }),
  'home/user/app/node_modules/pkg-a/index.js':
    "const c = require('pkg-b/constants');\nmodule.exports = c;\n",

  // pkg-B: NO exports field. Subpath uses up-pointing nested-pkg.
  'home/user/app/node_modules/pkg-b/package.json': JSON.stringify({
    name: 'pkg-b', version: '2.0.0', main: 'dist/main.js',
  }),
  'home/user/app/node_modules/pkg-b/dist/main.js':
    "module.exports = 'main';\n",
  'home/user/app/node_modules/pkg-b/constants/package.json': JSON.stringify({
    main: '../dist/constants.js',
    module: '../dist/constants.mjs',
  }),
  'home/user/app/node_modules/pkg-b/dist/constants.js':
    "module.exports = { up: 'pointed-and-resolved' };\n",
  'home/user/app/node_modules/pkg-b/dist/constants.mjs':
    "export const up = 'pointed-and-resolved';\n",
});

const entryCode = "const m = require('pkg-a');\nconsole.log(m);\n";
const result = prefetchForRequire(vfs, entryCode, '/home/user/app');
const inBundle = (p) => p.replace(/^\/+/, '') in result.bundle;

console.log(`  prefetched ${Object.keys(result.bundle).length} files`);
const pkgBKeys = Object.keys(result.bundle).filter(k => k.includes('/pkg-b/'));
for (const k of pkgBKeys) console.log(`    + ${k.replace('home/user/app/node_modules/', '')}`);

check(
  'pkg-b/dist/constants.js — up-pointing nested-pkg target normalizes correctly',
  inBundle('home/user/app/node_modules/pkg-b/dist/constants.js'),
  'nested-pkg main `../dist/constants.js` from constants/ → dist/constants.js after normalization',
);

const ok = summary();
process.exit(ok ? 0 : 1);
