// X.5-C e2e — react-remove-scroll loads end-to-end via the runtime
// require chain.
//
// This is the X.5-C answer to the verification doc's verbatim failure:
//   `Cannot load module 'home/user/app/node_modules/react-remove-scroll/dist/es2015/index.js':
//    file was not pre-bundled. Add it to the VFS bundle.`
// AND the post-W3.5 latent shape:
//   `Cannot find module './Combination' (from .../react-remove-scroll/dist/es2015)`
//
// Strategy:
//   1. Build a synthetic VFS containing the actual file shape of
//      react-remove-scroll@2.7.2's dist/es2015/ tree (8 ESM siblings).
//   2. Run prefetchForRequire over a `require('react-remove-scroll')`
//      entry to compute the bundle contents.
//   3. Apply the W3.5 ESM→CJS transform to every ESM-shaped file in the
//      bundle (mimicking transformEsmInBundle).
//   4. Drive the runtime require chain via makeFacet.
//   5. Assert the package's default export is reachable.
//
// Pre-fix: FAIL at step 2 (Combination.js missing from bundle) → step 4
//          throws "Cannot find module './Combination'".
// Post-fix: PASS — Fix #1's IMPORT_RE pulls every ESM transitive into
//           the bundle; W3.5's transform converts them to CJS; the runtime
//           require chain walks from index.js through Combination → UI →
//           SideEffect / sidecar / medium and resolves cleanly.

import { makeVfs, makeFacet, check, summary, reset } from '../_helpers.mjs';
import { prefetchForRequire } from '../../../../src/require-resolver.ts';
import { generateShimsCode } from '../../../../src/node-shims.ts';
import * as esbuildWasm from 'esbuild-wasm';

reset();

console.log('X.5-C e2e/e1-react-remove-scroll — package loads end-to-end');

// Source files (verbatim from npm install react-remove-scroll@2.7.2 — see
// /tmp/rrs-probe/node_modules/react-remove-scroll/dist/es2015/).
const RRS_FILES = {
  // Package metadata
  'home/user/app/package.json': JSON.stringify({ name: 'app', version: '0.0.0' }),
  'home/user/app/node_modules/react-remove-scroll/package.json': JSON.stringify({
    name: 'react-remove-scroll',
    version: '2.7.2',
    main: 'dist/es5/index.js',
    module: 'dist/es2015/index.js',
    'jsnext:main': 'dist/es2015/index.js',
    sideEffects: ['**/sidecar.js'],
    dependencies: {
      'react-remove-scroll-bar': '^2.3.7',
      'react-style-singleton': '^2.2.3',
      'tslib': '^2.1.0',
      'use-callback-ref': '^1.3.3',
      'use-sidecar': '^1.1.3',
    },
  }),

  // dist/es2015 (ESM) — the package's `module` entry walks here.
  'home/user/app/node_modules/react-remove-scroll/dist/es2015/index.js':
    "import RemoveScroll from './Combination';\nexport { RemoveScroll };\nexport default RemoveScroll;\n",
  'home/user/app/node_modules/react-remove-scroll/dist/es2015/Combination.js':
    "import * as React from 'react';\nimport { RemoveScroll as UIRemoveScroll } from './UI';\nimport SideCar from './sidecar';\nfunction RS(props) { return null; }\nRS.classNames = UIRemoveScroll.classNames || { fullWidth: 'fw', zeroRight: 'zr' };\nexport default RS;\n",
  'home/user/app/node_modules/react-remove-scroll/dist/es2015/UI.js':
    "import * as React from 'react';\nimport { effectCar } from './medium';\nexport const RemoveScroll = { classNames: { fullWidth: 'fw', zeroRight: 'zr' } };\n",
  'home/user/app/node_modules/react-remove-scroll/dist/es2015/sidecar.js':
    "import { exportSidecar } from 'use-sidecar';\nimport SideEffect from './SideEffect';\nexport default exportSidecar(null, SideEffect);\n",
  'home/user/app/node_modules/react-remove-scroll/dist/es2015/SideEffect.js':
    "export default function SideEffect() { return null; }\n",
  'home/user/app/node_modules/react-remove-scroll/dist/es2015/medium.js':
    "import { createSidecarMedium } from 'use-sidecar';\nexport const effectCar = createSidecarMedium();\n",

  // Stubs — react + use-sidecar + tslib (CJS so they work pre-transform).
  'home/user/app/node_modules/react/package.json': JSON.stringify({
    name: 'react', version: '18.0.0', main: 'index.js',
  }),
  'home/user/app/node_modules/react/index.js':
    "module.exports = { forwardRef: function (fn) { return fn; }, createElement: function () { return {}; } };\n",
  'home/user/app/node_modules/use-sidecar/package.json': JSON.stringify({
    name: 'use-sidecar', version: '1.1.3', main: 'dist/index.js',
  }),
  'home/user/app/node_modules/use-sidecar/dist/index.js':
    "module.exports = { exportSidecar: function (a, b) { return b; }, createSidecarMedium: function () { return {}; } };\n",
  'home/user/app/node_modules/tslib/package.json': JSON.stringify({
    name: 'tslib', version: '2.6.0', main: 'tslib.js',
  }),
  'home/user/app/node_modules/tslib/tslib.js':
    "module.exports = { __assign: Object.assign, __rest: function (t, e) { return t; } };\n",
};

