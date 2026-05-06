// X.5-F R3 functional probe — runtime CJS resolver should ESM-fallback
// for pure-ESM packages (e.g. nuxt) once the bundle has been ESM→CJS
// transformed in buildPrefetchBundle.
//
// This probe runs the runtime resolver in-process — no wrangler dev,
// no install. It loads the JS resolver-source emitted by
// src/_shared/exports-resolver.ts, plus a minimal harness that stands in
// for node-shims.ts's __resolvePkgSubpath, and asserts:
//
//   1. With the CURRENT __resolvePkgSubpath (CJS conditions only), a
//      package whose exports has only {types, import} returns null and
//      the caller-level fallback to /index.* also misses (no index.*
//      file in fixture). Expected: FAIL today, expected behaviour
//      after fix is PASS via ESM-condition fallback.
//
//   2. The shared resolver itself, when called with
//      DEFAULT_ESM_CONDITIONS, correctly returns "./dist/index.mjs".
//      This part should PASS today (it's the spec-correct behaviour;
//      the bug is that the runtime CJS wrapper doesn't try ESM as
//      a fallback).
//
// Output: audit/probes/x5f/functional/r3-esm-fallback.txt
// Exit 0 only when BOTH (a) shared-resolver returns mjs under ESM
// conds and (b) a __resolvePkgSubpath-shaped harness returns the file
// when given an ESM-fallback chance. Today the harness path RED-FAILS;
// after build phase C it must GREEN-PASS.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r3-esm-fallback.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5F R3 ESM-fallback functional probe ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

// Pull the shared resolver via ts-source (the exported TS file). We use
// dynamic import to avoid a tsc compile-step here.
const resolverModUrl = new URL('../../../../src/_shared/exports-resolver.ts', import.meta.url);
let mod;
try {
  mod = await import(resolverModUrl.href);
} catch (e) {
  log('!! could not import shared resolver TS module: ' + e.message);
  log('!! falling back to bun-friendly direct ts-import. Probe needs `bun` runtime.');
  process.exit(2);
}
const { resolveExports, resolvePackageEntry, DEFAULT_ESM_CONDITIONS, DEFAULT_CJS_CONDITIONS, getExportsResolverJS } = mod;

// Synthetic nuxt-shaped package.json (verified verbatim shape against
// registry packument at plan time)
const nuxtPkg = {
  name: 'nuxt',
  type: 'module',
  exports: {
    '.': { types: './types.d.mts', import: './dist/index.mjs' },
    './app': './dist/app/index.js',
    './kit': './kit.js',
  },
};

// Test 1 — shared resolver under CJS conditions returns null (spec-correct)
const cjsEntry = resolvePackageEntry(nuxtPkg, '.', DEFAULT_CJS_CONDITIONS);
log('test1 — CJS conds vs nuxt exports:    entry=' + JSON.stringify(cjsEntry));
const test1OK = cjsEntry === null;

// Test 2 — shared resolver under ESM conditions returns ./dist/index.mjs
const esmEntry = resolvePackageEntry(nuxtPkg, '.', DEFAULT_ESM_CONDITIONS);
log('test2 — ESM conds vs nuxt exports:    entry=' + JSON.stringify(esmEntry));
const test2OK = esmEntry === './dist/index.mjs';

