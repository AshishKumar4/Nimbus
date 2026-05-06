#!/usr/bin/env bun
// X.5-M3 functional probe #1: when globalThis.__currentModulePath is set
// AND base is null/undefined AND input is a relative-path string, the URL
// shim's fallback uses "file:///" + __currentModulePath instead of the
// literal "file:///". This is the vite-flip behavior.
//
// Reproduces the exact vite call shape from logger.js:75:
//   new URL("../../package.json",
//           new URL("../../../src/node/constants.ts", import_meta.url))
// where import_meta.url === undefined post-esbuild-CJS substitution.
//
// With __currentModulePath = "node_modules/vite/dist/node/chunks/logger.js":
//   inner: "file:///node_modules/vite/src/node/constants.ts"
//   outer: "file:///node_modules/vite/package.json"   (correct!)
//
// Without the M3 fix (X.5-M only), the inner URL would be
// "file:///src/node/constants.ts" → outer "file:///package.json" (root-rel).

import { ok, eq, group, summary } from '../../w6/_tap.mjs';
import { getShimSource, loadWrappedURL } from './_eval-shims.mjs';

const src = getShimSource();
const loaded = loadWrappedURL();

group('M3 marker present in shim source', () => {
  ok('source contains "X.5-M3" marker', src.includes('X.5-M3'));
  ok('URL shim references globalThis.__currentModulePath',
    src.includes('__currentModulePath'));
});

if (loaded === null) {
  group('SKIP: M3 marker missing — RED state', () => {
    ok('FIX-NOT-APPLIED: URL shim must thread __currentModulePath', false);
  });
  summary('f1-url-null-base-current-module');
}

const { wrapped, stub } = loaded;

group('vite shape: __currentModulePath set, null-base relative URL', () => {
  // Prime the stub global as the runtime would.
  stub.__currentModulePath = 'node_modules/vite/dist/node/chunks/logger.js';

  let inner, outer;
  try {
    inner = new wrapped('../../../src/node/constants.ts', undefined);
  } catch (e) {
    ok('inner URL constructor did not throw', false, e.message);
  }
  ok('inner URL composed', inner !== undefined);
  if (inner) {
    eq('inner URL.href',
      inner.href,
      'file:///node_modules/vite/src/node/constants.ts');
  }
  if (inner) {
    try { outer = new wrapped('../../package.json', inner); }
    catch (e) { ok('outer URL did not throw', false, e.message); }
    ok('outer URL composed', outer !== undefined);
    if (outer) {
      eq('outer URL.href is real vite/package.json',
        outer.href, 'file:///node_modules/vite/package.json');
    }
  }
});

group('null base also works', () => {
  stub.__currentModulePath = 'node_modules/vite/dist/node/chunks/logger.js';
  let inst;
  try { inst = new wrapped('./neighbor.js', null); } catch {}
  ok('null base accepted', inst !== undefined);
  if (inst) {
    eq('null-base + relative resolves vs current module',
      inst.href,
      'file:///node_modules/vite/dist/node/chunks/neighbor.js');
  }
});

group('leading-slash __currentModulePath is normalized', () => {
  stub.__currentModulePath = '/node_modules/foo/bar.js';
  let inst;
  try { inst = new wrapped('./baz.js', undefined); } catch {}
  ok('absolute __currentModulePath accepted', inst !== undefined);
  if (inst) {
    // Both leading-slash and bare forms must produce the same result; the
    // shim must normalize (strip leading /) before composing the file:///.
    eq('href has no double-slash', inst.href, 'file:///node_modules/foo/baz.js');
  }
});

summary('f1-url-null-base-current-module');
