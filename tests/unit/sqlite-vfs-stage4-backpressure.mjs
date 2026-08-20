#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  CHUNK_SIZE,
  MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES,
  MAX_TX_BLOB_BYTES,
} from '../../packages/platform/src/limits.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const bytes = (length, seed = 0) => {
  const data = new Uint8Array(length);
  for (let index = 0; index < length; index++) data[index] = (index + seed) % 251;
  return data;
};

const payload = (path, data) => ({
  inodes: [{
    path,
    parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    isDir: false,
    size: data.length,
    mtime: 1,
    mode: 0o644,
    chunkCount: data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE),
  }],
  chunks: Array.from(
    { length: data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE) },
    (_, chunkId) => ({
      path,
      chunkId,
      data: data.slice(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE),
    }),
  ),
});

function instrumentChunkPulls(stream, onChunkData) {
  const reader = stream.getReader();
  return new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      if (next.value.byteLength === CHUNK_SIZE) onChunkData();
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

// The decoder cannot pull the 17th full chunk until the first 1 MiB bucket
// has committed synchronously and returned its credit.
{
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const data = bytes(MAX_TX_BLOB_BYTES + CHUNK_SIZE, 11);
  const startTransactions = harness.transactionCount;
  let chunkPulls = 0;
  const stream = instrumentChunkPulls(
    encodeWriteBatchStream(payload('boundary.bin', data)),
    () => {
      chunkPulls++;
      if (chunkPulls === 17) {
        assert.ok(
          harness.transactionCount >= startTransactions + 1,
          'producer pulled beyond 1 MiB before the staging commit',
        );
      }
    },
  );
  const result = await vfs.writeStream(stream);
  assert.equal(result.ok, true);
  assert.equal(chunkPulls, 17);
  assert.deepEqual(vfs.readFile('boundary.bin'), data);
  const stats = rawVfs.getStats().sql;
  assert.ok(stats.creditRetainedBytes.peak <= MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES);
  assert.equal(stats.creditRetainedBytes.current, 0);
  assert.equal(stats.retainedWriteBytes.current, 0);
  assert.equal(stats.stagedBytes.current, 0);
}

// Eight simultaneous streams share one 8 MiB pool, complete without partial-
// credit deadlock, and reconstruct exact file contents.
{
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const entries = Array.from({ length: 8 }, (_, index) => ({
    path: `concurrent-${index}.bin`,
    data: bytes(MAX_TX_BLOB_BYTES * 2 + index + 1, index * 13),
  }));
  const writes = entries.map((entry) => vfs.writeStream(
    encodeWriteBatchStream(payload(entry.path, entry.data)),
  ));
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('write-stream credit deadlock')), 5_000);
  });
  const results = await Promise.race([Promise.all(writes), deadline]);
  clearTimeout(timeout);
  assert.ok(results.every((result) => result.ok));
  for (const entry of entries) assert.deepEqual(vfs.readFile(entry.path), entry.data);
  const stats = rawVfs.getStats().sql;
  assert.ok(stats.creditRetainedBytes.peak <= MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES);
  assert.equal(stats.creditRetainedBytes.current, 0);
  assert.equal(stats.retainedWriteBytes.current, 0);
  assert.equal(stats.stagedBytes.current, 0);
}

async function collect(stream) {
  const parts = [];
  let total = 0;
  for await (const part of stream) {
    parts.push(part);
    total += part.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function corruptFileEndCheck(frame) {
  const output = frame.slice();
  let offset = 4;
  while (offset < output.length) {
    const length = (
      output[offset + 1]
      | (output[offset + 2] << 8)
      | (output[offset + 3] << 16)
      | (output[offset + 4] << 24)
    ) >>> 0;
    if (output[offset] === 6) {
      const start = offset + 5;
      const json = new TextDecoder().decode(output.subarray(start, start + length));
      const corrupted = json.replace(/"check":(\d)/, (_, digit) => `"check":${digit === '1' ? '2' : '1'}`);
      assert.equal(corrupted.length, json.length);
      output.set(new TextEncoder().encode(corrupted), start);
      return output;
    }
    offset += 5 + length;
  }
  throw new Error('file-end record not found');
}

// A malformed file-end never publishes its already-staged chunks; the old
// complete generation remains visible and every in-memory credit is released.
{
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const oldData = bytes(31, 2);
  const replacement = bytes(MAX_TX_BLOB_BYTES + 7, 29);
  vfs.writeFile('atomic.bin', oldData);
  const malformed = corruptFileEndCheck(
    await collect(encodeWriteBatchStream(payload('atomic.bin', replacement))),
  );
  const stream = new ReadableStream({
    type: 'bytes',
    start(controller) {
      controller.enqueue(malformed);
      controller.close();
    },
  });
  const result = await vfs.writeStream(stream);
  assert.equal(result.ok, false);
  assert.equal(result.error.phase, 'decode');
  assert.match(result.error.message, /file-end check mismatch/);
  assert.deepEqual(vfs.readFile('atomic.bin'), oldData);
  const stats = rawVfs.getStats().sql;
  assert.equal(stats.creditRetainedBytes.current, 0);
  assert.equal(stats.retainedWriteBytes.current, 0);
  assert.equal(stats.stagedBytes.current, 0);
}

// Aborting after the first credited chunk stops further pulls, cancels the
// upstream producer, leaves the incomplete path unpublished, and releases the
// decoded record plus bucket credits.
{
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const abort = new AbortController();
  const source = encodeWriteBatchStream(payload(
    'cancelled.bin',
    bytes(MAX_TX_BLOB_BYTES + CHUNK_SIZE, 41),
  ));
  const reader = source.getReader();
  let cancelled = false;
  let dataChunksPulled = 0;
  const stream = new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      if (next.value.byteLength === CHUNK_SIZE) {
        dataChunksPulled++;
        if (dataChunksPulled === 1) abort.abort('unit cancellation');
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });

  const result = await vfs.writeStream(stream, { signal: abort.signal });
  assert.equal(result.ok, false);
  assert.equal(result.error.phase, 'decode');
  assert.match(result.error.message, /unit cancellation/);
  assert.equal(cancelled, true, 'decoder cancellation did not reach the producer');
  assert.equal(dataChunksPulled, 1, 'producer continued after cancellation');
  assert.equal(vfs.exists('cancelled.bin'), false);
  const stats = rawVfs.getStats().sql;
  assert.equal(stats.creditRetainedBytes.current, 0);
  assert.equal(stats.creditRetainedBytes.queued, 0);
  assert.equal(stats.retainedWriteBytes.current, 0);
  assert.equal(stats.stagedBytes.current, 0);
}

console.log('sqlite-vfs Stage 4 backpressure: ok');
