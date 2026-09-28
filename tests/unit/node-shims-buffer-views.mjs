#!/usr/bin/env bun
// Buffer views produced by the generated shim must still BE Buffers.
//
// The shim installs Buffer's methods as own properties on each instance, so a
// view that is not re-wrapped comes back as a bare Uint8Array — whose
// toString() is the comma-joined byte list, not the decoded text. That made
// `buf.subarray(0, n).toString()` silently return "104,101,108,108,111" for
// every consumer that slices a Buffer and stringifies it.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const factory = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + generateShimsCode() + '\n;return __BufferMod;',
);
const Buffer = factory(
  {},
  {},
  {},
  null,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user',
  [],
  {},
  '/home/user/main.mjs',
  '/home/user',
);

const buf = Buffer.from('hello world');

// The regression: a subarray decodes as text, not as a list of byte numbers.
assert.equal(buf.subarray(0, 5).toString(), 'hello');
assert.equal(buf.subarray(6).toString(), 'world');
assert.equal(buf.subarray(6).toString('hex'), '776f726c64');
assert.ok(Buffer.isBuffer(buf.subarray(0, 5)), 'subarray returns a Buffer');

// Buffer#slice is documented as an alias of subarray: same view, same memory.
assert.equal(buf.slice(0, 5).toString(), 'hello');
assert.ok(Buffer.isBuffer(buf.slice(0, 5)), 'slice returns a Buffer');

// A view is a window on the same memory, not a copy, and stays a Buffer
// through a chain of views.
const view = buf.subarray(6);
view[0] = 'W'.charCodeAt(0);
assert.equal(buf.toString(), 'hello World');
assert.equal(view.subarray(0, 1).toString(), 'W');

// Reading a slice of binary content is the case that corrupted silently.
const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
assert.equal(bytes.subarray(2).toString('hex'), 'beef');
assert.equal(bytes.subarray(0, 2).toJSON().data.join(','), '222,173');

// The methods that slice internally must not be disturbed by the override.
assert.equal(Buffer.concat([buf.subarray(0, 5), Buffer.from('!')]).toString(), 'hello!');
const target = Buffer.alloc(5);
buf.copy(target, 0, 6, 11);
assert.equal(target.toString(), 'World');

// Buffer.from(arrayBuffer, byteOffset, length) is a bounded view on the same
// memory — how napi-wasm returns every result buffer from a wasm memory. The
// bounds were ignored and the whole ArrayBuffer came back.
{
  const memory = new ArrayBuffer(64);
  new Uint8Array(memory).set([0x63, 0x73, 0x73, 0x21], 8);
  const result = Buffer.from(memory, 8, 3);
  assert.equal(result.length, 3);
  assert.equal(result.byteOffset, 8);
  assert.equal(result.toString(), 'css');
  new Uint8Array(memory)[8] = 0x43;
  assert.equal(result.toString(), 'Css', 'the view shares the memory');
  assert.equal(Buffer.from(memory, 60).length, 4, 'length defaults to the rest of the buffer');
  assert.throws(() => Buffer.from(memory, 65), RangeError);
  assert.throws(() => Buffer.from(memory, 60, 5), RangeError);
}

console.log('ok - node-shims-buffer-views');
