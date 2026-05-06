#!/usr/bin/env bun
// X.5-R functional regression — `__streamMod.prototype` invariant intact.
//
// X.5-Z5-build (`audit/sections/X5Z5-build-retro.md` §2.1 / §3) planted
// a non-enumerable `prototype` descriptor on `__streamMod` that points
// at `__streamMod.Readable.prototype`. This was Z5's Defect-A fix —
// `readable-stream@2`'s `_stream_writable.js:96` does
// `Object.create(stream.prototype, …)` and would otherwise throw.
//
// X.5-R adds `__streamMod.EventEmitter`. We assert here that the EE
// addition does NOT clobber the `.prototype` plant.
//
// Always GREEN.  Guard against future regressions.

import { ok, summary } from '../../w6/_tap.mjs';
import { makeFacet, makeVfs } from '../../x5c/_helpers.mjs';
import { generateShimsCode } from '../../../../src/node-shims.ts';

const fixture = {
  'home/user/app/script.js':
    "const stream = require('stream');\n" +
    "const out = {};\n" +
    "// `prototype` is non-enumerable but readable\n" +
    "out.hasPrototype = (typeof stream.prototype === 'object' && stream.prototype !== null);\n" +
    "out.prototypeIsReadablePrototype = (stream.prototype === stream.Readable.prototype);\n" +
    "// Re-do Z5 Defect-A's actual workload: Object.create(stream.prototype, ...)\n" +
    "try {\n" +
    "  const child = Object.create(stream.prototype, { ctor: { value: function () {} } });\n" +
    "  out.objectCreateOk = true;\n" +
    "  out.childInheritsOn = (typeof child.on === 'function');\n" +
    "} catch (e) {\n" +
    "  out.objectCreateOk = false;\n" +
    "  out.objectCreateErr = (e && e.message) || String(e);\n" +
    "}\n" +
    "// Descriptor must remain non-enumerable (cosmetic but Z5 specified it)\n" +
    "const desc = Object.getOwnPropertyDescriptor(stream, 'prototype');\n" +
    "out.prototypeDescNonEnumerable = (desc && desc.enumerable === false);\n" +
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
  ok('stream.prototype exists and is an object',
    result.hasPrototype === true, `hasPrototype=${result.hasPrototype}`);
  ok('stream.prototype === stream.Readable.prototype (Z5 Defect-A invariant)',
    result.prototypeIsReadablePrototype === true,
    `prototypeIsReadablePrototype=${result.prototypeIsReadablePrototype}`);
  ok('Object.create(stream.prototype, ...) succeeds (Z5 Defect-A workload)',
    result.objectCreateOk === true, result.objectCreateErr);
  ok('child object inherits .on through stream.prototype chain',
    result.childInheritsOn === true,
    `childInheritsOn=${result.childInheritsOn}`);
  ok('stream.prototype descriptor remains non-enumerable',
    result.prototypeDescNonEnumerable === true,
    `prototypeDescNonEnumerable=${result.prototypeDescNonEnumerable}`);
}

summary('r-stream-prototype-still-pointed');
