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
import { bytes, filePayload } from './lib/staged-import.mjs';

function instrumentPulledBytes(stream, onPulled) {
  const reader = stream.getReader();
  let pulled = 0;
  return new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      pulled += next.value.byteLength;
      onPulled(pulled);
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

// The producer cannot run more than one transaction's blob bound ahead of the
// first commit, plus what transport batches on the way: the encoder's one
// coalesced pull and the decoder's one read-ahead block.
const TRANSPORT_SLACK_BYTES = 256 * 1024 + 64 * 1024 + 4 * 1024;
{
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const data = bytes(MAX_TX_BLOB_BYTES * 3, 11);
  const startTransactions = harness.transactionCount;
  let checked = false;
  const stream = instrumentPulledBytes(
    encodeWriteBatchStream(filePayload('boundary.bin', data)),
    (pulled) => {
      if (pulled > MAX_TX_BLOB_BYTES + TRANSPORT_SLACK_BYTES && !checked) {
        checked = true;
        assert.ok(
          harness.transactionCount >= startTransactions + 1,
          `producer pulled ${pulled} bytes before the staging commit`,
        );
      }
    },
  );
  const result = await vfs.writeStream(stream);
  assert.equal(result.ok, true);
  assert.equal(checked, true, 'the stream never ran past one transaction of bytes');
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
    encodeWriteBatchStream(filePayload(entry.path, entry.data)),
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
    await collect(encodeWriteBatchStream(filePayload('atomic.bin', replacement))),
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

// Aborting after the first pull that carries file data stops further pulls,
// cancels the upstream producer, leaves the incomplete path unpublished, and
// releases the decoded record plus bucket credits. (The encoder coalesces a
// pull's records, so its first pull already carries the first chunks.)
{
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const abort = new AbortController();
  const source = encodeWriteBatchStream(filePayload(
    'cancelled.bin',
    bytes(MAX_TX_BLOB_BYTES * 2 + CHUNK_SIZE, 41),
  ));
  const reader = source.getReader();
  let cancelled = false;
  let pulls = 0;
  let pullsAtAbort = 0;
  const stream = new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      pulls++;
      if (pulls === 1) {
        abort.abort('unit cancellation');
        pullsAtAbort = pulls;
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
  assert.ok(pulls <= pullsAtAbort + 1, `producer continued after cancellation (${pulls} pulls)`);
  assert.equal(vfs.exists('cancelled.bin'), false);
  const stats = rawVfs.getStats().sql;
  assert.equal(stats.creditRetainedBytes.current, 0);
  assert.equal(stats.creditRetainedBytes.queued, 0);
  assert.equal(stats.retainedWriteBytes.current, 0);
  assert.equal(stats.stagedBytes.current, 0);
}

console.log('sqlite-vfs Stage 4 backpressure: ok');