// Test 3 — emulate __resolvePkgSubpath behaviour. This is the
// node-shims runtime caller. Today it ONLY tries CJS; after the C-phase
// fix it should try ESM as a fallback.
//
// We embed the SAME JS source the runtime sees (from getExportsResolverJS)
// and wire a stand-in __resolvePkgSubpath alongside it. Two flavours:
//   - "current": CJS conds only (today's behaviour)
//   - "fixed":   CJS first, then ESM-fallback (target behaviour)
const sharedJS = getExportsResolverJS();
const harnessJS = `
// Harness fixture: synthetic nuxt pkg + a tiny VFS lookup
const __NIMBUS_CJS_CONDITIONS = ['require','node','default'];
const NUXT_PKG = ${JSON.stringify(nuxtPkg)};
const VFS = new Set([
  'node_modules/nuxt/package.json',
  'node_modules/nuxt/dist/index.mjs',  // pre-bundled ESM→CJS
  'node_modules/nuxt/dist/app/index.js',
  'node_modules/nuxt/kit.js',
]);
function __resolveFile(base) {
  for (const ext of ['', '.js', '.mjs', '.cjs', '.json', '/index.js', '/index.cjs', '/index.mjs', '/index.json']) {
    if (VFS.has(base + ext)) return base + ext;
  }
  return null;
}

function resolvePkgSubpath_current(pkgDir, pkg, subpath) {
  // mirror node-shims.ts:1911-1950 CJS-only behaviour
  let entry = resolvePackageEntry(pkg, subpath, __NIMBUS_CJS_CONDITIONS);
  if (entry != null) {
    const stripped = entry.replace(/^\\.\\/+/, "");
    return __resolveFile(pkgDir + "/" + stripped);
  }
  // fallback: probe pkg.main / pkg.module / pkgDir/index — none of these
  // hit for nuxt (no main, no module, no index)
  if (subpath === ".") {
    if (typeof pkg.main === 'string') {
      const mainStripped = pkg.main.replace(/^\\.\\/+/, "");
      const r = __resolveFile(pkgDir + "/" + mainStripped);
      if (r) return r;
    }
    return __resolveFile(pkgDir + "/index");
  }
  return __resolveFile(pkgDir + "/" + subpath.replace(/^\\.\\/+/, ""));
}

function resolvePkgSubpath_fixed(pkgDir, pkg, subpath) {
  // PROPOSED FIX: try CJS first, then ESM.
  let entry = resolvePackageEntry(pkg, subpath, __NIMBUS_CJS_CONDITIONS);
  if (entry == null && pkg.exports != null) {
    entry = resolvePackageEntry(pkg, subpath, DEFAULT_ESM_CONDITIONS);
  }
  if (entry != null) {
    const stripped = entry.replace(/^\\.\\/+/, "");
    return __resolveFile(pkgDir + "/" + stripped);
  }
  if (subpath === ".") {
    if (typeof pkg.main === 'string') {
      const mainStripped = pkg.main.replace(/^\\.\\/+/, "");
      const r = __resolveFile(pkgDir + "/" + mainStripped);
      if (r) return r;
    }
    return __resolveFile(pkgDir + "/index");
  }
  return __resolveFile(pkgDir + "/" + subpath.replace(/^\\.\\/+/, ""));
}

const out = {
  current: resolvePkgSubpath_current('node_modules/nuxt', NUXT_PKG, '.'),
  fixed:   resolvePkgSubpath_fixed('node_modules/nuxt', NUXT_PKG, '.'),
};
return out;
`;

// Eval the harness via Function (we're in node test context, eval is fine)
let harnessOut;
try {
  const fn = new Function(sharedJS + '\n' + harnessJS);
  harnessOut = fn();
} catch (e) {
  log('!! harness eval failed: ' + e.message);
  process.exit(2);
}

log('test3 — __resolvePkgSubpath (current) → ' + JSON.stringify(harnessOut.current));
log('test4 — __resolvePkgSubpath (fixed)   → ' + JSON.stringify(harnessOut.fixed));

const test3OK = harnessOut.current === null;        // today: CJS-only path → null (the bug)
const test4OK = harnessOut.fixed === 'node_modules/nuxt/dist/index.mjs'; // proposed-fix

log('');
log('SUMMARY:');
log('  test1 CJS-yields-null:                    ' + (test1OK ? 'PASS' : 'FAIL'));
log('  test2 ESM-yields-mjs:                     ' + (test2OK ? 'PASS' : 'FAIL'));
log('  test3 __resolvePkgSubpath_current==null:  ' + (test3OK ? 'PASS' : 'FAIL'));
log('  test4 __resolvePkgSubpath_fixed==mjs:     ' + (test4OK ? 'PASS' : 'FAIL'));

// Today: tests 1,2,3 PASS; test 4 PASS only because we wrote the fix
// inline. The PURPOSE of this probe in TDD red is to EXIST as a guard:
// once node-shims.ts adopts the fix, test4 would still need to pass and
// crucially we need a DIFFERENT assertion that fails RED today.
//
// The RED-GATING assertion is: read the SHIPPED node-shims.ts
// __resolvePkgSubpath source and check whether it contains the ESM
// fallback. Today it does not → RED. After Phase C → GREEN.
const shimsSrc = fs.readFileSync(
  path.join(HERE, '../../../../src/node-shims.ts'),
  'utf8',
);
const HAS_ESM_FALLBACK_RE = /entry\s*==\s*null\s*&&\s*pkg\.exports\s*!=\s*null/;
const hasEsmFallback = HAS_ESM_FALLBACK_RE.test(shimsSrc);
log('test5 node-shims.ts has ESM-fallback:     ' + (hasEsmFallback ? 'PASS' : 'FAIL — expected after Phase C'));

const allOK = test1OK && test2OK && test3OK && test4OK && hasEsmFallback;
log('OVERALL: ' + (allOK ? 'PASS' : 'FAIL'));
process.exit(allOK ? 0 : 1);
