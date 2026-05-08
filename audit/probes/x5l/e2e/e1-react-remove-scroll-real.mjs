// X.5-L e2e — `react-remove-scroll` loads end-to-end against the
// REAL ON-DISK PACKAGE FILES (not a synth fixture).
//
// This is the X.5-L answer to the verification doc's verbatim failure:
//   `Error: Cannot find module 'react-remove-scroll-bar/constants'
//    (from home/user/app/node_modules/react-remove-scroll/dist/es2015)`
//
// Strategy mirrors X.5-C e1 but loads the REAL filesystem of
// react-remove-scroll@^2.7 + react-remove-scroll-bar@^2.3 + dependencies
// installed via `bun add` into /tmp/x5l-fixtures/rrs (in _helpers
// `getOrInstallFixture`, so subsequent runs are cached).
//
// Pre-fix: FAIL — real react-remove-scroll-bar has NO `exports` field;
//          its `constants/` subpath is a directory with a back-pointing
//          nested package.json. Walker doesn't know about it, so
//          `dist/es5/constants.js` (or es2015/constants.js) is missing
//          from the bundle. Runtime require chain throws.
// Post-fix: PASS — the legacy nested-pkg fallback in resolvePkgSubpath
//          finds and walks the back-pointer.

import { makeFacet, getOrInstallFixture, check, summary, reset } from '../_helpers.mjs';
import { prefetchForRequire } from '../../../../src/runtime/require-resolver.ts';
import { generateShimsCode } from '../../../../src/runtime/node-shims.ts';
import * as esbuildWasm from 'esbuild-wasm';

reset();

console.log('X.5-L e2e/e1-react-remove-scroll-real — package loads end-to-end (REAL files)');

// Step 1: install (if needed) and load the real on-disk package tree.
const fixture = getOrInstallFixture('rrs', [
  'react-remove-scroll@^2.7',
  'react-remove-scroll-bar@^2.3',
  'react@^18',
  'react-dom@^18',
  'tslib',
  'use-sidecar',
  'use-callback-ref',
  'react-style-singleton',
  'get-nonce',
]);

// Filesystem-loaded files don't include a top-level user package.json.
fixture['home/user/app/package.json'] = JSON.stringify({
  name: 'app', version: '0.0.0',
  dependencies: { 'react-remove-scroll': '^2.7' },
});

console.log(`  fixture: ${Object.keys(fixture).length} files loaded`);

// Step 2: synth VFS — we need the SqliteVFS shape for prefetchForRequire.
// makeVfs builds dirs lazily from file paths; we re-use it.
const { makeVfs } = await import('../_helpers.mjs');
const vfs = makeVfs(fixture);

// Step 3: prefetch.
const entryCode = "const m = require('react-remove-scroll');\nconsole.log(typeof m);\n";
const prefetch = prefetchForRequire(vfs, entryCode, '/home/user/app');
let bundle = { ...prefetch.bundle };

console.log(`  prefetched ${Object.keys(bundle).length} files (truncated=${prefetch.truncated})`);
const constantsKeys = Object.keys(bundle).filter(k => k.includes('react-remove-scroll-bar'));
console.log(`  react-remove-scroll-bar/* in bundle: ${constantsKeys.length}`);
for (const k of constantsKeys.slice(0, 12)) {
  console.log(`    + ${k.replace('home/user/app/node_modules/', '')}`);
}

// PRIMARY ASSERTION 1: a `constants` file (es5 or es2015) lands in the bundle.
const hasConstants =
  ('home/user/app/node_modules/react-remove-scroll-bar/dist/es5/constants.js' in bundle) ||
  ('home/user/app/node_modules/react-remove-scroll-bar/dist/es2015/constants.js' in bundle);
check(
  'react-remove-scroll-bar/dist/{es5|es2015}/constants.js — bare subpath landed in bundle',
  hasConstants,
  'walker must follow `import \'react-remove-scroll-bar/constants\'` from react-remove-scroll',
);

