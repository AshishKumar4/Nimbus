#!/usr/bin/env bun
// X.5-Z5 e2e — @tailwindcss/vite loads end-to-end against the REAL
// ON-DISK PACKAGE FILES (not a synth fixture).
//
// Per X5Z5-plan.md §3.1: @tailwindcss/vite/dist/index.mjs is minified ESM
// where the first `import{...}` follows a `;` on the same line. Our
// looksLikeEsm at src/facet-manager.ts:766-776 misses the shape
// (blind-spot A: leading anchor; blind-spot B: required whitespace after
// `import`/`export`). Result: the file is shipped as-is, `new Function`
// rejects ESM, and the runtime surfaces:
//   "Cannot use import statement outside a module"
//
// PRE-FIX: red — verbatim runtime message at facet startup.
// POST-FIX: green — looksLikeEsm detects the minified ESM, esbuild
//   transforms it to CJS, and `require('@tailwindcss/vite')` returns
//   a function/object surface.
//
// Strategy mirrors x5l/e2e/e1-react-remove-scroll-real.mjs.

import { makeFacet, getOrInstallFixture, makeVfs } from '../../x5l/_helpers.mjs';
import { ok, summary } from '../../w6/_tap.mjs';
import { prefetchForRequire } from '../../../../src/runtime/require-resolver.ts';
import { generateShimsCode } from '../../../../src/runtime/node-shims.ts';
import * as esbuildWasm from 'esbuild-wasm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('X.5-Z5 e2e/tailwindcss-vite — @tailwindcss/vite loads end-to-end');

// Step 1: install (cached).
const fixture = getOrInstallFixture('z5-twv', ['@tailwindcss/vite@^4', 'vite@^5']);

fixture['home/user/app/package.json'] = JSON.stringify({
  name: 'app', version: '0.0.0',
  dependencies: { '@tailwindcss/vite': '^4' },
});

console.log(`  fixture: ${Object.keys(fixture).length} files loaded`);

// Step 2: synth VFS.
const vfs = makeVfs(fixture);

// Step 3: prefetch.
const entryCode = "const m = require('@tailwindcss/vite');\nconsole.log(typeof m);\n";
const prefetch = prefetchForRequire(vfs, entryCode, '/home/user/app');
let bundle = { ...prefetch.bundle };

console.log(`  prefetched ${Object.keys(bundle).length} files (truncated=${prefetch.truncated})`);
console.log(`  @tailwindcss files in bundle: ${Object.keys(bundle).filter(k => k.includes('@tailwindcss/')).length}`);

// PRIMARY ASSERTION 1: index.mjs landed.
const idxPath = 'home/user/app/node_modules/@tailwindcss/vite/dist/index.mjs';
ok('@tailwindcss/vite/dist/index.mjs landed in bundle', idxPath in bundle);

// Sanity-check: the file IS minified ESM with a `;import{` shape
// (the bug X5Z5 §3 targets).
if (idxPath in bundle) {
  const head = bundle[idxPath].slice(0, 1500);
  // Look for `;import{` or `;import "` patterns. Note: the file is
  // minified across one big line, so the leading-anchor `(^|\n)` rejects.
  const hasMinifiedImport = /[;}]\s*import\s*[{"]/.test(head);
  console.log(`  index.mjs head bytes: ${head.length}, has-minified-import-shape: ${hasMinifiedImport}`);
  ok('@tailwindcss/vite/dist/index.mjs IS minified-ESM with ;import{ shape (Z5 §3 target)',
    hasMinifiedImport);
}

// Step 4: ESM→CJS transform USING THE SAME looksLikeEsm AS facet-manager.
// We extract it from facet-manager.ts source so the test reflects the
// actual gate the runtime uses.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FM = path.resolve(HERE, '..', '..', '..', '..', 'src', 'facet-manager.ts');
const fmSrc = fs.readFileSync(FM, 'utf8');
const m = fmSrc.match(/function\s+looksLikeEsm\s*\([^)]*\)\s*:\s*boolean\s*\{([\s\S]*?)\n\}/);
if (!m) {
  console.log('NOT OK: cannot extract looksLikeEsm from facet-manager.ts');
  process.exit(1);
}
const looksLikeEsm = new Function('input',
  `const src = input;\n${m[1].replace(/:\s*string/g, '').replace(/:\s*boolean/g, '')}`
);

