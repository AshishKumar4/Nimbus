#!/usr/bin/env bun
// CRC-32, the one implementation W7 framing and zip archives share: known
// values, piecewise chaining, and the same answer whether node:zlib serves the
// call or the JavaScript tables do.

import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { crc32 } from '../../packages/platform/src/crc32.ts';

const text = (value) => new TextEncoder().encode(value);
const bytes = (length) => {
  const value = new Uint8Array(length);
  for (let index = 0; index < length; index++) value[index] = (index * 2_654_435_761) >>> 24;
  return value;
};

// Without node:zlib (a browser, workerd without nodejs_compat) every length
// takes the table path. A fresh module instance, loaded with the builtin gone.
const getBuiltinModule = process.getBuiltinModule;
process.getBuiltinModule = undefined;
const { crc32: tableCrc32 } = await import('../../packages/platform/src/crc32.ts?no-native');
process.getBuiltinModule = getBuiltinModule;

for (const [name, implementation] of [['host', crc32], ['tables', tableCrc32]]) {
  // Published check values.
  assert.equal(implementation(new Uint8Array()), 0, name);
  assert.equal(implementation(text('123456789')), 0xcbf4_3926, name);
  assert.equal(implementation(text('The quick brown fox jumps over the lazy dog')), 0x414f_a339, name);
  assert.equal(implementation(new Uint8Array(32)), 0x190a_55ad, name);
  assert.equal(implementation(new Uint8Array(32).fill(0xff)), 0xff6c_ab0b, name);

  // Every length around the 8-byte stride and the native threshold, against
  // node:zlib, whole and split at every eighth point.
  for (let length = 0; length <= 300; length++) {
    const value = bytes(length);
    const whole = implementation(value);
    assert.equal(whole, zlibCrc32(value), `${name}: length ${length}`);
    for (let split = 0; split <= length; split += 8) {
      const chained = implementation(value.subarray(split), implementation(value.subarray(0, split)));
      assert.equal(chained, whole, `${name}: length ${length} split at ${split}`);
    }
  }

  // A view into a larger buffer covers only its own bytes.
  const backing = bytes(4096);
  assert.equal(implementation(backing.subarray(13, 3001)), zlibCrc32(backing.subarray(13, 3001)), name);
}

console.log('crc32: all assertions passed');
