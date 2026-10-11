#!/usr/bin/env bun
// Behavior test: require('zlib') inside a facet resolves to the platform's
// native node:zlib (the shims' one native provider; here the host's).
//
// Production failure this guards against: every *Sync call exited 1 with
// "use async gzip()" because the hand-rolled shim only wrapped
// CompressionStream, which is async by nature — while workerd's nodejs_compat
// ships a complete synchronous zlib at the production compat date. The native
// module also returns its own Buffer instances, which carry no __isBuffer
// marker, so results must be re-wrapped as Nimbus Buffers or every
// Buffer.isBuffer()/toString() caller downstream breaks.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const realZlib = await import('node:zlib');

function shimScope() {
  const factory = new Function(
    '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + generateShimsCode() + '\n;return { zlib: builtins.zlib, Buffer: __BufferMod, stream: __streamMod };',
  );
  return factory(
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
}

{
  const { zlib, Buffer, stream } = shimScope();

  // Every sync variant round-trips through genuine compression. Results are
  // the host realm's own Buffers, and the shim isBuffer must recognize that
  // brand (the marker alone rejects them).
  const pairs = [
    ['gzipSync', 'gunzipSync'],
    ['deflateSync', 'inflateSync'],
    ['deflateRawSync', 'inflateRawSync'],
    ['gzipSync', 'unzipSync'],
    ['brotliCompressSync', 'brotliDecompressSync'],
  ];
  for (const [compress, decompress] of pairs) {
    const packed = zlib[compress](Buffer.from('hi'));
    assert.ok(Buffer.isBuffer(packed) === true, `${compress} result is recognized as a Buffer`);
    assert.equal(
      zlib[decompress](packed).toString(),
      'hi',
      `${compress}/${decompress} round-trips`,
    );
  }

  // Input forms Node accepts: string and plain Uint8Array.
  assert.ok(Buffer.isBuffer(zlib.gzipSync('hi')), 'string input accepted');
  const bytes = new TextEncoder().encode('hi');
  assert.equal(zlib.inflateSync(zlib.deflateSync(bytes)).toString(), 'hi', 'plain Uint8Array input accepted');

  // Callback form keeps Node's (err, result) contract.
  await new Promise((resolve, reject) => {
    zlib.gzip('cb-hello', (err, res) => {
      if (err) return reject(err);
      try {
        assert.ok(Buffer.isBuffer(res) === true, 'callback gzip result is recognized as a Buffer');
        zlib.gunzip(res, (err2, back) => {
          if (err2) return reject(err2);
          try {
            assert.equal(back.toString(), 'cb-hello');
            resolve();
          } catch (e) { reject(e); }
        });
      } catch (e) { reject(e); }
    });
  });

  // Error path surfaces an error in the callback, not a thrown exception.
  await new Promise((resolve, reject) => {
    zlib.gunzip(Buffer.from([0x00, 0x01, 0x02]), (err) => {
      try {
        assert.ok(err instanceof Error, 'corrupt input reaches the callback as an error');
        resolve();
      } catch (e) { reject(e); }
    });
  });
  // promises namespace forwards when the native module provides it
  // (Node >= 11 ships it; bun 1.4 and workerd omit it today) — and stays
  // gracefully absent otherwise.
  if (realZlib.promises) {
    const promised = await zlib.promises.gzip('promised-hi');
    assert.ok(Buffer.isBuffer(promised) === true, 'promises.gzip result is recognized as a Buffer');
    assert.equal((await zlib.promises.gunzip(promised)).toString(), 'promised-hi');
  } else {
    assert.equal(zlib.promises, undefined, 'promises stays absent when the native module omits it');
  }

  // Streaming factories are forwarded (real streams): multi-chunk data piped
  // through createGzip -> createGunzip survives as one continuous stream,
  // with the Nimbus Readable/Writable shims on either side.
  const dataChunks = [];
  await new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    gunzip.on('data', (c) => dataChunks.push(c));
    gunzip.on('end', resolve);
    gunzip.on('error', reject);
    const src = new stream.Readable({
      read() {
        this.push(Buffer.from('chunk-one '));
        this.push(Buffer.from('chunk-two'));
        this.push(null);
      },
    });
    src.on('error', reject);
    src.pipe(zlib.createGzip()).pipe(gunzip);
  });
  assert.equal(dataChunks.map((c) => c.toString()).join(''), 'chunk-one chunk-two',
    'createGzip/createGunzip stream round-trip across chunks');

  // The direct regression: chunks emitted by a forwarded native stream are
  // the host realm's own Buffer instances with no __isBuffer marker. The
  // shim isBuffer must recognize them (it used to return undefined here),
  // or every `stream.on('data', c => Buffer.isBuffer(c))` consumer breaks.
  assert.ok(dataChunks.length > 0, 'data events carried the decompressed chunks');
  for (const c of dataChunks) {
    assert.equal(Buffer.isBuffer(c), true, 'raw data-event chunk is recognized as a Buffer');
  }
  // The widened check keeps its boundaries: plain Uint8Arrays and non-bytes
  // are still rejected, always as a real boolean.
  assert.equal(Buffer.isBuffer(new Uint8Array(4)), false);
  assert.equal(Buffer.isBuffer({}), false);
  assert.equal(Buffer.isBuffer(undefined), false);

  // Native values with Node's public names and property descriptors.
  assert.equal(zlib.constants.Z_FINISH, 4);
  assert.equal(Object.getPrototypeOf(zlib.constants), null);
  assert.deepEqual(Object.keys(zlib.constants).sort(), Object.keys(realZlib.constants).filter((name) => name !== 'ZSTD_ENCODE' && name !== 'ZSTD_DECODE').sort());
  for (const [name, value] of Object.entries(zlib.constants)) {
    assert.equal(value, realZlib.constants[name]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(zlib.constants, name), { value, enumerable: true, configurable: false, writable: false });
  }
  assert.equal(zlib.codes, realZlib.codes, 'status-code lookup remains the native table');
  assert.equal(Object.hasOwn(zlib, 'default'), false, 'the CommonJS module has no default export');
}

console.log('ok - node-shims-zlib-forward');
