// X.5-L e2e bonus — `defu` (transitive of nuxt) investigation.
//
// The verify probe (audit/probes/verify-eb316dc/packages-local/nuxt.out.txt)
// reports `Cannot find module '../dist/defu.cjs' (from .../defu/lib)`.
//
// HYPOTHESIS (per Phase A plan): defu's failure is a DIFFERENT class —
//   - defu has an `exports` map: `.` → `require: './lib/defu.cjs'`.
//   - The walker resolves require('defu') → `node_modules/defu/lib/defu.cjs`.
//   - lib/defu.cjs does `require("../dist/defu.cjs")` (relative).
//   - The walker's REQUIRE_RE handles relative requires.
//   - BUT something prevents `dist/defu.cjs` from landing in the bundle.
//
// This probe pins down the root cause by:
//   1. Loading the real on-disk defu package files.
//   2. Running prefetchForRequire.
//   3. Asserting `node_modules/defu/dist/defu.cjs` IS in the bundle.
//   4. Running the runtime require chain end-to-end.
//
// If (3) fails: bonus IS the same root cause class — relative-path
//                resolution gap somewhere.
// If (3) passes but runtime fails: different class (runtime resolver).
// If (3) passes and runtime passes: defu was already a non-issue;
//                                   the verify failure was caused by
//                                   a DIFFERENT chain inside nuxt's
//                                   500+ deps, and we got a misleading
//                                   error string. Document and defer.

import { makeFacet, makeVfs, getOrInstallFixture, check, summary, reset } from '../_helpers.mjs';
import { prefetchForRequire } from '../../../../src/require-resolver.ts';
import { generateShimsCode } from '../../../../src/node-shims.ts';
import * as esbuildWasm from 'esbuild-wasm';

reset();

console.log('X.5-L e2e/e3-nuxt-defu-investigation — defu loads (root-cause analysis)');

const fixture = getOrInstallFixture('defu', ['defu']);
fixture['home/user/app/package.json'] = JSON.stringify({
  name: 'app', version: '0.0.0',
  dependencies: { defu: '*' },
});

console.log(`  fixture: ${Object.keys(fixture).length} files loaded`);
const defuKeys = Object.keys(fixture).filter(k => k.includes('/defu/'));
for (const k of defuKeys) console.log(`    fs: ${k.replace('home/user/app/node_modules/', '')}`);

const vfs = makeVfs(fixture);

const entryCode = "const m = require('defu');\nconsole.log(typeof m);\n";
const prefetch = prefetchForRequire(vfs, entryCode, '/home/user/app');
let bundle = { ...prefetch.bundle };

const inBundle = (p) => p.replace(/^\/+/, '') in bundle;
console.log(`  prefetched ${Object.keys(bundle).length} files (truncated=${prefetch.truncated})`);
const bundledDefuKeys = Object.keys(bundle).filter(k => k.includes('/defu/'));
for (const k of bundledDefuKeys) console.log(`    bundle: ${k.replace('home/user/app/node_modules/', '')}`);

// Pin assertion (3): is dist/defu.cjs in the bundle?
const distInBundle = inBundle('home/user/app/node_modules/defu/dist/defu.cjs');
console.log(`  hypothesis check: dist/defu.cjs in bundle? ${distInBundle}`);
check(
  'defu/dist/defu.cjs in bundle (verify defu chain root-cause)',
  distInBundle,
  'if false: relative ../dist/defu.cjs from lib/defu.cjs not walked → bug class',
);

// ESM→CJS transform.
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
for (const p of Object.keys(bundle)) {
  if (!p.endsWith('.js') && !p.endsWith('.mjs')) continue;
  if (!looksLikeEsm(bundle[p])) continue;
  try {
    const r = await esbuildWasm.transform(bundle[p], { loader: 'js', format: 'cjs', target: 'esnext' });
    bundle[p] = r.code;
  } catch { /* leave */ }
}

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
  "try { m = require('defu'); }\n" +
  "catch (e) { err = e && e.message ? e.message : String(e); }\n" +
  "module.exports = {\n" +
  "  err,\n" +
  "  type: typeof m,\n" +
  "  isFunction: typeof m === 'function',\n" +
  "  hasDefu: !!(m && (m.defu || typeof m === 'function')),\n" +
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

check('no hard exception during runtime require chain', hardErr === null, hardErr);
check('no soft error from require(\'defu\')', result?.err === null, result?.err);
check('defu loads (function or object)', result?.type === 'function' || result?.type === 'object', JSON.stringify(result));

const ok = summary();
process.exit(ok ? 0 : 1);
