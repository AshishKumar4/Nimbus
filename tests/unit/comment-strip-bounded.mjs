#!/usr/bin/env bun
// comment-strip-bounded — the require walk's comment stripper must cost
// memory proportional to its input, and must keep producing exactly the
// output the rest of the walk was written against.
//
// `stripCommentsForImports` runs over every file in a program's require
// closure before REQUIRE_RE / IMPORT_RE see it. It used to build its output
// one character at a time with `out += c`, and both engines Nimbus runs on
// represent that as a rope with one node per append, ~30 bytes of live heap
// per output character. On typescript@5.7.3's 6.15 MB `lib/_tsc.js` that
// measured +174 MB (V8) / +172 MB (JSC) inside a 128 MB isolate: the session
// Durable Object was killed inside the spawn of `tsc --version`, the
// terminal WebSocket dropped with no close frame, and nothing was ever
// printed. The stripper now assembles its output from slices of the input.
//
// Two things are pinned here:
//   1. Output is byte-identical to the character-at-a-time reference on
//      every shape the scanner distinguishes, including the degenerate ones
//      (unterminated block comment, comment at end of input, `/` at end of
//      input, `*/` with no opener, CRLF, a block comment that is nothing but
//      newlines, an empty input).
//   2. Heap growth over a tsc-sized synthetic input is a small multiple of
//      that input, not thirty times it.

import assert from 'node:assert/strict';
import { stripCommentsForImports } from '../../packages/core/src/runtime/comment-strip.ts';

/**
 * The previous implementation, verbatim: the contract every caller was
 * written against. It is the oracle here, never the code under test.
 */
function referenceStrip(src) {
  let out = '';
  let i = 0;
  const N = src.length;
  while (i < N) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      out += ' ';
      i += 2;
      while (i < N && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < N) {
        if (src[i] === '\n') { out += '\n'; i++; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { i += 2; out += ' '; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ── 1a. The documented contract, stated directly ────────────────────────
const contract = [
  ['', ''],
  ['a', 'a'],
  ['/', '/'],
  ['a /', 'a /'],
  ['a // b\nc', 'a  \nc'],
  ['a // b', 'a  '],
  ['//', ' '],
  ['/*', ''],
  ['/**/', ' '],
  ['/*/', ''],
  ['a /* b */ c', 'a   c'],
  ['a /* b\nc\nd */ e', 'a \n\n  e'],
  ['a /* b\nc', 'a \n'],
  ['/*\n\n\n*/', '\n\n\n '],
  ['a */ b', 'a */ b'],
  ['a /* b // c */ d', 'a   d'],
  ['a // b /* c\nd */ e', 'a  \nd */ e'],
  ['x = 1 /* a */ / 2 // b\ny', 'x = 1   / 2  \ny'],
  // A CR before the LF is inside the line comment and goes with it.
  ['a\r\n// b\r\nc', 'a\r\n \nc'],
  ['/* a\r\nb */c', '\n c'],
  ['url = "http://x"; require("./y")', 'url = "http: '],
  ['#!/usr/bin/env node\nrequire("../lib/tsc.js")', '#!/usr/bin/env node\nrequire("../lib/tsc.js")'],
];
for (const [input, expected] of contract) {
  assert.equal(stripCommentsForImports(input), expected, `contract: ${JSON.stringify(input)}`);
  assert.equal(referenceStrip(input), expected, `oracle agrees: ${JSON.stringify(input)}`);
}

// ── 1b. Randomized differential over the scanner's own alphabet ─────────
// Every character the scanner branches on, plus filler. Short strings with
// this alphabet reach every state transition, including the ones at the
// end of input.
const alphabet = ['/', '*', '\n', '\r', 'a', ' ', '"'];
let seed = 0x9e3779b9;
function nextInt(bound) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % bound;
}
let differential = 0;
for (let length = 0; length <= 12; length++) {
  for (let trial = 0; trial < 400; trial++) {
    let input = '';
    for (let k = 0; k < length; k++) input += alphabet[nextInt(alphabet.length)];
    assert.equal(stripCommentsForImports(input), referenceStrip(input), `differential: ${JSON.stringify(input)}`);
    differential++;
  }
}

// ── 1c. A real bin shim and a bundled-CJS-shaped file, differentially ───
const realShapes = [
  '#!/usr/bin/env node\nrequire(\'../lib/tsc.js\')\n',
  [
    '/*! ****',
    'Copyright (c) Microsoft Corporation. All rights reserved.',
    '**** */',
    '',
    '"use strict";',
    '',
    '// src/compiler/corePublic.ts',
    'var version = "5.7.3";',
    'var fs = require("fs"); // needed',
    'var re = /\\/\\*[^]*?\\*\\//g; /* a regex that looks like a comment */',
    'module.exports = require("./_tsc.js");',
  ].join('\n'),
];
for (const input of realShapes) {
  assert.equal(stripCommentsForImports(input), referenceStrip(input));
}

// ── 2. Memory proportional to the input ─────────────────────────────────
// A tsc-sized file: mostly code with periodic line and block comments, so
// the output is nearly as long as the input. Under the character-at-a-time
// build this grows the heap by ~30 bytes per output character; under the
// span-sliced build by the output string plus a small array of slices.
const line = 'function f(a, b) { return a + b; } // trailing\n/* block\n */ var x = f(1, 2);\n';
const target = 6 * 1024 * 1024;
const big = line.repeat(Math.ceil(target / line.length));
assert.ok(big.length >= target);

const gc = typeof Bun !== 'undefined' ? () => Bun.gc(true) : globalThis.gc;
assert.equal(typeof gc, 'function', 'a forcing GC is required to read a stable baseline');
gc();
const heapBefore = process.memoryUsage().heapUsed;
const stripped = stripCommentsForImports(big);
// Read the result so a lazily-materialized rope would be paid for here.
const forced = stripped.charCodeAt(stripped.length - 1);
const heapPeak = process.memoryUsage().heapUsed;
gc();
assert.equal(forced, 0x0a);
assert.equal(stripped.length, referenceStrip(big).length);

const growth = heapPeak - heapBefore;
// 6× leaves room for engine slack (a flat copy of the input, the output, the
// slice array, allocator overhead) and is still an order of magnitude under
// the rope's ~30×. Measured on the fix: ~1-2×.
const bound = 6 * big.length;
assert.ok(
  growth <= bound,
  `stripping ${big.length} chars grew the heap by ${growth} bytes; bound is ${bound} `
    + `(${(growth / big.length).toFixed(1)}× input). A rope-per-character build is back.`,
);

console.log(
  `comment-strip-bounded: ${contract.length} contract cases, ${differential} differential cases, `
    + `${realShapes.length} real shapes; ${big.length}-char strip grew heap ${(growth / 1048576).toFixed(1)} MB `
    + `(${(growth / big.length).toFixed(2)}× input, bound ${bound / big.length}×)`,
);