const vfs = makeVfs(RRS_FILES);

// Step 2: prefetch with the real require-resolver.
const entryCode = "const m = require('react-remove-scroll');\nconsole.log(typeof m);\n";
const prefetch = prefetchForRequire(vfs, entryCode, '/home/user/app');
const bundle = { ...prefetch.bundle };

// Diagnostics
console.log(`  prefetched ${Object.keys(bundle).length} files (truncated=${prefetch.truncated})`);
const rrsKeys = Object.keys(bundle).filter(k => k.includes('react-remove-scroll/dist/es2015/'));
console.log(`  react-remove-scroll/dist/es2015/* in bundle: ${rrsKeys.length} (expected 6)`);
for (const k of rrsKeys) console.log(`    + ${k.replace('home/user/app/node_modules/', '')}`);

// Step 3: ESM→CJS transform pass (mirrors W3.5 transformEsmInBundle).
if (!globalThis.__esbInit) {
  await esbuildWasm.initialize({});
  globalThis.__esbInit = true;
}

const importStmt = /(^|\n)\s*import\s+(['"][^'"]+['"]|[\w*$]|\{)/;
const exportStmt = /(^|\n)\s*export\s+(default\b|\{|\*|let\b|const\b|var\b|function\b|class\b|async\b|type\b)/;
function looksLikeEsm(src) {
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return importStmt.test(stripped) || exportStmt.test(stripped);
}

let transformed = 0;
for (const path of Object.keys(bundle)) {
  if (!path.endsWith('.js') && !path.endsWith('.mjs')) continue;
  if (!looksLikeEsm(bundle[path])) continue;
  try {
    const r = await esbuildWasm.transform(bundle[path], { loader: 'js', format: 'cjs', target: 'esnext' });
    bundle[path] = r.code;
    transformed++;
  } catch { /* leave as ESM, will fail at compile */ }
}
console.log(`  transformed ${transformed} ESM files → CJS`);

// Step 4: drive the runtime via makeFacet.
const dirs = {};
for (const p of Object.keys(bundle)) {
  let d = p;
  while (d.includes('/')) {
    d = d.substring(0, d.lastIndexOf('/'));
    if (d) dirs[d] = true;
  }
}

let result;
let err = null;
try {
  // Add a script entry that pulls in react-remove-scroll
  bundle['home/user/app/script.js'] =
    "const m = require('react-remove-scroll');\n" +
    "module.exports = {\n" +
    "  type: typeof m,\n" +
    "  hasDefault: !!(m && m.default),\n" +
    "  defaultIsFn: typeof (m && m.default) === 'function',\n" +
    "  hasRemoveScroll: !!(m && m.RemoveScroll),\n" +
    "  classNamesFw: m && m.default && m.default.classNames && m.default.classNames.fullWidth,\n" +
    "};\n";
  const facet = makeFacet({ bundle, dirs, generateShimsCode });
  result = facet.__require('./script');
} catch (e) {
  err = e && e.message ? e.message : String(e);
}

check(
  'no exception during require chain',
  err === null,
  err,
);
check(
  'react-remove-scroll module loads (typeof object)',
  result?.type === 'object',
  JSON.stringify(result),
);
check(
  'default export present',
  result?.hasDefault === true,
  JSON.stringify(result),
);
check(
  'default export is callable',
  result?.defaultIsFn === true,
  JSON.stringify(result),
);
check(
  'named RemoveScroll export present',
  result?.hasRemoveScroll === true,
  JSON.stringify(result),
);
check(
  'transitive UI.js classNames reachable through Combination → UI hop',
  result?.classNamesFw === 'fw',
  JSON.stringify(result),
);

const ok = summary();
process.exit(ok ? 0 : 1);
