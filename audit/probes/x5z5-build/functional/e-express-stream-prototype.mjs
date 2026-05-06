#!/usr/bin/env bun
// X.5-Z5 functional — Defect A: __streamMod (the object returned by
// generateStreamsCode at src/streams.ts:380-386) must expose a `.prototype`
// such that `Object.create(__streamMod.prototype, ...)` does NOT throw.
//
// This is the express blocker per X5Z5-plan.md §1.1: readable-stream@2's
// _stream_writable.js calls util.inherits(Writable, Stream) where Stream
// is `require('stream')` → our __streamMod. When .prototype is undefined,
// Object.create throws the verbatim runtime message
// "Object prototype may only be an Object or null: undefined".
//
// PRE-FIX: red.  POST-FIX: green.
//
// We materialise the actual generateShimsCode output in a `new Function`
// scope (mirroring `makeFacet` from audit/probes/x5c/_helpers.mjs). The
// shim string is the source of truth — same string the runtime worker
// evaluates at facet startup.

import { ok, summary } from '../../w6/_tap.mjs';
import { makeFacet, makeVfs } from '../../x5c/_helpers.mjs';
import { generateShimsCode } from '../../../../src/node-shims.ts';

// We don't need a VFS payload — just the shim scope. But makeFacet expects
// bundle/dirs. Smoke-test fixture: a single CJS file that pokes
// __streamMod from outside via a hidden assertion script. Easier: we
// expose __streamMod via a probe script in the fixture bundle.
const fixture = {
  // Minimal user app entry. The script reaches into the shim's
  // __streamMod via a global the harness exposes (see modified harness
  // below). Simpler approach: assert at the facet seam — run a tiny
  // user script that calls `require('stream')` and inspects its shape.
  'home/user/app/script.js':
    "const stream = require('stream');\n" +
    "module.exports = {\n" +
    "  hasReadable: typeof stream.Readable === 'function',\n" +
    "  hasWritable: typeof stream.Writable === 'function',\n" +
    "  prototype: stream.prototype === undefined ? 'undefined' : (stream.prototype === null ? 'null' : 'present'),\n" +
    "  // Exact reproduction of the readable-stream@2 _stream_writable.js:96 line:\n" +
    "  //   util.inherits(Writable, Stream)\n" +
    "  // util.inherits(c, s) does Object.create(s.prototype, ...)\n" +
    "  inheritsThrows: (function() {\n" +
    "    try {\n" +
    "      function FakeWritable() {}\n" +
    "      Object.create(stream.prototype, { constructor: { value: FakeWritable } });\n" +
    "      return null; // success\n" +
    "    } catch (e) { return e && e.message ? e.message : String(e); }\n" +
    "  })(),\n" +
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
  ok('require("stream").Readable is a function', result.hasReadable === true);
  ok('require("stream").Writable is a function', result.hasWritable === true);

  // PRIMARY assertion: __streamMod (== require('stream')) must have .prototype
  // defined so Object.create(stream.prototype, ...) doesn't throw the
  // verbatim runtime message.
  ok('require("stream").prototype is defined (Defect-A fixed)',
    result.prototype === 'present',
    `actual: ${result.prototype}`);

  // PRIMARY assertion 2: util.inherits-shaped Object.create call does not throw.
  // Pre-fix: throws "Object prototype may only be an Object or null: undefined"
  // Post-fix: returns null (no throw).
  ok('Object.create(require("stream").prototype, ...) does NOT throw (express unblocker)',
    result.inheritsThrows === null,
    result.inheritsThrows);
}

summary('e-express-stream-prototype');
