// X.5-F R1 functional probe — top-level user-typed package names must
// bypass SKIP_PACKAGES. Today they don't.
//
// We exercise resolveTree via the same in-process bun ts-import path as
// r2, but with a single top-level spec for a name in SKIP_PACKAGES
// (e.g. webpack). The fake registry returns a packument with NO
// dependencies — so a successful path returns Map{webpack}, but the
// buggy path returns Map{} (silent skip at line 544 of npm-resolver.ts).
//
// Output: audit/probes/x5f/functional/r1-toplevel-bypass.txt

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r1-toplevel-bypass.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5F R1 toplevel-bypass functional probe ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

let resolveTree, shouldSkipPackage, shouldSkipPackageWithFramework;
try {
  ({ resolveTree, shouldSkipPackage, shouldSkipPackageWithFramework } = await import(
    new URL('../../../../src/npm/resolver.ts', import.meta.url).href
  ));
} catch (e) {
  log('!! could not import npm-resolver: ' + e.message);
  process.exit(2);
}

// Sanity baseline — ensure these names are still considered skip-worthy
// when consulted directly. (If this assertion ever flips, someone removed
// the entries from SKIP_PACKAGES and the R1 fix is moot.)
log('baseline: shouldSkipPackage("webpack") = ' + shouldSkipPackage('webpack'));
log('baseline: shouldSkipPackage("rollup")  = ' + shouldSkipPackage('rollup'));
log('baseline: shouldSkipPackage("parcel")  = ' + shouldSkipPackage('parcel'));

const fakeCache = new Proxy({}, { get: () => () => null });

const REGISTRY = {
  webpack: {
    name: 'webpack', 'dist-tags': { latest: '5.0.0' },
    versions: { '5.0.0': {
      name: 'webpack', version: '5.0.0', dependencies: {},
      dist: { tarball: 'http://example.invalid/w-5.0.0.tgz', integrity: 'sha512-AAAA' },
    } },
  },
  rollup: {
    name: 'rollup', 'dist-tags': { latest: '4.0.0' },
    versions: { '4.0.0': {
      name: 'rollup', version: '4.0.0', dependencies: {},
      dist: { tarball: 'http://example.invalid/r-4.0.0.tgz', integrity: 'sha512-BBBB' },
    } },
  },
  // X.5-G G2: applySwaps now rewrites top-level `rollup` →
  // `@rollup/wasm-node`. Add the swap target to the fake registry so
  // resolveTree can complete; the assertion below recognises the swap.
  '@rollup/wasm-node': {
    name: '@rollup/wasm-node', 'dist-tags': { latest: '4.0.0' },
    versions: { '4.0.0': {
      name: '@rollup/wasm-node', version: '4.0.0', dependencies: {},
      dist: { tarball: 'http://example.invalid/rwn-4.0.0.tgz', integrity: 'sha512-DDDD' },
    } },
  },
  parcel: {
    name: 'parcel', 'dist-tags': { latest: '2.0.0' },
    versions: { '2.0.0': {
      name: 'parcel', version: '2.0.0', dependencies: {},
      dist: { tarball: 'http://example.invalid/p-2.0.0.tgz', integrity: 'sha512-CCCC' },
    } },
  },
};

async function fakeFetch(url) {
  const m = String(url).match(/registry\.npmjs\.org\/([^/?]+(?:\/[^/?]+)?)$/);
  const name = m ? decodeURIComponent(m[1]) : null;
  const pkg = name && REGISTRY[name];
  return pkg
    ? new Response(JSON.stringify(pkg), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({ error: 'not mocked: ' + url }), { status: 404 });
}

// X.5-G G2: applySwaps may rewrite the top-level name BEFORE
// resolveTree sees it (rollup → @rollup/wasm-node). The R1 probe's
// intent is "name was no longer silently skipped" — accept either
// the original name OR a known swap target.
const SWAP_TARGETS = new Map([
  ['rollup', '@rollup/wasm-node'],
  ['esbuild', 'esbuild-wasm'],
]);

async function tryInstall(name) {
  let r;
  try {
    r = await resolveTree({ [name]: '*' }, fakeCache, undefined, () => {}, fakeFetch, {});
  } catch (e) {
    return { name, ok: false, err: e.message, count: 0 };
  }
  const swapTarget = SWAP_TARGETS.get(name);
  const ok = r.has(name) || (!!swapTarget && r.has(swapTarget));
  return { name, ok, count: r.size };
}

const results = [];
for (const n of ['webpack', 'rollup', 'parcel']) {
  const r = await tryInstall(n);
  log('  ' + n + ': resolved.size=' + r.count + ' has(' + n + ')=' + r.ok + (r.err ? ' err=' + r.err : ''));
  results.push(r);
}

const t1 = results[0].ok;
const t2 = results[1].ok;
const t3 = results[2].ok;

log('');
log('SUMMARY:');
log('  t1 webpack top-level installs:    ' + (t1 ? 'PASS' : 'FAIL'));
log('  t2 rollup top-level installs:     ' + (t2 ? 'PASS' : 'FAIL'));
log('  t3 parcel top-level installs:     ' + (t3 ? 'PASS' : 'FAIL'));
log('OVERALL: ' + (t1 && t2 && t3 ? 'PASS' : 'FAIL'));
process.exit(t1 && t2 && t3 ? 0 : 1);
