// X.5-L functional probe — regression guard: bare-spec subpath with a
// modern `exports` map must keep working after the legacy-directory
// fallback is added.
//
// Pre-fix: PASS (current X.5-C behaviour).
// Post-fix: PASS (new fallback only fires when extension probes miss).
//
// This probe ensures the fix is purely additive.

import { makeVfs, check, summary, reset } from '../_helpers.mjs';
import { prefetchForRequire } from '../../../../src/runtime/require-resolver.ts';

reset();

console.log('X.5-L functional/f2-bare-subpath-with-exports — modern `exports` map still works');

const vfs = makeVfs({
  'home/user/app/package.json': JSON.stringify({ name: 'app', version: '0.0.0' }),

  'home/user/app/node_modules/pkg-a/package.json': JSON.stringify({
    name: 'pkg-a', version: '1.0.0', main: 'index.js',
  }),
  'home/user/app/node_modules/pkg-a/index.js':
    "const { x } = require('pkg-b/sub');\nmodule.exports = { x };\n",

  // pkg-B: modern exports map — `./sub` declares its own target.
  'home/user/app/node_modules/pkg-b/package.json': JSON.stringify({
    name: 'pkg-b', version: '2.0.0',
    main: 'main.js',
    exports: {
      '.': './main.js',
      './sub': {
        require: './sub-cjs.js',
        import: './sub-esm.js',
        default: './sub-cjs.js',
      },
    },
  }),
  'home/user/app/node_modules/pkg-b/main.js':
    "module.exports = { kind: 'main' };\n",
  'home/user/app/node_modules/pkg-b/sub-cjs.js':
    "module.exports = { x: 'sub-cjs-x' };\n",
  'home/user/app/node_modules/pkg-b/sub-esm.js':
    "export const x = 'sub-esm-x';\n",
});

const entryCode = "const m = require('pkg-a');\nconsole.log(m);\n";
const result = prefetchForRequire(vfs, entryCode, '/home/user/app');
const inBundle = (p) => p.replace(/^\/+/, '') in result.bundle;

// pkg-b's `exports./sub.require` target — current behaviour, must persist.
check(
  'pkg-b/sub-cjs.js — modern exports map resolves correctly',
  inBundle('home/user/app/node_modules/pkg-b/sub-cjs.js'),
  'CJS target of pkg-b/exports./sub.require',
);

// pkg-a entry sanity.
check(
  'pkg-a/index.js (entry) in bundle',
  inBundle('home/user/app/node_modules/pkg-a/index.js'),
  '',
);

// Anti-assertion: the ESM target should NOT be picked when conditions=require.
// (Walker uses DEFAULT_CJS_CONDITIONS; sub-esm.js won't be reached because
// `require` matched first and resolveExports returned ./sub-cjs.js.)
const hasEsm = inBundle('home/user/app/node_modules/pkg-b/sub-esm.js');
check(
  'pkg-b/sub-esm.js — ESM target NOT in bundle (correct condition matching)',
  !hasEsm,
  'with require condition, only sub-cjs.js should be picked — not sub-esm.js',
);

const ok = summary();
process.exit(ok ? 0 : 1);
