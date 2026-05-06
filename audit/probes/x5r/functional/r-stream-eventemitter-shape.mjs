#!/usr/bin/env bun
// X.5-R functional — `__streamMod.EventEmitter` exists and is the EE class.
//
// Real Node behaviour:
//
//   const stream = require('stream');
//   const events = require('events');
//   stream.EventEmitter === events.EventEmitter;   // true
//
// Older CJS code reads EE off the `stream` module rather than `events`.
// One canonical example is `@redis/client/dist/lib/client/cache.js:301`:
//
//   const stream_1 = require("stream");           // line 4
//   class ClientSideCacheProvider extends stream_1.EventEmitter {  // line 301
//
// At HEAD a571079, our `__streamMod` (built by streams.ts) lacks
// `.EventEmitter` — so `class … extends undefined` throws
// `Class extends value undefined is not a constructor or null`.
//
// PRE-FIX (RED): __streamMod.EventEmitter is undefined; class-extends throws.
// POST-FIX (GREEN): __streamMod.EventEmitter is the EE class; class-extends succeeds.
//
// See audit/sections/X5R-plan.md §3 + audit/probes/x5r/investigation/REPRO-NOTES.md.

import { ok, summary } from '../../w6/_tap.mjs';
import { makeFacet, makeVfs } from '../../x5c/_helpers.mjs';
import { generateShimsCode } from '../../../../src/node-shims.ts';

// Synth fixture that exercises the redis cache.js failure mode in isolation.
const fixture = {
  'home/user/app/script.js':
    "const stream = require('stream');\n" +
    "const events = require('events');\n" +
    "const out = {};\n" +
    "out.streamHasEE = (typeof stream.EventEmitter === 'function');\n" +
    "out.streamEEisEventsEE = (stream.EventEmitter === events.EventEmitter);\n" +
    "out.streamEEPrototypeOnFn = (typeof stream.EventEmitter === 'function'\n" +
    "  && typeof stream.EventEmitter.prototype === 'object'\n" +
    "  && typeof stream.EventEmitter.prototype.on === 'function');\n" +
    "// Now the redis cache.js failure mode reproduced verbatim:\n" +
    "try {\n" +
    "  class CSCP extends stream.EventEmitter {}\n" +
    "  out.classExtendsOk = true;\n" +
    "  // And confirm an instance can on/emit.\n" +
    "  const inst = new CSCP();\n" +
    "  let got = null;\n" +
    "  inst.on('ping', (v) => { got = v; });\n" +
    "  inst.emit('ping', 7);\n" +
    "  out.roundtrip = got;\n" +
    "} catch (e) {\n" +
    "  out.classExtendsOk = false;\n" +
    "  out.classExtendsErr = (e && e.message) || String(e);\n" +
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
  hardErr = (e && e.message) || String(e);
}

ok('shim scope evaluates without error', hardErr === null, hardErr);

if (result) {
  ok('require("stream").EventEmitter is a function',
    result.streamHasEE === true,
    `streamHasEE=${result.streamHasEE}`);
  ok('require("stream").EventEmitter === require("events").EventEmitter',
    result.streamEEisEventsEE === true,
    `streamEEisEventsEE=${result.streamEEisEventsEE}`);
  ok('stream.EventEmitter.prototype.on is a function',
    result.streamEEPrototypeOnFn === true,
    `streamEEPrototypeOnFn=${result.streamEEPrototypeOnFn}`);
  ok('class CSCP extends stream.EventEmitter {} succeeds (redis cache.js shape)',
    result.classExtendsOk === true,
    result.classExtendsErr || `classExtendsOk=${result.classExtendsOk}`);
  ok('on→emit roundtrip on instance of EE-extending class',
    result.roundtrip === 7,
    `roundtrip=${result.roundtrip}`);
}

summary('r-stream-eventemitter-shape');
