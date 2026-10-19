#!/usr/bin/env bun
// utf8Length counts exactly the bytes TextEncoder writes, without writing them:
// the platform's, and the resident store's on the launch's captures.

import assert from 'node:assert/strict';
import { utf8Length as platformUtf8Length } from '../../packages/platform/src/utf8.ts';
import { utf8Length as residentUtf8Length } from '../../packages/worker/src/vfs/resident/cell-cost.ts';

for (const [which, utf8Length] of [['platform', platformUtf8Length], ['resident', residentUtf8Length]]) {
  const encoder = new TextEncoder();
  const fixed = [
    '', 'a', 'home/user/repo/src/index.ts', 'é', '€', '😀', 'a😀b', '\u07ff', '\u0800', '\uffff',
    '\ud800', '\udc00', '\udc00\ud800', '\ud800x', 'x\udbff', '\ud83d\ude00\ud83d', '\u0000', 'naïve/日本語/файл',
  ];
  for (const text of fixed) assert.equal(utf8Length(text), encoder.encode(text).byteLength, `${which} ${JSON.stringify(text)}`);

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
    assert.equal(utf8Length(text), encoder.encode(text).byteLength, `${which} ${JSON.stringify(units)}`);
  }

  // Long strings, counted in slices: every class again, at lengths around the
  // first slice's end and well past it, so pairs and lone surrogates fall on
  // the boundaries; and long ASCII.
  function longText(length) {
    const units = [];
    while (units.length < length) {
      switch (next() % 6) {
        case 0: units.push(0x20 + (next() % 0x60)); break;
        case 1: units.push(0x80 + (next() % 0x780)); break;
        case 2: units.push(0x800 + (next() % 0xd000)); break;
        case 3: units.push(0xd800 + (next() % 0x400), 0xdc00 + (next() % 0x400)); break;
        case 4: units.push(0xd800 + (next() % 0x800)); break;
        default: units.push(0xe000 + (next() % 0x2000)); break;
      }
    }
    let text = '';
    for (let at = 0; at < units.length; at += 8192) text += String.fromCharCode(...units.slice(at, at + 8192));
    return text;
  }
  for (const length of [255, 256, 257, 87_381, 87_382, 131_072, 262_144, 300_001]) {
    for (let round = 0; round < 4; round++) {
      const text = longText(length);
      assert.equal(utf8Length(text), encoder.encode(text).byteLength, `${which}: a long string of ${text.length} units`);
    }
  }
  for (const tail of ['', 'é', '😀', '\ud800', '\udc00']) {
    for (const length of [256, 262_143, 262_144, 262_145, 600_000]) {
      const text = 'a'.repeat(length) + tail;
      assert.equal(utf8Length(text), encoder.encode(text).byteLength, `${which}: ${length} ASCII units then ${JSON.stringify(tail)}`);
      const wide = '€'.repeat(Math.ceil(length / 3)) + tail;
      assert.equal(utf8Length(wide), encoder.encode(wide).byteLength, `${which}: ${wide.length} three-byte units then ${JSON.stringify(tail)}`);
    }
  }
}
console.log('utf8 length: ok');
