#!/usr/bin/env bun
// X.5-Z5 functional — EventEmitter shim methods lazy-init `_e`.
//
// Discovered post-Z5 §1 fix during e2e: express `createApplication`
// (express/lib/express.js:36-42) creates `app` as a plain function and
// then does `mixin(app, EventEmitter.prototype, false)` (merge-descriptors).
// The mixin copies `on, emit, off, removeAllListeners, ...` methods to
// `app` — but the EE constructor `this._e = {}` never runs on `app`. So
// `app.on('mount', fn)` evaluates `(this._e[n] = this._e[n] || [])`
// where `this._e` is undefined → throws
// "undefined is not an object (evaluating 'this._e[n]')".
//
// This is a separate root cause from Z5 §1's documented Defect-A and
// Defect-B; both of those unblock the IDENTIFICATION of `app` as a
// callable object. The EE-shim mixin path was a previously-MASKED bug:
// pre-Z5, express never reached the createApplication line because of
// the readable-stream@2 / send/index.js Defect-A failure earlier in
// the require chain.
//
// Fix architecture: every EE-shim method that reads/writes this._e
// must lazy-init it. ~7 lines, all in the EE class body.
//
// PRE-FIX: red — `app.on(...)` throws on a mixed-in EE prototype.
// POST-FIX: green — lazy init makes mixin-copy patterns work.

import { ok, summary } from '../../w6/_tap.mjs';
import { makeFacet, makeVfs } from '../../x5c/_helpers.mjs';
import { generateShimsCode } from '../../../../src/runtime/node-shims.ts';

const fixture = {
  'home/user/app/script.js':
    "const EE = require('events').EventEmitter;\n" +
    "const out = {};\n" +
    "// Reproduce express createApplication shape exactly:\n" +
    "// app is a plain function; EE.prototype methods are mixin-copied.\n" +
    "const app = function() {};\n" +
    "// Manual mixin — copy all enumerable own props of EE.prototype.\n" +
    "for (const k of Object.getOwnPropertyNames(EE.prototype)) {\n" +
    "  if (k === 'constructor') continue;\n" +
    "  Object.defineProperty(app, k,\n" +
    "    Object.getOwnPropertyDescriptor(EE.prototype, k));\n" +
    "}\n" +
    "// Now exercise each of the methods that touch _e.\n" +
    "try { app.on('a', () => {}); out.onOk = true; }\n" +
    "catch (e) { out.onErr = e.message || String(e); }\n" +
    "try { app.emit('a'); out.emitOk = true; }\n" +
    "catch (e) { out.emitErr = e.message || String(e); }\n" +
    "try { app.off('a', () => {}); out.offOk = true; }\n" +
    "catch (e) { out.offErr = e.message || String(e); }\n" +
    "try { app.removeAllListeners(); out.removeAllOk = true; }\n" +
    "catch (e) { out.removeAllErr = e.message || String(e); }\n" +
    "try { out.listenerCount = app.listenerCount('a'); }\n" +
    "catch (e) { out.listenerCountErr = e.message || String(e); }\n" +
    "// Verify on+emit roundtrip after lazy init.\n" +
    "let got = null;\n" +
    "try {\n" +
    "  app.on('roundtrip', (v) => { got = v; });\n" +
    "  app.emit('roundtrip', 42);\n" +
    "  out.roundtrip = got;\n" +
    "} catch (e) { out.roundtripErr = e.message || String(e); }\n" +
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
  ok('app.on() (mixin-copied) does not throw', result.onOk === true, result.onErr);
  ok('app.emit() (mixin-copied) does not throw', result.emitOk === true, result.emitErr);
  ok('app.off() (mixin-copied) does not throw', result.offOk === true, result.offErr);
  ok('app.removeAllListeners() (mixin-copied) does not throw',
    result.removeAllOk === true, result.removeAllErr);
  ok('app.listenerCount() (mixin-copied) returns a number',
    typeof result.listenerCount === 'number', result.listenerCountErr);
  // Roundtrip semantics: after lazy init, on→emit must call the listener.
  ok('app.on("roundtrip", fn) + app.emit("roundtrip", 42) → fn receives 42',
    result.roundtrip === 42, result.roundtripErr || `got=${result.roundtrip}`);
}

summary('e-events-shim-lazy-init');
