// X.5-C e2e — @radix-ui/react-dialog acceptance signal.
//
// X5F-retro flagged radix-dialog as the parent that walks into the
// X.5-C cohort. After Fix #1, the deep ESM import chain (radix-dialog
// → react-remove-scroll → react-remove-scroll-bar / react-style-singleton
// / use-callback-ref / use-sidecar) becomes reachable and the package
// loads.
//
// We don't synth radix-dialog's full tree (that's hundreds of files);
// we synth a minimal reachability graph that mirrors the failure shape
// from X5F-retro line 145.

import { makeVfs, makeFacet, check, summary, reset } from '../_helpers.mjs';
import { prefetchForRequire } from '../../../../src/runtime/require-resolver.ts';
import { generateShimsCode } from '../../../../src/runtime/node-shims.ts';
import * as esbuildWasm from 'esbuild-wasm';

reset();

console.log('X.5-C e2e/e3-radix-react-dialog — radix-dialog reachability + sibling cluster');

const FILES = {
  'home/user/app/package.json': JSON.stringify({ name: 'app' }),

  // @radix-ui/react-dialog (minimal shape)
  'home/user/app/node_modules/@radix-ui/react-dialog/package.json': JSON.stringify({
    name: '@radix-ui/react-dialog',
    version: '1.1.0',
    main: 'dist/index.js',
    module: 'dist/index.mjs',
    exports: {
      '.': {
        import: './dist/index.mjs',
        require: './dist/index.js',
        default: './dist/index.js',
      },
    },
  }),
  'home/user/app/node_modules/@radix-ui/react-dialog/dist/index.js':
    "var React = require('react');\n" +
    "var rrs = require('react-remove-scroll');\n" +
    "exports.Dialog = function () { return null; };\n" +
    "exports.DialogContent = function () { return null; };\n" +
    "exports.RemoveScrollDefault = rrs.default;\n",
  'home/user/app/node_modules/@radix-ui/react-dialog/dist/index.mjs':
    "import * as React from 'react';\n" +
    "import { default as RemoveScroll } from 'react-remove-scroll';\n" +
    "export const Dialog = function () { return null; };\n" +
    "export const DialogContent = function () { return null; };\n" +
    "export const RemoveScrollDefault = RemoveScroll;\n",

  // react-remove-scroll (the X.5-C primary target)
  'home/user/app/node_modules/react-remove-scroll/package.json': JSON.stringify({
    name: 'react-remove-scroll', version: '2.7.2',
    main: 'dist/es5/index.js',
    module: 'dist/es2015/index.js',
  }),
  'home/user/app/node_modules/react-remove-scroll/dist/es2015/index.js':
    "import RemoveScroll from './Combination';\nexport { RemoveScroll };\nexport default RemoveScroll;\n",
  'home/user/app/node_modules/react-remove-scroll/dist/es2015/Combination.js':
    "import * as React from 'react';\n" +
    "import { fullWidthClassName, zeroRightClassName } from 'react-remove-scroll-bar';\n" +
    "import { styleSingleton } from 'react-style-singleton';\n" +
    "import SideCar from './sidecar';\n" +
    "function RS() { return null; }\n" +
    "RS.classNames = { fullWidth: fullWidthClassName, zeroRight: zeroRightClassName };\n" +
    "RS.styleSingleton = styleSingleton;\n" +
    "RS.sideCar = SideCar;\n" +
    "export default RS;\n",
  'home/user/app/node_modules/react-remove-scroll/dist/es2015/sidecar.js':
    "import { exportSidecar } from 'use-sidecar';\nimport { useMergeRefs } from 'use-callback-ref';\nimport SideEffect from './SideEffect';\nexport default exportSidecar(useMergeRefs, SideEffect);\n",
  'home/user/app/node_modules/react-remove-scroll/dist/es2015/SideEffect.js':
    "export default function SideEffect() { return null; }\n",

  // Sibling cluster — also part of X.5-C charter
  'home/user/app/node_modules/react-remove-scroll-bar/package.json': JSON.stringify({
    name: 'react-remove-scroll-bar', version: '2.3.7',
    main: 'dist/es5/index.js',
    module: 'dist/es2015/index.js',
  }),
  'home/user/app/node_modules/react-remove-scroll-bar/dist/es2015/index.js':
    "export const fullWidthClassName = 'fw';\nexport const zeroRightClassName = 'zr';\n",

  'home/user/app/node_modules/react-style-singleton/package.json': JSON.stringify({
    name: 'react-style-singleton', version: '2.2.3',
    main: 'dist/es5/index.js',
    module: 'dist/es2015/index.js',
  }),
  'home/user/app/node_modules/react-style-singleton/dist/es2015/index.js':
    "export function styleSingleton() { return function () {}; }\n",

  'home/user/app/node_modules/use-callback-ref/package.json': JSON.stringify({
    name: 'use-callback-ref', version: '1.3.3',
    main: 'dist/es5/index.js',
    module: 'dist/es2015/index.js',
  }),
  'home/user/app/node_modules/use-callback-ref/dist/es2015/index.js':
    "export function useMergeRefs() { return function () {}; }\n",

  'home/user/app/node_modules/use-sidecar/package.json': JSON.stringify({
    name: 'use-sidecar', version: '1.1.3',
    main: 'dist/es5/index.js',
    module: 'dist/es2015/index.js',
  }),
  'home/user/app/node_modules/use-sidecar/dist/es2015/index.js':
    "export function exportSidecar(a, b) { return b; }\n",

  // react stub
  'home/user/app/node_modules/react/package.json': JSON.stringify({
    name: 'react', version: '18.0.0', main: 'index.js',
  }),
  'home/user/app/node_modules/react/index.js':
    "module.exports = { forwardRef: function (fn) { return fn; }, createElement: function () { return {}; } };\n",
};

