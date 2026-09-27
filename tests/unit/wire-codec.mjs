#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { WireEncoder, WireDecoder } from '../../packages/core/src/_shared/wire-codec.ts';

const storage = new Uint8Array([91, 0, 255, 17, 92]);
const message = {
  nested: [null, true, 12.5, 'Ω', { body: new DataView(storage.buffer, 1, 3), absent: undefined }],
  bytes: storage.subarray(1, 3), buffer: storage.buffer,
  empty: undefined, array: [undefined, 'tail'],
};
const encoded = WireEncoder.parse(message);
assert.equal(Object.hasOwn(encoded, 'empty'), false);
assert.equal(Object.hasOwn(encoded.nested[4], 'absent'), false);
assert.deepEqual(encoded.bytes, { __nimbusWireType: 'bytes', base64: 'AP8=' });
const decoded = WireDecoder.parse(JSON.parse(JSON.stringify(encoded)));
assert.deepEqual(decoded.nested, [null, true, 12.5, 'Ω', { body: new Uint8Array([0, 255, 17]) }]);
assert.deepEqual(decoded.bytes, new Uint8Array([0, 255]));
assert.deepEqual(decoded.buffer, storage);
assert.deepEqual(decoded.array, [null, 'tail']);
for (const value of [
  { __nimbusWireType: 'bytes', base64: 7 },
  { __nimbusWireType: 'other', base64: '!' },
  { base64: 'AP8=' },
]) assert.deepEqual(WireDecoder.parse(value), value, 'tag-looking records remain ordinary records');
assert.deepEqual(WireDecoder.parse({ __nimbusWireType: 'bytes', base64: 'AP8=', extra: 'ignored' }), new Uint8Array([0, 255]));
for (const base64 of ['!', 'A', '===', 'AA!A']) assert.throws(() => WireDecoder.parse({ __nimbusWireType: 'bytes', base64 }));
for (const base64 of ['Zg', 'Zg==', 'Z g==']) assert.deepEqual(WireDecoder.parse({ __nimbusWireType: 'bytes', base64 }), new Uint8Array([102]));
assert.equal(WireEncoder.parse(undefined), undefined);
assert.equal(WireDecoder.parse(undefined), undefined);
const dictionary = JSON.parse('{"__proto__":{"polluted":true},"constructor":3,"prototype":4}');
for (const schema of [WireEncoder, WireDecoder]) {
  const value = schema.parse(dictionary);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.deepEqual(value, dictionary);
  assert.equal(value.polluted, undefined);
}
assert.deepEqual(WireDecoder.parse(Object.assign(Object.create({ __nimbusWireType: 'bytes', base64: 'AQ==' }), { keep: 1 })), { keep: 1 });
const unusualNumbers = { list: [undefined, NaN, Infinity, -Infinity], absent: undefined, nan: NaN, infinite: Infinity };
assert.equal(JSON.stringify(WireEncoder.parse(unusualNumbers)), JSON.stringify(unusualNumbers));
assert.equal(Object.prototype.polluted, undefined);
console.log('wire-codec: byte windows, nesting, undefined fields and tag/error boundaries pass');
