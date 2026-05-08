// X.5-L functional probe — prefetchForRequire walks bare-spec subpath
// imports that resolve via the legacy directory-with-nested-package.json
// pattern (NO `exports` field on the parent package).
//
// This is the verbatim shape of `react-remove-scroll-bar`:
//   pkgRoot/package.json:    { main: "dist/es5/index.js", module: "dist/es2015/index.js" }   ← no `exports`
//   pkgRoot/constants/:      directory containing nested package.json
//   pkgRoot/constants/package.json: { main: "../dist/es5/constants.js", module: "../dist/es2015/constants.js" }
//   pkgRoot/dist/es5/constants.js                  ← actual file the runtime needs
//   pkgRoot/dist/es2015/constants.js
//
// Pre-fix: FAIL.
//   resolveRequire('react-remove-scroll-bar/constants') →
//   resolveNodeModule splits to (pkgName='react-remove-scroll-bar', subpath='./constants') →
//   resolvePkgSubpath reads parent package.json → no `exports` →
//   sharedResolvePackageEntry returns the raw subpath './constants' →
//   resolveFile probes ['', '.js', '.mjs', '.cjs', '.json', '/index.js', ...] →
//     all miss (constants/ is a directory; no constants.js, no constants/index.js) →
//   returns null.
//   → walker silently no-ops. constants.js is never in the bundle.
//
// Post-fix: PASS.
//   When resolveFile probes fail, resolvePkgSubpath checks if the
//   subpath path is a directory. If yes, reads its nested package.json
//   and follows .module/.main as a relative path. constants.js lands
//   in the bundle.

import { makeVfs, check, summary, reset } from '../_helpers.mjs';
import { prefetchForRequire } from '../../../../src/runtime/require-resolver.ts';

reset();

console.log('X.5-L functional/f1-bare-subpath-walker — directory-with-nested-package.json subpath resolves');

const vfs = makeVfs({
  // User app
  'home/user/app/package.json': JSON.stringify({ name: 'app', version: '0.0.0' }),

  // pkg-A — entry calls into pkg-B/constants
  'home/user/app/node_modules/pkg-a/package.json': JSON.stringify({
    name: 'pkg-a', version: '1.0.0', module: 'index.js', main: 'index.cjs',
  }),
  'home/user/app/node_modules/pkg-a/index.js':
    "import { fullWidthClassName, zeroRightClassName } from 'pkg-b/constants';\nexport { fullWidthClassName, zeroRightClassName };\n",
  'home/user/app/node_modules/pkg-a/index.cjs':
    "const { fullWidthClassName, zeroRightClassName } = require('pkg-b/constants');\nmodule.exports = { fullWidthClassName, zeroRightClassName };\n",

  // pkg-B — NO exports field, uses legacy directory subpath pattern.
  'home/user/app/node_modules/pkg-b/package.json': JSON.stringify({
    name: 'pkg-b', version: '2.0.0',
    main: 'dist/es5/index.js',
    module: 'dist/es2015/index.js',
    files: ['dist', 'constants'],
  }),
  'home/user/app/node_modules/pkg-b/dist/es5/index.js':
    "module.exports = { kind: 'es5-main' };\n",
  'home/user/app/node_modules/pkg-b/dist/es2015/index.js':
    "export const kind = 'es2015-main';\n",

  // The KEY shape: subpath directory with its own package.json that
  // back-points into the parent's dist/.
  'home/user/app/node_modules/pkg-b/constants/package.json': JSON.stringify({
    description: 'separate entrypoint for constants only',
    private: true,
    main: '../dist/es5/constants.js',
    module: '../dist/es2015/constants.js',
    sideEffects: false,
  }),
  'home/user/app/node_modules/pkg-b/dist/es5/constants.js':
    "module.exports = { fullWidthClassName: 'fw', zeroRightClassName: 'zr' };\n",
  'home/user/app/node_modules/pkg-b/dist/es2015/constants.js':
    "export const fullWidthClassName = 'fw';\nexport const zeroRightClassName = 'zr';\n",
});

// Entry: simulates `node -e "require('pkg-a')"`.
const entryCode = "const m = require('pkg-a');\nconsole.log(m);\n";

const result = prefetchForRequire(vfs, entryCode, '/home/user/app');

const inBundle = (p) => p.replace(/^\/+/, '') in result.bundle;

// ── Diagnostics ─────────────────────────────────────────────────────────
console.log(`  prefetched ${Object.keys(result.bundle).length} files (truncated=${result.truncated})`);
console.log(`  visited pkgDirs: ${[...result.visitedPkgDirs].join(', ')}`);
const pkgBKeys = Object.keys(result.bundle).filter(k => k.includes('/pkg-b/'));
console.log(`  pkg-b/* in bundle: ${pkgBKeys.length}`);
for (const k of pkgBKeys) console.log(`    + ${k.replace('home/user/app/node_modules/', '')}`);

// ── Assertions ──────────────────────────────────────────────────────────

// (1) pkg-a entry — sanity baseline.
check(
  'pkg-a/index.js (entry) in bundle',
  inBundle('home/user/app/node_modules/pkg-a/index.js'),
  'baseline; entry file always lands',
);

// (2) THE CRITICAL ASSERTION — the legacy directory subpath resolves.
//     This file is reachable via the runtime require chain through
//     the back-pointing nested package.json.
check(
  'pkg-b/dist/es5/constants.js — legacy directory subpath resolves to nested-pkg target',
  inBundle('home/user/app/node_modules/pkg-b/dist/es5/constants.js'),
  'CJS target of nested package.json#main: "../dist/es5/constants.js"',
);

// (3) Companion ESM target (nested-pkg .module field).
//     Whether or not this lands depends on the conditions used by the
//     prefetch — DEFAULT_CJS_CONDITIONS will pick `main` not `module`.
//     We assert SOFT here: the file is on disk; whether it's bundled
//     is condition-dependent. Either result is fine post-fix as long
//     as (2) holds.
const hasEs2015 = inBundle('home/user/app/node_modules/pkg-b/dist/es2015/constants.js');
console.log(`  (info) pkg-b/dist/es2015/constants.js in bundle? ${hasEs2015 ? 'yes' : 'no — ok if conditions=require'}`);

// (4) X.5-L emits a SYNTHETIC STUB at <pkgDir>/<subpath>.js so the
//     runtime resolver finds the file via its `.js` extension probe
//     without needing a runtime-side mirror of the nested-pkg branch
//     (X.5-M territory). Verify the stub is present and points to the
//     real resolved target.
const stubPath = 'home/user/app/node_modules/pkg-b/constants.js';
check(
  'pkg-b/constants.js — synthetic stub for runtime resolver (X.5-L bridge)',
  inBundle(stubPath),
  'runtime __resolvePkgSubpath probes pkgDir+subpath+.js; stub must be there',
);
const stubContent = result.bundle[stubPath] || '';
check(
  'stub re-exports the real target via relative require',
  /require\(['"]\.\/dist\/es5\/constants\.js['"]\)/.test(stubContent),
  `stub content: ${JSON.stringify(stubContent)}`,
);

// (5) The parent pkg-b package.json should also land (greedy-pkgjson behaviour
//     in prefetchForRequire after addFile).
check(
  'pkg-b/package.json — parent pkg-b metadata in bundle',
  inBundle('home/user/app/node_modules/pkg-b/package.json'),
  'parent pkg-b/package.json piggybacks on any pkg-b file land',
);

const ok = summary();
process.exit(ok ? 0 : 1);
