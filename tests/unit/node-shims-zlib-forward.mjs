#!/usr/bin/env bun
// Behavior test: require('zlib') inside a facet resolves to workerd's native
// node:zlib when the facet template's real-import block materialised, and to
// an honest CompressionStream fallback otherwise.
//
// Production failure this guards against: every *Sync call exited 1 with
// "use async gzip()" because the hand-rolled shim only wrapped
// CompressionStream, which is async by nature — while workerd's nodejs_compat
// ships a complete synchronous zlib at the production compat date. The native
// module also returns its own Buffer instances, which carry no __isBuffer
// marker, so results must be re-wrapped as Nimbus Buffers or every
// Buffer.isBuffer()/toString() caller downstream breaks.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const realZlib = await import('node:zlib');

function shimScope(extraParams) {
  const factory = new Function(
    '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest', '__supervisor',
    'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', ...extraParams.map((p) => p.name),
    '"use strict";' + generateShimsCode() + '\n;return { zlib: builtins.zlib, Buffer: __BufferMod, stream: __streamMod };',
  );
  return factory(
    {}, {}, {}, {}, {}, null,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
    ...extraParams.map((p) => p.value),
  );
}

// ── forward branch: the facet scope had the static import block ──────────────
{
  const { zlib, Buffer, stream } = shimScope([{ name: '__real_zlib', value: realZlib }]);

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

  // Constants and lookup tables pass through untouched.
  assert.equal(zlib.constants.Z_FINISH, 4);
  assert.equal(zlib.constants, realZlib.constants, 'constants is the native table');
  assert.equal(zlib.codes?.Z_FINISH, realZlib.codes?.Z_FINISH);

  // ESM interop shape: .default points back at the module itself.
  assert.equal(zlib.default, zlib);
}

