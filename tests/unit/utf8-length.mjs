#!/usr/bin/env bun
// utf8Length counts exactly the bytes TextEncoder writes, without writing them.

import assert from 'node:assert/strict';
import { utf8Length } from '../../packages/platform/src/utf8.ts';

const encoder = new TextEncoder();
const fixed = [
  '', 'a', 'home/user/repo/src/index.ts', 'é', '€', '😀', 'a😀b', '\u07ff', '\u0800', '\uffff',
  '\ud800', '\udc00', '\udc00\ud800', '\ud800x', 'x\udbff', '\ud83d\ude00\ud83d', '\u0000', 'naïve/日本語/файл',
];
for (const text of fixed) assert.equal(utf8Length(text), encoder.encode(text).byteLength, JSON.stringify(text));

// Random strings over every class: ASCII, 2- and 3-byte units, valid pairs, lone surrogates.
let seed = 0x9e3779b9;
const next = () => (seed = (seed * 1_103_515_245 + 12_345) >>> 0);
for (let round = 0; round < 20_000; round++) {
  const units = [];
  const length = next() % 24;
  for (let index = 0; index < length; index++) {
    switch (next() % 6) {
      case 0: units.push(next() % 0x80); break;
      case 1: units.push(0x80 + (next() % 0x780)); break;
      case 2: units.push(0x800 + (next() % 0xd000)); break;
      case 3: units.push(0xd800 + (next() % 0x400), 0xdc00 + (next() % 0x400)); break;
      case 4: units.push(0xd800 + (next() % 0x800)); break;
      default: units.push(0xe000 + (next() % 0x2000)); break;
    }
  }
  const text = String.fromCharCode(...units);
  assert.equal(utf8Length(text), encoder.encode(text).byteLength, JSON.stringify(units));
}
console.log('utf8 length: ok');
