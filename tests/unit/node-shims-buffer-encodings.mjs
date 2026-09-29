#!/usr/bin/env bun
// The shim's Buffer encodes, decodes and writes as Node's does.
//
// es-module-lexer (Vite's import analysis) writes each module's source into
// its wasm memory as Buffer.from(memory.buffer, at, n).write(source,
// "utf16le"). The shim's write() took the encoding for an offset and wrote
// UTF-8, the lexer found no imports, and Vite rewrote none: every `virtual:`
// import (Astro's manifest) reached the SSR runner bare and failed, and
// browser code kept bare `react` imports. Every expectation below is Node's
// own answer (the host's Buffer), so the shim cannot drift from it.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const ShimBuffer = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + generateShimsCode() + '\n;return __BufferMod;',
)({}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.mjs', '/home/user');
const NodeBuffer = globalThis.Buffer;
const bytes = (b) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)];

const TEXT = 'import { a } from "virtual:x"; // é ✓ 𝄞';
const ENCODINGS = ['utf8', 'utf-8', 'utf16le', 'ucs2', 'ucs-2', 'latin1', 'binary', 'ascii', 'base64', 'base64url', 'hex'];

// ── the exact write es-module-lexer makes ───────────────────────────────
{
  const memory = new ArrayBuffer(256);
  const at = 16;
  const written = ShimBuffer.from(memory, at, 2 * TEXT.length).write(TEXT, 'utf16le');
  const units = new Uint16Array(memory, at, TEXT.length);
  assert.equal(written, 2 * TEXT.length);
  assert.equal(String.fromCharCode(...units), TEXT, 'the source lands in wasm memory as UTF-16 code units');
}

// ── from / toString / byteLength, every encoding ────────────────────────
for (const enc of ENCODINGS) {
  const input = enc.startsWith('base64') ? NodeBuffer.from(TEXT).toString(enc) : enc === 'hex' ? NodeBuffer.from(TEXT).toString('hex') : TEXT;
  assert.deepEqual(bytes(ShimBuffer.from(input, enc)), bytes(NodeBuffer.from(input, enc)), `Buffer.from(str, ${enc})`);
  assert.equal(ShimBuffer.byteLength(input, enc), NodeBuffer.byteLength(input, enc), `Buffer.byteLength(str, ${enc})`);
  const source = NodeBuffer.from(TEXT);
  assert.equal(ShimBuffer.from(bytes(source)).toString(enc), source.toString(enc), `buf.toString(${enc})`);
  assert.equal(ShimBuffer.from(bytes(source)).toString(enc, 3, 17), source.toString(enc, 3, 17), `buf.toString(${enc}, 3, 17)`);
  assert.equal(ShimBuffer.isEncoding(enc), true, `isEncoding(${enc})`);
}
for (const bad of ['utf32', '', undefined, 42]) assert.equal(ShimBuffer.isEncoding(bad), NodeBuffer.isEncoding(bad), `isEncoding(${bad})`);
assert.throws(() => ShimBuffer.from('x', 'utf32'), (e) => e.code === 'ERR_UNKNOWN_ENCODING');
assert.throws(() => ShimBuffer.from('x').toString('utf32'), (e) => e.code === 'ERR_UNKNOWN_ENCODING');

// ── Node's lenient decoders ─────────────────────────────────────────────
for (const [input, enc] of [
  ['aGVs bG8=\n', 'base64'], ['aGVsbG8-_w', 'base64'], ['aGVsbG8+/w==', 'base64url'], ['aGVsbG8=trailing', 'base64'],
  ['68656c6c6f', 'hex'], ['68656c6c6', 'hex'], ['6865zz6c', 'hex'], ['', 'hex'],
]) {
  assert.deepEqual(bytes(ShimBuffer.from(input, enc)), bytes(NodeBuffer.from(input, enc)), `Buffer.from(${JSON.stringify(input)}, ${enc})`);
}

// ── write(): every overload, bounds, whole characters only ──────────────
const writes = [
  [TEXT], [TEXT, 'utf16le'], [TEXT, 4], [TEXT, 4, 'latin1'], [TEXT, 4, 10], [TEXT, 4, 10, 'utf16le'],
  [TEXT, 0, 11, 'utf16le'], // an odd byte budget writes whole code units only
  ['a✓b', 0, 3], // a 3-byte character that does not fit is not split
  ['𝄞𝄞', 0, 5], ['aGVsbG8=', 2, 'base64'], ['68656c6c6f', 1, 3, 'hex'], [TEXT, 60],
];
for (const args of writes) {
  const shim = ShimBuffer.alloc(64, 0x2e);
  const node = NodeBuffer.alloc(64, 0x2e);
  assert.equal(shim.write(...args), node.write(...args), `write(${JSON.stringify(args)}) count`);
  assert.deepEqual(bytes(shim), bytes(node), `write(${JSON.stringify(args)}) bytes`);
}
assert.throws(() => ShimBuffer.alloc(4).write('x', 5), (e) => e.code === 'ERR_OUT_OF_RANGE');

console.log('node-shims-buffer-encodings: ok');
