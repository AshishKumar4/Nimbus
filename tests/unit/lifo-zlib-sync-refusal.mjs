#!/usr/bin/env bun
// Behavior test: the Lifo node-compat `require('zlib')` Sync surface refuses
// honestly on runtimes without a synchronous compress primitive.
//
// The refusal is a contract, not a placeholder: it must name the function,
// say sync compression is unavailable, and spell out the async replacement —
// that is what a script's error handler can act on. deflateRawSync /
// inflateRawSync / unzipSync must exist as named refusals rather than being
// absent exports (a bare `zlib.deflateRawSync()` TypeError tells the user
// nothing).

import assert from 'node:assert/strict';
import { createModuleMap } from '../../packages/core/src/substrate/lifo/node-compat/index.ts';

const moduleMap = createModuleMap({
  vfs: null,
  cwd: '/',
  env: {},
  stdout: { write() {} },
  stderr: { write() {} },
  argv: [],
  filename: '/x.js',
  dirname: '/',
});

const zlib = moduleMap.zlib();

const refusals = [
  ['gzipSync', 'gzip'],
  ['gunzipSync', 'gunzip'],
  ['deflateSync', 'deflate'],
  ['inflateSync', 'inflate'],
  ['deflateRawSync', 'deflateRaw'],
  ['inflateRawSync', 'inflateRaw'],
  ['unzipSync', 'unzip'],
];

for (const [name, asyncName] of refusals) {
  assert.equal(typeof zlib[name], 'function', `${name} exists as a named export`);
  try {
    zlib[name]();
    assert.fail(`${name} must refuse`);
  } catch (e) {
    assert.match(e.message, new RegExp(`zlib\\.${name}`), 'refusal names the function');
    assert.match(e.message, /synchronous compression is not available/, 'refusal states why');
    assert.match(e.message, new RegExp(`zlib\\.${asyncName}\\(data, callback\\)`), 'refusal names the async replacement');
    assert.equal(e.code, 'ERR_ZLIB_SYNC_UNAVAILABLE');
  }
}

// The async forms stay functional over CompressionStream.
const packed = await new Promise((resolve, reject) => {
  zlib.gzip('lifo-hi', (err, res) => err ? reject(err) : resolve(res));
});
const unpacked = await new Promise((resolve, reject) => {
  zlib.gunzip(packed, (err, res) => err ? reject(err) : resolve(res));
});
assert.equal(unpacked.toString(), 'lifo-hi');

// unzip sniffs its wrapper like node's: gzip magic means gunzip, anything
// else is zlib-wrapped deflate. Hard-coding gzip broke `deflate -> unzip`.
const unzipOnce = (data) => new Promise((resolve, reject) => {
  zlib.unzip(data, (err, res) => err ? reject(err) : resolve(res));
});
const asGzip = await new Promise((resolve, reject) => {
  zlib.gzip('core-unzip-gzip', (err, res) => err ? reject(err) : resolve(res));
});
assert.equal((await unzipOnce(asGzip)).toString(), 'core-unzip-gzip');
const asZlibDeflate = await new Promise((resolve, reject) => {
  zlib.deflate('core-unzip-zlib', (err, res) => err ? reject(err) : resolve(res));
});
assert.equal((await unzipOnce(asZlibDeflate)).toString(), 'core-unzip-zlib');

console.log('ok - lifo-zlib-sync-refusal');