// ── fallback branch: no real-import block in scope (opencode runner) ─────────
{
  const { zlib, Buffer } = shimScope([{ name: '__real_zlib', value: undefined }]);

  // Sync stays impossible without a native primitive, but the refusal must be
  // actionable: name the function and point at the async replacement.
  for (const name of ['gzipSync', 'gunzipSync', 'deflateSync', 'inflateSync']) {
    try {
      zlib[name]();
      assert.fail(`${name} must refuse`);
    } catch (e) {
      assert.match(e.message, new RegExp(name), 'refusal names the function');
      assert.match(e.message, /async/, 'refusal names the async replacement');
    }
  }

  // Async forms keep working over CompressionStream, including deflate-raw.
  const packed = await new Promise((resolve, reject) => {
    zlib.gzip('fb-hi', (err, res) => err ? reject(err) : resolve(res));
  });
  const unpacked = await new Promise((resolve, reject) => {
    zlib.gunzip(packed, (err, res) => err ? reject(err) : resolve(res));
  });
  assert.equal(unpacked.toString(), 'fb-hi');

  const rawPacked = await new Promise((resolve, reject) => {
    zlib.deflateRaw('raw-hi', (err, res) => err ? reject(err) : resolve(res));
  });
  const rawUnpacked = await new Promise((resolve, reject) => {
    zlib.inflateRaw(rawPacked, (err, res) => err ? reject(err) : resolve(res));
  });
  assert.equal(rawUnpacked.toString(), 'raw-hi');

  // Unzip honors Node's contract: gzip AND zlib-wrapped deflate inputs both
  // decompress. Hard-coding gzip made `deflate -> unzip` report a data error.
  const unzipOnce = (data) => new Promise((resolve, reject) => {
    zlib.unzip(data, (err, res) => err ? reject(err) : resolve(res));
  });
  assert.equal(
    (await unzipOnce(realZlib.gzipSync(Buffer.from('uz-gzip')))).toString(),
    'uz-gzip',
    'unzip decompresses gzip input',
  );
  assert.equal(
    (await unzipOnce(realZlib.deflateSync(Buffer.from('uz-zlib')))).toString(),
    'uz-zlib',
    'unzip auto-detects zlib-wrapped deflate',
  );
  await new Promise((resolve) => {
    zlib.unzip(Buffer.from([0x00, 0x01, 0x02]), (err) => {
      assert.ok(err instanceof Error, 'corrupt unzip input still errors honestly');
      resolve();
    });
  });

  // Stream factories keep ONE codec for the Transform lifetime: writes buffer
  // until end() and the whole payload is processed at flush. A fresh one-shot
  // codec per write treated a split payload as a complete stream and rejected
  // on the first fragment — these half-at-a-time runs are that regression.
  const pumpFactory = (factory, writes) => new Promise((resolve, reject) => {
    const chunks = [];
    const t = factory();
    t.on('data', (c) => chunks.push(c));
    t.on('end', () => resolve(Buffer.concat(chunks)));
    t.on('error', reject);
    for (const w of writes) t.write(w);
    t.end();
  });
  const halves = (bytes) => [bytes.subarray(0, Math.floor(bytes.length / 2)), bytes.subarray(Math.floor(bytes.length / 2))];

  const splitGz = realZlib.gzipSync(Buffer.from('split-across-writes'));
  assert.equal(
    (await pumpFactory(zlib.createGunzip, halves(splitGz))).toString(),
    'split-across-writes',
    'createGunzip joins a payload split across writes',
  );
  const splitDef = realZlib.deflateSync(Buffer.from('inflate-split-across-writes'));
  assert.equal(
    (await pumpFactory(zlib.createInflate, halves(splitDef))).toString(),
    'inflate-split-across-writes',
    'createInflate joins a payload split across writes',
  );
  const splitRaw = realZlib.deflateRawSync(Buffer.from('raw-split-across-writes'));
  assert.equal(
    (await pumpFactory(zlib.createInflateRaw, halves(splitRaw))).toString(),
    'raw-split-across-writes',
    'createInflateRaw joins a payload split across writes',
  );
  const splitZl = realZlib.deflateSync(Buffer.from('zl-split-across-writes'));
  assert.equal(
    (await pumpFactory(zlib.createUnzip, halves(splitZl))).toString(),
    'zl-split-across-writes',
    'createUnzip sniffs zlib-deflate on buffered input',
  );
  const gzRound = await pumpFactory(zlib.createUnzip, [realZlib.gzipSync(Buffer.from('uz-factory-gz'))]);
  assert.equal(gzRound.toString(), 'uz-factory-gz', 'createUnzip accepts gzip input');

  const fromGzip = await pumpFactory(zlib.createGzip, [Buffer.from('multi-'), Buffer.from('write')]);
  assert.equal(realZlib.gunzipSync(fromGzip).toString(), 'multi-write', 'createGzip compresses one concatenated body');
  const fromDeflate = await pumpFactory(zlib.createDeflate, [Buffer.from('def-multi-'), Buffer.from('write')]);
  assert.equal(realZlib.inflateSync(fromDeflate).toString(), 'def-multi-write', 'createDeflate compresses one concatenated body');
  const fromRaw = await pumpFactory(zlib.createDeflateRaw, [Buffer.from('raw-multi-'), Buffer.from('write')]);
  assert.equal(realZlib.inflateRawSync(fromRaw).toString(), 'raw-multi-write', 'createDeflateRaw compresses one concatenated body');

  // One-byte-first sniff: createUnzip must hold the fragment until two bytes
  // decide the wrapper, then feed the prefix before streaming the rest.
  const byteSplit = realZlib.gzipSync(Buffer.from('one-byte-first'));
  const sniffRound = await pumpFactory(
    zlib.createUnzip,
    [byteSplit.subarray(0, 1), byteSplit.subarray(1)],
  );
  assert.equal(sniffRound.toString(), 'one-byte-first', 'unzip sniffs from a one-byte first chunk');

  // Early output: compressed bytes flow while the source is still open. A
  // buffer-until-end implementation has produced nothing at this point.
  {
    const gz = zlib.createGzip();
    const early = [];
    const finished = new Promise((resolve, reject) => {
      gz.on('data', (c) => early.push(c));
      gz.on('end', resolve);
      gz.on('error', reject);
    });
    await new Promise((written) => gz.write(Buffer.from('early-output-probe'), () => written()));
    await new Promise((tick) => setTimeout(tick, 0));
    assert.ok(early.length > 0, 'compressed output flows before end()');
    for (const chunk of early) {
      assert.equal(Buffer.isBuffer(chunk), true, 'fallback pump emits real Buffers');
      assert.equal(typeof chunk.toString, 'function', 'chunks behave as Buffers for consumers');
    }
    gz.end();
    await finished;
    assert.equal(
      realZlib.gunzipSync(Buffer.concat(early)).toString(),
      'early-output-probe',
      'pre-end output is already the complete valid gzip body',
    );
  }

  // Mutation after the write callback: the codec must have its own copy, or
  // a caller reusing its buffer corrupts what was already accepted.
  {
    const reusable = new TextEncoder().encode('mutation-proof-payload');
    const def = zlib.createDeflateRaw();
    const collected = [];
    const finished = new Promise((resolve, reject) => {
      def.on('data', (c) => collected.push(c));
      def.on('end', resolve);
      def.on('error', reject);
    });
    await new Promise((written) => def.write(reusable, () => written()));
    reusable.fill(0xff, 0, 4);
    def.end();
    await finished;
    assert.equal(
      realZlib.inflateRawSync(Buffer.concat(collected)).toString(),
      'mutation-proof-payload',
      'accepted chunks are independent of caller-owned buffers',
    );
  }

  // Exact empty flush: an unzip that never receives data fails through the
  // stream's error path with Node's unexpected-end decompression error —
  // no codec is invented and no silent success is possible.
  await new Promise((resolve) => {
    const emptyUnzip = zlib.createUnzip();
    emptyUnzip.on('error', (e) => {
      assert.match(e.message, /unexpected end/i);
      assert.equal(e.code, 'Z_DATA_ERROR');
      resolve();
    });
    emptyUnzip.on('end', () => {
      assert.fail('empty unzip input must not succeed');
      resolve();
    });
    emptyUnzip.end();
  });

  // Paused-consumer backpressure: enough bounded writes to exceed both the
  // web codec queue and the readable queue. While nobody drains, output
  // plateaus near the high-water mark and at least one write callback stays
  // pending instead of memory growing. Resuming drains: every callback then
  // settles and gzip round-trips byte-exactly.
  {
    const chunk = randomBytes(64 * 1024);
    const gz = zlib.createGzip();
    gz.pause();
    let settledCount = 0;
    for (let i = 0; i < 96; i++) {
      gz.write(chunk, () => { settledCount += 1; });
    }
    let plateaued = false;
    let previous = -1;
    for (let i = 0; i < 2000 && !plateaued; i++) {
      const now = gz.readableLength;
      if (now === previous && now >= gz._readableState.highWaterMark) plateaued = true;
      previous = now;
      if (!plateaued) await new Promise((tick) => setTimeout(tick, 1));
    }
    assert.ok(plateaued, 'output parks at the high-water mark while the consumer is paused');
    assert.ok(
      gz.readableLength < gz._readableState.highWaterMark + 2 * chunk.length,
      'held output stays bounded near the high-water mark',
    );
    assert.ok(
      settledCount < 96,
      'at least one write callback stays pending while paused',
    );

    const collected = [];
    gz.on('data', (c) => collected.push(c));
    // pause() set flowing=false, so on('data') does not auto-resume here.
    gz.resume();
    gz.end();
    const finished = new Promise((resolve, reject) => {
      gz.on('end', resolve);
      gz.on('error', reject);
    });
    await finished;
    assert.equal(settledCount, 96, 'every write callback settles once the consumer drains');
    const restored = realZlib.gunzipSync(Buffer.concat(collected));
    assert.equal(restored.length, 96 * chunk.length);
    for (let i = 0; i < 96; i++) {
      assert.ok(
        restored.subarray(i * chunk.length, (i + 1) * chunk.length).equals(chunk),
        'every drained byte matches the original payload',
      );
    }
  }

  // Spy scope: proxies CompressionStream/DecompressionStream writers so a
  // test can observe abort() while delegating everything to the real codec.
  function spiedScopeParams(abortCalls) {
    const spyWrap = (RealCtor) => class {
      constructor(algo) {
        const real = new RealCtor(algo);
        const writer = real.writable.getWriter();
        this.writable = {
          getWriter: () => ({
            write: (c) => writer.write(c),
            close: () => writer.close(),
            abort: (reason) => {
              abortCalls.count += 1;
              return writer.abort(reason);
            },
          }),
        };
        this.readable = real.readable;
      }
    };
    return [
      { name: '__real_zlib', value: undefined },
      { name: 'CompressionStream', value: spyWrap(CompressionStream) },
      { name: 'DecompressionStream', value: spyWrap(DecompressionStream) },
    ];
  }

  // Destroy while parked: every write settles without hanging, output stops
  // growing at its pre-destroy level, and the codec writer genuinely receives
  // abort() — a missing writer method cannot hide behind reader cancellation.
  {
    const chunk = randomBytes(64 * 1024);
    const abortCalls = { count: 0 };
    const spied = shimScope(spiedScopeParams(abortCalls));
    const gz = spied.zlib.createGzip();
    gz.pause();
    let settledCount = 0;
    for (let i = 0; i < 96; i++) {
      gz.write(chunk, () => { settledCount += 1; });
    }
    let plateaued = false;
    let previous = -1;
    for (let i = 0; i < 2000 && !plateaued; i++) {
      const now = gz.readableLength;
      if (now === previous && now >= gz._readableState.highWaterMark) plateaued = true;
      previous = now;
      if (!plateaued) await new Promise((tick) => setTimeout(tick, 1));
    }
    assert.ok(plateaued, 'pump is parked at the high-water mark before destroy');
    gz.destroy();
    const heldAtDestroy = gz.readableLength;
    for (let i = 0; i < 2000 && settledCount < 96; i++) {
      await new Promise((tick) => setTimeout(tick, 1));
    }
    assert.equal(settledCount, 96, 'every write settles or rejects after destroy — nothing hangs');
    assert.ok(abortCalls.count > 0, 'destroy reaches the codec writer as abort()');
    assert.equal(gz.readableLength, heldAtDestroy, 'no output buffers past destroy');
  }

  // Immediate destroy below the high-water mark: an in-flight read must not
  // buffer a single byte after destroy.
  {
    const abortCalls = { count: 0 };
    const spied = shimScope(spiedScopeParams(abortCalls));
    const gz = spied.zlib.createGzip();
    gz.pause();
    gz.on('error', () => {});
    let settledCount = 0;
    for (let i = 0; i < 4; i++) {
      gz.write(randomBytes(1024), () => { settledCount += 1; });
    }
    gz.destroy();
    const heldAtDestroy = gz.readableLength;
    for (let i = 0; i < 2000 && settledCount < 4; i++) {
      await new Promise((tick) => setTimeout(tick, 1));
    }
    assert.equal(settledCount, 4, 'writes settle after an immediate destroy');
    assert.ok(abortCalls.count > 0, 'unpressured destroy still reaches the codec writer');
    assert.equal(gz.readableLength, heldAtDestroy, 'no byte buffers past destroy');
  }
}

console.log('ok - node-shims-zlib-forward');
