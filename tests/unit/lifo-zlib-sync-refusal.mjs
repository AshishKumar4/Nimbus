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
import realZlib from 'node:zlib';
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

// ── Sync refusal signature: Node-like callable shape ──────────────────────
// These used to be typed as zero-arg functions, so `gzipSync(data)` failed
// to compile even though runtime refusal is the documented behavior.
// Compiled arity proves the declared (buffer, options) parameters survived
// type stripping, and calling with real arguments still reaches the honest
// refusal instead of pretending to succeed.
for (const [name] of refusals) {
  const fn = zlib[name];
  assert.equal(fn.length, 2, `${name} declares (buffer, options)`);
  assert.throws(
    () => fn(Buffer.from('shape'), {}),
    (e) => e.code === 'ERR_ZLIB_SYNC_UNAVAILABLE',
    `${name} refuses with Node-shaped arguments`,
  );
}

// ── Input normalization: every view carries its own bytes ────────────────
const once = (fn, data) => new Promise((resolve, reject) =>
  fn(data, (err, res) => err ? reject(err) : resolve(res)));
const onceErr = (fn, data) => new Promise((resolve) => fn(data, (err) => resolve(err)));

{

  const packed = await once(zlib.gzip, 'view-core-input');
  const ab = new ArrayBuffer(packed.length);
  new Uint8Array(ab).set(packed);
  assert.equal((await once(zlib.gunzip, ab)).toString(), 'view-core-input', 'ArrayBuffer input');

  const padded = new Uint8Array(8 + packed.length);
  padded.set(packed, 8);
  assert.equal(
    (await once(zlib.gunzip, new DataView(padded.buffer, 8, packed.length))).toString(),
    'view-core-input',
    'offset DataView input',
  );

  // Element values must survive untouched: a Uint16Array over identical
  // bytes used to be re-interpreted element-wise into garbage.
  let even = null;
  let evenLabel = '';
  for (let i = 0; i < 16 && !even; i++) {
    const candidate = await once(zlib.gzip, `even-core-${i}`);
    if (candidate.length % 2 === 0) { even = candidate; evenLabel = `even-core-${i}`; }
  }
  assert.ok(even, 'fixture: even-length gzip payload found');
  const u16 = new Uint16Array(even.length / 2);
  new Uint8Array(u16.buffer).set(even);
  assert.equal((await once(zlib.gunzip, u16)).toString(), evenLabel, 'Uint16Array keeps its bytes');

  // unzip sniffs through non-Uint8Array views: the gzip magic is read as
  // bytes, so an ArrayBuffer or DataView still selects gunzip over deflate.
  assert.equal((await once(zlib.unzip, ab)).toString(), 'view-core-input', 'unzip sniffs an ArrayBuffer');
  assert.equal(
    (await once(zlib.unzip, new DataView(padded.buffer, 8, packed.length))).toString(),
    'view-core-input',
    'unzip sniffs an offset DataView',
  );
}