if (!globalThis.__esbInit) {
  await esbuildWasm.initialize({});
  globalThis.__esbInit = true;
}
let transformed = 0, transformFails = 0, missedEsm = 0;
for (const p of Object.keys(bundle)) {
  if (!p.endsWith('.js') && !p.endsWith('.mjs')) continue;
  // Pre-fix: this returns false on the minified index.mjs → we skip
  // it → ship as-is → runtime throws.
  if (!looksLikeEsm(bundle[p])) {
    // Audit-track: if a .mjs file slipped past looksLikeEsm,
    // count it. This is the precise pre-fix RED signal.
    if (p.endsWith('.mjs')) missedEsm++;
    continue;
  }
  try {
    const r = await esbuildWasm.transform(bundle[p], { loader: 'js', format: 'cjs', target: 'esnext' });
    bundle[p] = r.code;
    transformed++;
  } catch { transformFails++; }
}
console.log(`  transformed ${transformed} ESM→CJS, ${transformFails} failed, ${missedEsm} .mjs files missed by looksLikeEsm`);

// PRIMARY ASSERTION 2 (pre-fix RED, post-fix GREEN-via-zero):
// no .mjs file may slip past looksLikeEsm. Pre-fix: ≥1 (index.mjs). Post: 0.
ok('zero .mjs files missed by looksLikeEsm (Z5 §3 fix metric)', missedEsm === 0,
  `missed=${missedEsm} (pre-fix expected ≥1; post-fix should be 0)`);

// Step 5: dirs map.
const dirs = {};
for (const p of Object.keys(bundle)) {
  let d = p;
  while (d.includes('/')) {
    d = d.substring(0, d.lastIndexOf('/'));
    if (d) dirs[d] = true;
  }
}

bundle['home/user/app/script.js'] =
  "let m = null, err = null;\n" +
  "try { m = require('@tailwindcss/vite'); }\n" +
  "catch (e) { err = e && e.message ? e.message : String(e); }\n" +
  "module.exports = {\n" +
  "  err,\n" +
  "  type: typeof m,\n" +
  "  isFn: typeof m === 'function',\n" +
  "  hasDefault: m && typeof m === 'object' && 'default' in m,\n" +
  "  defaultIsFn: m && typeof m.default === 'function',\n" +
  "  keys: m && typeof m === 'object' ? Object.keys(m).slice(0, 6) : [],\n" +
  "};\n";

let result, hardErr = null;
try {
  const facet = makeFacet({ bundle, dirs, generateShimsCode });
  result = facet.__require('./script');
} catch (e) {
  hardErr = e && e.message ? e.message : String(e);
}

console.log(`  result: ${JSON.stringify(result).slice(0, 400)}`);
if (hardErr) console.log(`  hardErr: ${hardErr}`);

ok('no hard exception during runtime require chain', hardErr === null, hardErr);

// PRIMARY ASSERTIONS — Z5 PLAN §3 BLOCKER (the verbatim runtime fail
// from audit/probes/verify-90993b3/packages-local/tailwindcss-vite.out.txt:135):
//   "Cannot use import statement outside a module"
// Z5 §3 (looksLikeEsm) + the Z5 §3-extension (require-resolver IMPORT_RE)
// together fix THIS surface. Post-fix, prefetch enumerates the transitive
// '@tailwindcss/node' / '@tailwindcss/oxide' deps, and the .mjs body is
// transformed to CJS so `new Function` accepts it.

const errStr = (result?.err || '') + ' ' + (hardErr || '');
ok('Z5 §3 verbatim error message no longer surfaces',
  !errStr.includes('Cannot use import statement outside a module')
    && !errStr.includes("Unexpected token '{'. import call expects"),
  errStr.slice(0, 200));

// Downstream surface — these MAY still fail until separate gaps in the
// shim layer are closed (e.g. node:v8 module needed by jiti, etc.).
// Out of Z5 scope per Z5 plan §3.4. Documented in X5Z5-build-retro §3.
ok("[downstream — out of Z5 scope] no soft error from require('@tailwindcss/vite')",
  result?.err === null,
  result?.err);
ok('[downstream — out of Z5 scope] @tailwindcss/vite has a callable export',
  result?.isFn === true || result?.defaultIsFn === true,
  JSON.stringify(result));

summary('z5-e2e-tailwindcss-vite');
