#!/usr/bin/env bun
// X.5-R functional regression — EE-shim mixin lazy-init still works.
//
// X.5-Z5-build (`audit/sections/X5Z5-build-retro.md` §2.1) added
// `(this._e ??= {})` lazy-init to every EE-prototype method that
// reads/writes `this._e`. This is what made fastify already-green at
// HEAD a571079 (avvio's `Plugin.once('start', cb)` route). We assert
// here that X.5-R's stream.EventEmitter addition does NOT regress this
// shim.
//
// Always GREEN. Same fixture as
// audit/probes/x5z5-build/functional/e-events-shim-lazy-init.mjs but
// scoped to the X.5-R suite for Phase E run-all coverage.

import { ok, summary } from '../../w6/_tap.mjs';
import { makeFacet, makeVfs } from '../../x5c/_helpers.mjs';
import { generateShimsCode } from '../../../../src/node-shims.ts';

const fixture = {
  'home/user/app/script.js':
    "const EE = require('events').EventEmitter;\n" +
    "const out = {};\n" +
    "// Mixin-copy EE.prototype methods onto a plain function (express shape)\n" +
    "const app = function () {};\n" +
    "for (const k of Object.getOwnPropertyNames(EE.prototype)) {\n" +
    "  if (k === 'constructor') continue;\n" +
    "  Object.defineProperty(app, k,\n" +
    "    Object.getOwnPropertyDescriptor(EE.prototype, k));\n" +
    "}\n" +
    "let got = null;\n" +
    "try {\n" +
    "  app.on('roundtrip', (v) => { got = v; });\n" +
    "  app.emit('roundtrip', 99);\n" +
    "  out.roundtrip = got;\n" +
    "} catch (e) {\n" +
    "  out.err = (e && e.message) || String(e);\n" +
    "}\n" +
    "// And the same for `once`\n" +
    "let onceGot = null;\n" +
    "try {\n" +
    "  app.once('once-rt', (v) => { onceGot = v; });\n" +
    "  app.emit('once-rt', 1);\n" +
    "  app.emit('once-rt', 2);\n" +
    "  out.onceGot = onceGot;\n" +
    "  out.onceCount = app.listenerCount('once-rt');\n" +
    "} catch (e) {\n" +
    "  out.onceErr = (e && e.message) || String(e);\n" +
    "}\n" +
    "module.exports = out;\n",
};
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
  hardErr = (e && e.message) || String(e);
}

ok('shim scope evaluates without error', hardErr === null, hardErr);
if (result) {
  ok('mixin app.on→app.emit roundtrip works',
    result.roundtrip === 99,
    result.err || `roundtrip=${result.roundtrip}`);
  ok('mixin app.once fires on first emit, not on second',
    result.onceGot === 1 && result.onceCount === 0,
    result.onceErr || `onceGot=${result.onceGot} onceCount=${result.onceCount}`);
}

summary('r-ee-lazy-init-still-works');
