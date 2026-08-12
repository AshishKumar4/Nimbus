#!/usr/bin/env bun
// npm-install-wave-shed-retry — a write wave that workerd SHED must be
// re-sent, not converted into a permanent package failure.
//
// Live repro: a 119-package install of @earendil-works/pi-coding-agent
// came back with 88 packages. The peer shards' `writeBatchStream` RPCs
// queue at the coordinator DO; when the input gate's queue got too deep
// workerd rejected one with `Durable Object is overloaded.` The wave had a
// single attempt, so that one shed permanently failed EVERY package that
// had contributed to the shared buffer — up to 128 paths' worth.
//
// A shed RPC never ran, so re-sending the identical wave is safe. What
// must NOT be retried is a wave the storage layer actually processed and
// rejected: identical bytes get the identical verdict, and retrying would
// only stall the install.

import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import {
  readableStreamToAsyncIterable,
  streamTarEntries,
} from '../../packages/worker/src/npm/tarball-stream.ts';
import {
  decodeWriteBatchStream,
  encodeWriteBatchStream,
} from '../../packages/core/src/_shared/w7-frame.ts';

globalThis.streamTarEntries = streamTarEntries;
globalThis.readableStreamToAsyncIterable = readableStreamToAsyncIterable;
// Workerd hands each enqueued chunk buffer to the RPC byte stream by
// transfer, so the caller's arrays are detached once the stream has been
// read. Model that here: the encoder records the payload it was given and
// `detachLastPayload()` (called by the fake RPC after it drains the
// stream) detaches exactly what a real send would have taken. Without it
// this test would pass on code that cannot actually re-send a wave.
let lastEncodedPayload = null;
globalThis.encodeWriteBatchStream = (payload) => {
  lastEncodedPayload = payload;
  return encodeWriteBatchStream(payload);
};
function detachLastPayload() {
  for (const chunk of lastEncodedPayload?.chunks ?? []) {
    const buffer = chunk.data.buffer;
    if (buffer.byteLength === 0) continue;
    structuredClone(buffer, { transfer: [buffer] });
  }
}
globalThis.__nimbusUseRpcResult = async (promise, use) => use(await promise);
globalThis.DecompressionStream = class DecompressionStream {
  readable;
  writable;

  constructor(format) {
    assert.equal(format, 'gzip');
    const transform = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(gunzipSync(chunk));
      },
    });
    this.readable = transform.readable;
    this.writable = transform.writable;
  }
};

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function tarFile(name, text) {
  const data = new TextEncoder().encode(text);
  const header = new Uint8Array(512);
  const write = (offset, value, width) => {
    header.set(new TextEncoder().encode(value).subarray(0, width), offset);
  };
  write(0, name, 100);
  write(100, octal(0o644, 8), 8);
  write(108, octal(0, 8), 8);
  write(116, octal(0, 8), 8);
  write(124, octal(data.length, 12), 12);
  write(136, octal(0, 12), 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  write(257, 'ustar\0', 6);
  write(263, '00', 2);
  write(148, octal(header.reduce((sum, byte) => sum + byte, 0), 8), 8);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [header, padded];
}

function makeTarball() {
  const parts = [
    ...tarFile('package/package.json', '{"name":"fixture","version":"1.0.0"}'),
    ...tarFile('package/index.js', 'export default 1;'),
    new Uint8Array(1024),
  ];
  const tar = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(gzipSync(tar));
}

const tarball = makeTarball();

async function decodeWave(stream) {
  const decoded = await decodeWriteBatchStream(stream);
  const paths = [];
  let chunks = 0;
  for await (const record of decoded.records) {
    if (record.type === 'directory' || record.type === 'file-begin') {
      paths.push(record.inode.path);
    } else if (record.type === 'file-chunk') {
      chunks++;
      record.retention.release();
    }
  }
  return { paths, chunks };
}

const packages = ['a', 'b', 'c'].map((name) => ({
  name,
  version: '1.0.0',
  tarballUrl: `https://unused.invalid/${name}`,
  integrity: '',
  pkgDir: `node_modules/${name}`,
  installRoot: 'node_modules',
  mtime: 1,
  chunkSize: 65_536,
}));

/** Run the batch facet against a writeBatchStream with scripted behaviour. */
async function runBatch(writeBatchStream) {
  return installPackagesInFacet({ packages, concurrency: 3 }, {
    SUPERVISOR: {
      async getCachedTarball() {
        return { bytes: tarball.slice(), events: [] };
      },
      writeBatchStream,
    },
  });
}

function okResult(decoded) {
  return {
    ok: true,
    committedGroupSequence: decoded.paths.length,
    committedPathCount: decoded.paths.length,
    inodes: decoded.paths.length,
    chunks: decoded.chunks,
  };
}

// ── Case 1: the coordinator sheds the first wave, then accepts it ────────
{
  let attempts = 0;
  const result = await runBatch(async (stream) => {
    attempts++;
    // Drain first: a shed happens after workerd has taken the bytes.
    const decoded = await decodeWave(stream);
    detachLastPayload();
    if (attempts === 1) throw new Error('Durable Object is overloaded.');
    return okResult(decoded);
  });

  assert.ok(attempts >= 2, `the shed wave must be re-sent (attempts=${attempts})`);
  for (const pkg of result.perPackage) {
    assert.equal(
      pkg.errorText,
      undefined,
      `${pkg.name} must install after the shed wave is re-sent (errorText=${pkg.errorText})`,
    );
  }
  console.log(`  case1: shed wave re-sent, all ${result.perPackage.length} packages installed`);
}

// ── Case 2: a mid-request DO reset is the same class of shed ─────────────
{
  let attempts = 0;
  const result = await runBatch(async (stream) => {
    attempts++;
    const decoded = await decodeWave(stream);
    detachLastPayload();
    if (attempts === 1) throw new Error('Durable Object reset because its code was updated.');
    return okResult(decoded);
  });

  assert.ok(result.perPackage.every((pkg) => !pkg.errorText), 'a reset wave is re-sent too');
  console.log('  case2: mid-request reset re-sent');
}

// ── Case 3: a persistent shed exhausts the budget and fails honestly ─────
{
  let attempts = 0;
  const result = await runBatch(async (stream) => {
    attempts++;
    await decodeWave(stream);
    detachLastPayload();
    throw new Error('Durable Object is overloaded.');
  });

  assert.ok(attempts >= 7, `the retry budget must be bounded and spent (attempts=${attempts})`);
  assert.ok(attempts < 40, `the retry budget must be BOUNDED (attempts=${attempts})`);
  for (const pkg of result.perPackage) {
    assert.match(
      pkg.errorText ?? '',
      /overloaded/,
      'a wave that never lands must fail the package with the platform reason',
    );
  }
  console.log(`  case3: exhausted after ${attempts} attempts and failed honestly`);
}

// ── Case 4: a storage-layer rejection is a verdict, not a shed ───────────
{
  let attempts = 0;
  const result = await runBatch(async (stream) => {
    attempts++;
    const decoded = await decodeWave(stream);
    detachLastPayload();
    return {
      ok: false,
      committedGroupSequence: 1,
      committedPathCount: decoded.paths.length,
      inodes: decoded.paths.length,
      chunks: decoded.chunks,
      error: {
        code: 'ERR_WRITE_BATCH_STREAM',
        phase: 'publish',
        message: 'injected wave failure',
      },
    };
  });

  assert.equal(attempts, 1, `a typed rejection must not be retried (attempts=${attempts})`);
  assert.ok(
    result.perPackage.every((pkg) => pkg.errorText?.includes('injected wave failure')),
    'the storage layer verdict reaches the package result unchanged',
  );
  console.log('  case4: typed rejection surfaced without retry');
}

console.log('npm-install-wave-shed-retry: all assertions passed');