// Step 4: ESM→CJS transform (mirrors W3.5 transformEsmInBundle).
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
let transformed = 0, transformFails = 0;
for (const p of Object.keys(bundle)) {
  if (!p.endsWith('.js') && !p.endsWith('.mjs')) continue;
  if (!looksLikeEsm(bundle[p])) continue;
  try {
    const r = await esbuildWasm.transform(bundle[p], { loader: 'js', format: 'cjs', target: 'esnext' });
    bundle[p] = r.code;
    transformed++;
  } catch { transformFails++; }
}
console.log(`  transformed ${transformed} ESM → CJS (${transformFails} failed)`);

// Step 5: drive the runtime via makeFacet.
const dirs = {};
for (const p of Object.keys(bundle)) {
  let d = p;
  while (d.includes('/')) {
    d = d.substring(0, d.lastIndexOf('/'));
    if (d) dirs[d] = true;
  }
}

bundle['home/user/app/script.js'] =
  "let m, err = null;\n" +
  "try { m = require('react-remove-scroll'); }\n" +
  "catch (e) { err = e && e.message ? e.message : String(e); }\n" +
  "// esbuild-CJS transform of `export default X` lands at one of m, m.default,\n" +
  "// or sometimes both. Probe all three so the assertion is robust to interop.\n" +
  "function findRemoveScroll(mod) {\n" +
  "  if (!mod) return null;\n" +
  "  if (typeof mod === 'function') return mod;\n" +
  "  if (typeof mod.default === 'function') return mod.default;\n" +
  "  if (typeof mod.RemoveScroll === 'function') return mod.RemoveScroll;\n" +
  "  if (mod.RemoveScroll && typeof mod.RemoveScroll === 'object' && mod.RemoveScroll.classNames) return mod.RemoveScroll;\n" +
  "  return null;\n" +
  "}\n" +
  "const rs = m ? findRemoveScroll(m) : null;\n" +
  "const cn = (rs && rs.classNames) || (m && m.default && m.default.classNames) || (m && m.classNames) || null;\n" +
  "module.exports = {\n" +
  "  err,\n" +
  "  type: typeof m,\n" +
  "  hasRemoveScroll: !!(m && m.RemoveScroll),\n" +
  "  removeScrollResolved: !!rs,\n" +
  "  classNamesFw: cn && cn.fullWidth,\n" +
  "  keys: m ? Object.keys(m).slice(0, 10) : [],\n" +
  "};\n";

let result, hardErr = null;
try {
  const facet = makeFacet({ bundle, dirs, generateShimsCode });
  result = facet.__require('./script');
} catch (e) {
  hardErr = e && e.message ? e.message : String(e);
}

console.log(`  result: ${JSON.stringify(result)}`);
if (hardErr) console.log(`  hardErr: ${hardErr}`);

// PRIMARY ASSERTION 2: no exception during runtime require chain.
check(
  'no hard exception during runtime require chain',
  hardErr === null,
  hardErr,
);

// PRIMARY ASSERTION 3: no soft error (caught try/catch around require).
check(
  'no soft error from require(\'react-remove-scroll\')',
  result?.err === null,
  result?.err,
);

// PRIMARY ASSERTION 4: module loads to an object.
check(
  'react-remove-scroll loads to an object',
  result?.type === 'object',
  JSON.stringify(result),
);

// SECONDARY ASSERTION: a usable RemoveScroll value is reachable via
// any of the standard interop shapes (m, m.default, m.RemoveScroll).
check(
  'react-remove-scroll exposes a usable RemoveScroll value',
  result?.removeScrollResolved === true || result?.hasRemoveScroll === true,
  JSON.stringify(result),
);

// TERTIARY ASSERTION (fix-specific): classNames reachable through the
// constants chain. react-remove-scroll's UI.js does:
//   import { fullWidthClassName, zeroRightClassName } from 'react-remove-scroll-bar/constants';
// If our fix worked, the constants module is loaded and its values
// flow through Combination.js → UI.js into the public API. We probe
// for any classNames object reachable from the module surface; the
// exact name varies by esbuild interop output.
check(
  'react-remove-scroll classNames.fullWidth reachable through constants chain (fix-specific)',
  typeof result?.classNamesFw === 'string',
  JSON.stringify(result),
);

const ok = summary();
process.exit(ok ? 0 : 1);
