#!/usr/bin/env bun
// X.5-Z5 functional — Defect B: util.inherits guard.
//
// Per X5Z5-plan.md §1.1 + §1.3, our `util.inherits` shim at
// src/node-shims.ts:756 has no guard against null/undefined parent or
// parent-without-prototype. Defense-in-depth: even when __streamMod has
// a synthetic .prototype (Defect-A fix), other shim namespaces with no
// .prototype could still trigger the verbatim runtime message
// "Object prototype may only be an Object or null: undefined".
//
// PRE-FIX: red — `util.inherits(X, {/* no prototype */})` throws.
// POST-FIX: green — guard returns early on null/undefined parent.prototype.
//
// We exercise the REAL `util.inherits` from the shim scope.

import { ok, summary } from '../../w6/_tap.mjs';
import { makeFacet, makeVfs } from '../../x5c/_helpers.mjs';
import { generateShimsCode } from '../../../../src/node-shims.ts';

const fixture = {
  'home/user/app/script.js':
    "const util = require('util');\n" +
    "const out = {};\n" +
    "// Case 1 — null superCtor (e.g. user passed undefined accidentally,\n" +
    "// or a shim namespace lacks .prototype after our Defect-A fix).\n" +
    "function CtorA() {}\n" +
    "try {\n" +
    "  util.inherits(CtorA, null);\n" +
    "  out.case1NoThrow = true;\n" +
    "} catch (e) {\n" +
    "  out.case1NoThrow = false;\n" +
    "  out.case1Err = e && e.message ? e.message : String(e);\n" +
    "}\n" +
    "// Case 2 — superCtor with no .prototype (plain object).\n" +
    "function CtorB() {}\n" +
    "try {\n" +
    "  util.inherits(CtorB, {});\n" +
    "  out.case2NoThrow = true;\n" +
    "} catch (e) {\n" +
    "  out.case2NoThrow = false;\n" +
    "  out.case2Err = e && e.message ? e.message : String(e);\n" +
    "}\n" +
    "// Case 3 — happy path. Real EventEmitter-shaped parent. Should still\n" +
    "// work post-guard (guard only intercepts null/undef branches).\n" +
    "function CtorC() {}\n" +
    "function Parent() {}\n" +
    "Parent.prototype = Object.create(Object.prototype);\n" +
    "Parent.prototype.parentMethod = function() { return 'p'; };\n" +
    "try {\n" +
    "  util.inherits(CtorC, Parent);\n" +
    "  out.case3NoThrow = true;\n" +
    "  // Verify the inheritance actually wired up.\n" +
    "  out.case3HasMethod = typeof CtorC.prototype.parentMethod === 'function';\n" +
    "  out.case3SuperRef  = CtorC.super_ === Parent;\n" +
    "} catch (e) {\n" +
    "  out.case3NoThrow = false;\n" +
    "  out.case3Err = e && e.message ? e.message : String(e);\n" +
    "}\n" +
    "module.exports = out;\n",
};
const vfs = makeVfs(fixture);
const dirs = {};
for (const p of Object.keys(fixture)) {
  let d = p;
  while (d.includes('/')) {
    d = d.substring(0, d.lastIndexOf('/'));
    if (d) dirs[d] = true;
  }
}

let result, hardErr = null;
try {
  const facet = makeFacet({ bundle: fixture, dirs, generateShimsCode });
  result = facet.__require('./script');
} catch (e) {
  hardErr = e && e.message ? e.message : String(e);
}

ok('shim scope evaluates without error', hardErr === null, hardErr);

if (result) {
  // PRIMARY assertion (Defect-B fix): util.inherits with null superCtor
  // does NOT throw. Without the guard, this throws
  // "Cannot read properties of null" or "...of undefined" depending on
  // engine — both fail the test.
  ok('util.inherits(C, null) does not throw (Defect-B fixed)',
    result.case1NoThrow === true,
    result.case1Err);

  ok('util.inherits(C, {}) does not throw on parent-with-no-prototype (Defect-B fixed)',
    result.case2NoThrow === true,
    result.case2Err);

  // REGRESSION assertions: the happy path must still work.
  ok('util.inherits happy-path no-throw', result.case3NoThrow === true, result.case3Err);
  ok('util.inherits happy-path wires prototype chain (regression-safe)',
    result.case3HasMethod === true);
  ok('util.inherits happy-path sets super_', result.case3SuperRef === true);
}

summary('e-express-inherits-guard');