// ── Decompression failures carry node's own classification ───────────────
// node:zlib is the oracle for each fixture: corrupt bytes are
// Z_DATA_ERROR / -3, input that ends early is Z_BUF_ERROR / -5. Forcing one
// code for both hid a short read behind a corruption report.
{
  const oracle = (nativeFn, data, label) => {
    try {
      nativeFn(data);
      return assert.fail(`fixture ${label} must fail natively`);
    } catch (e) {
      assert.ok(typeof e.code === 'string' && typeof e.errno === 'number',
        `${label}: oracle reports a zlib classification`);
      return { code: e.code, errno: e.errno };
    }
  };
  const expectClassified = async (label, nativeFn, fn, data) => {
    const expected = oracle(nativeFn, data, label);
    const err = await onceErr(fn, data);
    assert.ok(err instanceof Error, `${label}: failure reaches the callback`);
    assert.equal(err.code, expected.code, `${label}: code matches native zlib`);
    assert.equal(err.errno, expected.errno, `${label}: errno matches native zlib`);
    if (expected.code === 'Z_BUF_ERROR') {
      assert.equal(err.message, 'unexpected end of file', `${label}: node's short-input message`);
    } else {
      assert.ok(err.message.length > 0, `${label}: engine message retained`);
    }
    assert.ok(err.cause != null, `${label}: engine failure kept as cause`);
  };

  const goodGz = await once(zlib.gzip, 'classify-core');
  const badMagic = Uint8Array.from(goodGz);
  badMagic[0] ^= 0xff;
  await expectClassified('corrupt gzip magic', (d) => realZlib.gunzipSync(d), zlib.gunzip, badMagic);
  await expectClassified('truncated gzip', (d) => realZlib.gunzipSync(d), zlib.gunzip, goodGz.subarray(0, goodGz.length - 1));
  await expectClassified('empty gunzip input', (d) => realZlib.gunzipSync(d), zlib.gunzip, new Uint8Array(0));

  // Trailer corruption decodes the whole member and fails only on the
  // checksum or length check. Node calls that bad data, so a rule keyed on
  // "the failure landed at finish" would misreport it as a short input.
  const badGzipCrc = Uint8Array.from(goodGz);
  badGzipCrc[goodGz.length - 8] ^= 0xff;
  await expectClassified('corrupt gzip crc trailer', (d) => realZlib.gunzipSync(d), zlib.gunzip, badGzipCrc);
  const badGzipLength = Uint8Array.from(goodGz);
  badGzipLength[goodGz.length - 1] ^= 0xff;
  await expectClassified('corrupt gzip length trailer', (d) => realZlib.gunzipSync(d), zlib.gunzip, badGzipLength);

  const deflated = await once(zlib.deflate, 'classify-core');
  const badHeader = Uint8Array.from(deflated);
  badHeader[1] ^= 0xff;
  await expectClassified('invalid zlib header', (d) => realZlib.inflateSync(d), zlib.inflate, badHeader);
  await expectClassified('truncated deflate', (d) => realZlib.inflateSync(d), zlib.inflate, deflated.subarray(0, deflated.length - 2));
  const badAdler = Uint8Array.from(deflated);
  badAdler[deflated.length - 1] ^= 0xff;
  await expectClassified('corrupt zlib adler trailer', (d) => realZlib.inflateSync(d), zlib.inflate, badAdler);

  await expectClassified('reserved deflate block type', (d) => realZlib.inflateRawSync(d), zlib.inflateRaw, new Uint8Array([0x07]));
  await expectClassified('garbage unzip input', (d) => realZlib.unzipSync(d), zlib.unzip, new Uint8Array([0x07, 0x07, 0x07]));
}

// ── The callback is required, and it runs exactly once ───────────────────
{
  const packed = await once(zlib.gzip, 'cb-contract');
  for (const [name, data] of [['gzip', 'x'], ['gunzip', packed], ['unzip', packed], ['deflateRaw', 'x']]) {
    assert.throws(
      () => zlib[name](data),
      (e) => e instanceof TypeError && e.code === 'ERR_INVALID_ARG_TYPE' && /"callback" argument/.test(e.message),
      `${name} without a callback throws synchronously`,
    );
    assert.throws(
      () => zlib[name](data, {}),
      (e) => e instanceof TypeError && e.code === 'ERR_INVALID_ARG_TYPE',
      `${name} with options but no callback throws synchronously`,
    );
  }

  // A callback that throws must not be re-entered with its own exception:
  // .then().catch() delivered the result and then reported a fake failure.
  const seen = [];
  const swallow = () => {};
  process.on('unhandledRejection', swallow);
  zlib.gunzip(packed, (err, res) => {
    seen.push({ err, res });
    throw new Error('callback exploded');
  });
  await new Promise((tick) => setTimeout(tick, 20));
  process.off('unhandledRejection', swallow);
  assert.equal(seen.length, 1, 'a throwing callback is invoked exactly once');
  assert.equal(seen[0].err, null, 'the single invocation is the success path');
  assert.equal(seen[0].res.toString(), 'cb-contract', 'the result was delivered before the throw');
}

console.log('ok - lifo-zlib-sync-refusal');