const vfs = makeVfs(FILES);

// Use require so the runtime hits the CJS path (where the package's main
// field is read first) — but the chain still hits ESM transitives.
const entryCode = "const m = require('@radix-ui/react-dialog');\nconsole.log(m);\n";
const prefetch = prefetchForRequire(vfs, entryCode, '/home/user/app');
const bundle = { ...prefetch.bundle };

console.log(`  prefetched ${Object.keys(bundle).length} files`);
const interesting = Object.keys(bundle).filter(k =>
  k.includes('react-remove-scroll') || k.includes('react-style') ||
  k.includes('use-callback-ref') || k.includes('use-sidecar') ||
  k.includes('react-dialog')
);
console.log(`  X.5-C-relevant in bundle: ${interesting.length}`);
for (const k of interesting) console.log(`    + ${k.replace('home/user/app/node_modules/', '')}`);

// ESM→CJS transform pass (mimics W3.5 transformEsmInBundle)
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
let xformCount = 0;
for (const p of Object.keys(bundle)) {
  if (!(p.endsWith('.js') || p.endsWith('.mjs'))) continue;
  if (!looksLikeEsm(bundle[p])) continue;
  try {
    const r = await esbuildWasm.transform(bundle[p], { loader: 'js', format: 'cjs', target: 'esnext' });
    bundle[p] = r.code;
    xformCount++;
  } catch { /* skip */ }
}
console.log(`  transformed ${xformCount} ESM files → CJS`);

const dirs = {};
for (const p of Object.keys(bundle)) {
  let d = p;
  while (d.includes('/')) {
    d = d.substring(0, d.lastIndexOf('/'));
    if (d) dirs[d] = true;
  }
}

bundle['home/user/app/script.js'] =
  "const dialog = require('@radix-ui/react-dialog');\n" +
  "module.exports = {\n" +
  "  hasDialog: typeof (dialog.Dialog || (dialog.default && dialog.default.Dialog)) === 'function',\n" +
  "  hasContent: typeof (dialog.DialogContent || (dialog.default && dialog.default.DialogContent)) === 'function',\n" +
  "  hasRRS: !!(dialog.RemoveScrollDefault || (dialog.default && dialog.default.RemoveScrollDefault)),\n" +
  "  rrsClassNamesFw: ((dialog.RemoveScrollDefault && dialog.RemoveScrollDefault.classNames) ||\n" +
  "                    (dialog.default && dialog.default.RemoveScrollDefault && dialog.default.RemoveScrollDefault.classNames) ||\n" +
  "                    {}).fullWidth,\n" +
  "};\n";

let result;
let err = null;
try {
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
  '@radix-ui/react-dialog.Dialog is a function',
  result?.hasDialog === true,
  JSON.stringify(result),
);
check(
  '@radix-ui/react-dialog.DialogContent is a function',
  result?.hasContent === true,
  JSON.stringify(result),
);
check(
  'react-remove-scroll default reachable through dialog',
  result?.hasRRS === true,
  JSON.stringify(result),
);
check(
  'sibling-cluster: react-remove-scroll-bar.fullWidthClassName reachable',
  result?.rrsClassNamesFw === 'fw',
  JSON.stringify(result),
);

const ok = summary();
process.exit(ok ? 0 : 1);
