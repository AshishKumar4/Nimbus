#!/usr/bin/env bun
// X.5-Z5 functional — minimal node:v8 stub to unblock jiti.
//
// Discovered post-Z5 §3 fix during tailwindcss-vite e2e: jiti
// (jiti/dist/jiti.cjs) does `tt = require("node:v8")` and uses
// `tt.startupSnapshot.isBuildingSnapshot()`. The shim has no `v8`
// builtin → throws "Cannot find module 'node:v8'".
//
// Fix architecture: minimal shim with `startupSnapshot.isBuildingSnapshot()`
// returning false (we are NEVER building a v8 snapshot in workerd) plus
// a few inert-callable getters for forward compatibility.
//
// Scope: this is the SAME class as Z5 plan §3 (require enabler for
// tailwindcss-vite). Documented in audit/sections/X5Z5-build-retro.md §3
// as a Z5 §3 follow-on.

import { ok, summary } from '../../w6/_tap.mjs';
import { makeFacet, makeVfs } from '../../x5c/_helpers.mjs';
import { generateShimsCode } from '../../../../src/node-shims.ts';

const fixture = {
  'home/user/app/script.js':
    "let v8a = null, v8b = null, errs = {};\n" +
    "try { v8a = require('v8'); } catch (e) { errs.bareV8 = e.message || String(e); }\n" +
    "try { v8b = require('node:v8'); } catch (e) { errs.nodeV8 = e.message || String(e); }\n" +
    "let isBuilding = null;\n" +
    "try { isBuilding = (v8b || v8a).startupSnapshot.isBuildingSnapshot(); }\n" +
    "catch (e) { errs.snapshotErr = e.message || String(e); }\n" +
  "module.exports = {\n" +
  "  v8aType: typeof v8a, v8bType: typeof v8b,\n" +
  "  v8aIsNull: v8a === null, v8bIsNull: v8b === null,\n" +
  "  hasStartupSnapshot: !!(v8b && v8b.startupSnapshot),\n" +
  "  isBuilding, errs,\n" +
  "};\n",
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
  ok('require("v8") returns a non-null object',
    result.v8aType === 'object' && result.v8aIsNull === false,
    `errs.bareV8: ${result.errs?.bareV8}`);
  ok('require("node:v8") returns a non-null object',
    result.v8bType === 'object' && result.v8bIsNull === false,
    `errs.nodeV8: ${result.errs?.nodeV8}`);
  ok('v8.startupSnapshot is present', result.hasStartupSnapshot === true);
  ok('v8.startupSnapshot.isBuildingSnapshot() returns false (workerd never builds snapshots)',
    result.isBuilding === false, result.errs?.snapshotErr);
}

summary('v-v8-shim-stub');
