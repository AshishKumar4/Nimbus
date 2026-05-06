#!/usr/bin/env bun
// X.5-Z5 e2e — express loads end-to-end against the REAL ON-DISK PACKAGE
// FILES (not a synth fixture).
//
// Per X5Z5-plan.md §1.1 reproduction trail:
//   express → body-parser@1 → raw-body → http-errors → readable-stream@2
//   readable-stream@2/lib/_stream_writable.js:96 — util.inherits(Writable, Stream)
// where Stream is `require('stream')` → our __streamMod (Defect-A site).
//
// PRE-FIX: red — exact verbatim runtime message
//   "Object prototype may only be an Object or null: undefined"
// POST-FIX: green — `const m = require('express')` returns a function
//   and `m()` returns an Express app object with the standard API surface.
//
// Strategy mirrors x5l/e2e/e1-react-remove-scroll-real.mjs:
//   1. bun-add express into a cached scratch dir.
//   2. Read the on-disk package tree → synth-VFS payload.
//   3. Run prefetchForRequire + ESM transform + makeFacet.
//   4. Drive `require('express')` and `require('express')()` from a
//      script.js entry, capture errors and shape.

import { makeFacet, getOrInstallFixture, makeVfs } from '../../x5l/_helpers.mjs';
import { ok, summary } from '../../w6/_tap.mjs';
import { prefetchForRequire } from '../../../../src/require-resolver.ts';
import { generateShimsCode } from '../../../../src/node-shims.ts';
import * as esbuildWasm from 'esbuild-wasm';

console.log('X.5-Z5 e2e/express — express loads end-to-end (REAL files)');

// Step 1: install (cached) and load the real on-disk package tree.
const fixture = getOrInstallFixture('z5-express', ['express@^4']);

// Need a top-level user package.json so the resolver finds the entry.
fixture['home/user/app/package.json'] = JSON.stringify({
  name: 'app', version: '0.0.0',
  dependencies: { express: '^4' },
});

console.log(`  fixture: ${Object.keys(fixture).length} files loaded`);

// Step 2: synth VFS.
const vfs = makeVfs(fixture);

// Step 3: prefetch.
const entryCode = "const m = require('express');\nconsole.log(typeof m);\n";
const prefetch = prefetchForRequire(vfs, entryCode, '/home/user/app');
let bundle = { ...prefetch.bundle };

console.log(`  prefetched ${Object.keys(bundle).length} files (truncated=${prefetch.truncated})`);
console.log(`  express files in bundle: ${Object.keys(bundle).filter(k => k.includes('/express/')).length}`);
console.log(`  readable-stream files in bundle: ${Object.keys(bundle).filter(k => k.includes('/readable-stream/')).length}`);

// PRIMARY ASSERTION 1: express main reaches bundle.
const hasExpressMain = 'home/user/app/node_modules/express/index.js' in bundle
  || 'home/user/app/node_modules/express/lib/express.js' in bundle;
ok('express main file landed in bundle', hasExpressMain);

// `send/index.js` is the actual util.inherits(X, require('stream')) site
// in express's transitive chain (per /tmp/x5l-fixtures/z5-express/node_modules/send/index.js:173).
// http-errors uses the `inherits` package (not util.inherits with Stream).
const hasSend = 'home/user/app/node_modules/send/index.js' in bundle;
ok('send/index.js (util.inherits(X, require("stream")) site) landed in bundle',
  hasSend);

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

// Step 5: build dirs map for makeFacet.
const dirs = {};
for (const p of Object.keys(bundle)) {
  let d = p;
  while (d.includes('/')) {
    d = d.substring(0, d.lastIndexOf('/'));
    if (d) dirs[d] = true;
  }
}

// Entry script — captures the verbatim runtime error if it still throws.
bundle['home/user/app/script.js'] =
  "let m = null, app = null, err = null, errStack = '';\n" +
  "try { m = require('express'); }\n" +
  "catch (e) { err = e && e.message ? e.message : String(e); errStack = (e && e.stack) || ''; }\n" +
  "if (m && typeof m === 'function') {\n" +
  "  try { app = m(); } catch (e2) { err = (err || '') + '|app:' + (e2.message || String(e2)); }\n" +
  "}\n" +
  "module.exports = {\n" +
  "  err, errStack: errStack ? errStack.split('\\n').slice(0, 4).join(' || ') : '',\n" +
  "  type: typeof m,\n" +
  "  isFunction: typeof m === 'function',\n" +
  "  appType: typeof app,\n" +
  "  appHasUse: app && typeof app.use === 'function',\n" +
  "  appHasGet: app && typeof app.get === 'function',\n" +
  "  appHasListen: app && typeof app.listen === 'function',\n" +
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

// PRIMARY ASSERTION 2: no exception during runtime require chain.
ok('no hard exception during runtime require chain', hardErr === null, hardErr);

// PRIMARY ASSERTIONS — Z5 PLAN §1 BLOCKERS (the verbatim runtime fail
// from audit/probes/verify-90993b3/packages-local/express.out.txt:44):
//   "TypeError: Object prototype may only be an Object or null: undefined
//      at Object.create (<anonymous>)
//      at Object.inherits (runner.js:1110:60)"
// Z5 §1 Defect-A (synthetic .prototype on __streamMod) and Defect-B
// (guarded util.inherits) together fix THIS surface. Post-fix, the
// require('express') chain completes, returns a callable, and `m()`
// returns an Express app object.
//
// Note: a downstream EventEmitter-shim issue surfaces post-Z5 (express
// mixin-copies EventEmitter.prototype onto the `app` function via
// merge-descriptors, so `_e` is never initialized on the instance).
// That is OUT OF Z5 SCOPE — the Z5 investigation only documented
// Defect-A and Defect-B, both fixed in this wave. The downstream EE-
// shim issue is a separately discovered blocker that was previously
// MASKED by Z5; documented in audit/sections/X5Z5-build-retro.md §3.

ok('require("express") returns a function (Z5 §1 Defect-A unblocker)',
  result?.isFunction === true,
  `actual type: ${result?.type}, err: ${result?.err}`);

// In Express 4.x, `app` is a function (a function-with-properties).
// Accept both 'function' and 'object' (older shapes).
ok('express() returns an app callable (Z5 §1 Defect-A+B unblocker)',
  result?.appType === 'function' || result?.appType === 'object',
  `actual appType: ${result?.appType}`);

// Z5 specifically targets the verbatim message above. Assert the verbatim
// message is no longer present in either the require error or the app()
// error — neither pre-fix surface should reappear.
const errStr = (result?.err || '') + ' ' + (hardErr || '');
ok('Z5 §1 verbatim error message no longer surfaces',
  !errStr.includes('Object prototype may only be an Object or null'),
  errStr.slice(0, 200));

// Downstream surface — these MAY still fail until the EE-shim issue is
// addressed in a follow-up wave (out of Z5 scope per Z5 plan §1.4):
ok('[downstream — out of Z5 scope] express app has .use',
  result?.appHasUse === true,
  'post-Z5 EE-shim mixin issue, see X5Z5-build-retro §3');
ok('[downstream — out of Z5 scope] express app has .get',
  result?.appHasGet === true,
  'post-Z5 EE-shim mixin issue, see X5Z5-build-retro §3');
ok('[downstream — out of Z5 scope] express app has .listen',
  result?.appHasListen === true,
  'post-Z5 EE-shim mixin issue, see X5Z5-build-retro §3');

summary('z5-e2e-express');
