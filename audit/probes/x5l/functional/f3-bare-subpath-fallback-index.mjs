// X.5-L functional probe — bare-spec subpath where the subpath is a
// directory with NO nested package.json but DOES have an index.js.
//
// Pre-fix: PASS — current resolveFile probes `<sub>/index.js` already.
// Post-fix: PASS — same.
//
// Regression guard against the fix accidentally clobbering the
// existing index.js fallback.

import { makeVfs, check, summary, reset } from '../_helpers.mjs';
import { prefetchForRequire } from '../../../../src/runtime/require-resolver.ts';

reset();

console.log('X.5-L functional/f3-bare-subpath-fallback-index — directory-with-index.js subpath still works');

const vfs = makeVfs({
  'home/user/app/package.json': JSON.stringify({ name: 'app', version: '0.0.0' }),

  'home/user/app/node_modules/pkg-a/package.json': JSON.stringify({
    name: 'pkg-a', version: '1.0.0', main: 'index.js',
  }),
  'home/user/app/node_modules/pkg-a/index.js':
    "const x = require('pkg-b/feature');\nmodule.exports = x;\n",

  // pkg-B: no exports field. `feature/` is a directory with index.js
  // but NO nested package.json (the truly-vanilla legacy pattern).
  'home/user/app/node_modules/pkg-b/package.json': JSON.stringify({
    name: 'pkg-b', version: '2.0.0', main: 'main.js',
  }),
  'home/user/app/node_modules/pkg-b/main.js':
    "module.exports = 'main';\n",
  'home/user/app/node_modules/pkg-b/feature/index.js':
    "module.exports = { kind: 'feature-index' };\n",
});

const entryCode = "const m = require('pkg-a');\nconsole.log(m);\n";
const result = prefetchForRequire(vfs, entryCode, '/home/user/app');
const inBundle = (p) => p.replace(/^\/+/, '') in result.bundle;

check(
  'pkg-b/feature/index.js — directory-with-index.js subpath resolves',
  inBundle('home/user/app/node_modules/pkg-b/feature/index.js'),
  'existing /index.js fallback in resolveFile',
);

const ok = summary();
process.exit(ok ? 0 : 1);
