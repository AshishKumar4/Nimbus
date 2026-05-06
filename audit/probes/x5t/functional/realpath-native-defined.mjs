#!/usr/bin/env bun
// X.5-T functional — assert that fs.realpathSync.native exists, is
// callable, and is the same function reference as fs.realpathSync.
//
// Reproduces TypeScript 5.6.3 / 6.0.3 getNodeSystem's expression at
// typescript.js:8291: `!!_fs.realpathSync.native`. PRE-FIX this throws
// `Cannot read properties of undefined (reading 'native')` because
// __fsMod's return-object literal at src/node-shims.ts:608 is missing
// `realpathSync`. POST-FIX it returns a string equal to
// path.resolve(p) (no-op symlink resolution; VFS has no symlinks).
//
// PRE-FIX: red.
// POST-FIX: green.

import { ok, eq, summary, group } from '../../w6/_tap.mjs';
import { makeFacet } from '../../x5c/_helpers.mjs';
import { generateShimsCode } from '../../../../src/node-shims.ts';

const fixture = {
  'home/user/app/script.js':
    // Reproduce TS getNodeSystem's pattern verbatim:
    "  const _fs = require('fs');\n" +
    "  const errs = {};\n" +
    "  let nativeIsTruthy = null;\n" +
    "  let realpathSyncType = null;\n" +
    "  let realpathSyncNativeType = null;\n" +
    "  let sameRef = null;\n" +
    "  let resultPlain = null;\n" +
    "  let resultNative = null;\n" +
    "  try { realpathSyncType = typeof _fs.realpathSync; } catch (e) { errs.r = e.message; }\n" +
    "  try { realpathSyncNativeType = typeof (_fs.realpathSync && _fs.realpathSync.native); } catch (e) { errs.n = e.message; }\n" +
    "  try { nativeIsTruthy = !!_fs.realpathSync.native; } catch (e) { errs.bang = e.message; }\n" +
    "  try { sameRef = _fs.realpathSync === _fs.realpathSync.native; } catch (e) { errs.eq = e.message; }\n" +
    "  try { resultPlain = _fs.realpathSync('/foo'); } catch (e) { errs.p = e.message; }\n" +
    "  try { resultNative = _fs.realpathSync.native('/foo'); } catch (e) { errs.nc = e.message; }\n" +
    "  module.exports = { realpathSyncType, realpathSyncNativeType, nativeIsTruthy, sameRef, resultPlain, resultNative, errs };\n",
};
const dirs = { 'home/user/app': true };

let result;
let hardErr = null;
try {
  const facet = makeFacet({ bundle: fixture, dirs, generateShimsCode });
  result = facet.__require('./script');
} catch (e) {
  hardErr = e && e.message ? e.message : String(e);
}

group('shim evaluation', () => {
  ok('shim scope evaluates without error', hardErr === null, hardErr);
});

if (result) {
  group('fs.realpathSync — sync surface present', () => {
    eq('typeof fs.realpathSync === "function"', result.realpathSyncType, 'function');
    ok('fs.realpathSync("/foo") returns a string', typeof result.resultPlain === 'string',
      `actual=${JSON.stringify(result.resultPlain)} errs=${JSON.stringify(result.errs)}`);
    eq('fs.realpathSync("/foo") === "/foo"', result.resultPlain, '/foo');
  });

  group('fs.realpathSync.native — TS getNodeSystem fix surface', () => {
    eq('typeof fs.realpathSync.native === "function"', result.realpathSyncNativeType, 'function');
    ok('!!fs.realpathSync.native is truthy (matches TS truthy gate)',
      result.nativeIsTruthy === true, `errs.bang=${result.errs?.bang}`);
    ok('fs.realpathSync === fs.realpathSync.native (same ref per Z5 plan §4.3)',
      result.sameRef === true, `errs.eq=${result.errs?.eq}`);
    ok('fs.realpathSync.native("/foo") returns a string',
      typeof result.resultNative === 'string',
      `actual=${JSON.stringify(result.resultNative)} errs=${JSON.stringify(result.errs)}`);
    eq('fs.realpathSync.native("/foo") === fs.realpathSync("/foo")',
      result.resultNative, result.resultPlain);
  });
}

summary('x5t realpath-native-defined');
