#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  decodeWriteBatchStream,
  encodeWriteBatchStream,
  W7_MAX_PATHS_PER_BATCH,
} from '../../packages/worker/src/_shared/w7-frame.ts';
import { CHUNK_SIZE } from '../../packages/worker/src/constants.ts';

const bytes = (length, seed = 0) => {
  const value = new Uint8Array(length);
  for (let index = 0; index < length; index++) value[index] = (index + seed) % 251;
  return value;
};

const inode = (path, data, isDir = false) => ({
  path,
  parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  isDir,
  size: isDir ? 0 : data.length,
  mtime: 1,
  mode: isDir ? 0o755 : 0o644,
  chunkCount: isDir || data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE),
});

const chunks = (path, data) => Array.from(
  { length: data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE) },
  (_, chunkId) => ({
    path,
    chunkId,
    data: data.slice(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE),
  }),
);

const fixture = () => {
  const one = bytes(CHUNK_SIZE, 7);
  const many = bytes(CHUNK_SIZE + 17, 19);
  return {
    payload: {
      deletePaths: ['old.txt'],
      inodes: [
        inode('dir', new Uint8Array(), true),
        inode('empty.txt', new Uint8Array()),
        inode('one.bin', one),
        inode('dir/many.bin', many),
      ],
      chunks: [...chunks('one.bin', one), ...chunks('dir/many.bin', many)],
    },
    one,
    many,
  };
};

async function collect(stream) {
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
    total += next.value.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const streamBytes = (value, fragment = value.length) => new ReadableStream({
  type: 'bytes',
  start(controller) {
    for (let offset = 0; offset < value.length; offset += fragment) {
      controller.enqueue(value.slice(offset, Math.min(value.length, offset + fragment)));
    }
    controller.close();
  },
}, { highWaterMark: 0 });

async function decodeAll(value, fragment = value.length, options) {
  const decoded = await decodeWriteBatchStream(streamBytes(value, fragment), options);
  const records = [];
  for await (const record of decoded.records) {
    records.push(record);
    if (record.type === 'file-chunk') record.retention.release();
  }
  return { decoded, records };
}

const readU32 = (value, offset) => (
  value[offset]
  | (value[offset + 1] << 8)
  | (value[offset + 2] << 16)
  | (value[offset + 3] << 24)
) >>> 0;

function frameRecords(value) {
  const result = [];
  let offset = 4;
  while (offset < value.length) {
    const tag = value[offset];
    const length = readU32(value, offset + 1);
    result.push({ tag, offset, payloadOffset: offset + 5, length });
    offset += 5 + length;
  }
  assert.equal(offset, value.length);
  return result;
}

// Mixed records round-trip even when every transport byte is fragmented.
{
  const { payload, one, many } = fixture();
  const encoded = await collect(encodeWriteBatchStream(payload));
  for (const fragment of [encoded.length, 1]) {
    const { decoded, records } = await decodeAll(encoded, fragment);
    assert.equal(decoded.mode, 'path-atomic-committed-prefix');
    assert.ok(decoded.batchId.length > 0);
    assert.deepEqual(
      records.map((record) => record.type),
      [
        'delete', 'directory',
        'file-begin', 'file-end',
        'file-begin', 'file-chunk', 'file-end',
        'file-begin', 'file-chunk', 'file-chunk', 'file-end',
        'batch-end',
      ],
    );
    const fileBytes = new Map();
    for (const record of records) {
      if (record.type !== 'file-chunk') continue;
      const current = fileBytes.get(record.path) ?? [];
      current.push(...record.data);
      fileBytes.set(record.path, current);
    }
    assert.deepEqual(new Uint8Array(fileBytes.get('one.bin')), one);
    assert.deepEqual(new Uint8Array(fileBytes.get('dir/many.bin')), many);
    const end = records.at(-1).summary;
    assert.equal(end.pathCount, 5);
    assert.equal(end.chunkCount, 3);
    assert.equal(end.byteCount, one.length + many.length);
  }
}

async function expectDecodeFailure(value, pattern) {
  await assert.rejects(async () => {
    const decoded = await decodeWriteBatchStream(streamBytes(value, 7));
    for await (const record of decoded.records) {
      if (record.type === 'file-chunk') record.retention.release();
    }
  }, pattern);
}

// Old, malformed, truncated, duplicate, and out-of-order frames fail loudly.
{
  await expectDecodeFailure(new Uint8Array([0x4e, 0x57, 0x37, 0x01]), /unsupported protocol version 1/);

  const oversizedBegin = new Uint8Array(9);
  oversizedBegin.set([0x4e, 0x57, 0x37, 0x02, 1], 0);
  oversizedBegin.set([1, 0, 1, 0], 5); // 65,537 bytes; reject before allocation/read.
  await expectDecodeFailure(oversizedBegin, /batch-begin length 65537 exceeds 65536/);

  assert.throws(() => encodeWriteBatchStream({
    deletePaths: Array.from({ length: W7_MAX_PATHS_PER_BATCH + 1 }, (_, index) => `p-${index}`),
    inodes: [],
    chunks: [],
  }), /batch exceeds 128 owned paths/);

  assert.throws(() => encodeWriteBatchStream({
    inodes: [{ ...inode('integer-bound.bin', new Uint8Array()), chunkCount: 0x1_0000_0000 }],
    chunks: [],
  }), /chunk count exceeds uint32/);

  const encoded = await collect(encodeWriteBatchStream(fixture().payload));
  await expectDecodeFailure(encoded.slice(0, -3), /stream ended|batch-end/);

  const unknown = encoded.slice();
  const unknownRecord = frameRecords(unknown).find((record) => record.tag === 2);
  unknown[unknownRecord.offset] = 99;
  await expectDecodeFailure(unknown, /unknown record tag 99/);

  const duplicatePath = encoded.slice();
  const deleteRecord = frameRecords(duplicatePath).find((record) => record.tag === 2);
  const deleteJson = new TextDecoder().decode(
    duplicatePath.subarray(deleteRecord.payloadOffset, deleteRecord.payloadOffset + deleteRecord.length),
  );
  assert.equal(deleteJson.includes('old.txt'), true);
  const replacement = new TextEncoder().encode(deleteJson.replace('old.txt', 'one.bin'));
  assert.equal(replacement.length, deleteRecord.length);
  duplicatePath.set(replacement, deleteRecord.payloadOffset);
  await expectDecodeFailure(duplicatePath, /duplicate path ownership/);

  const outOfOrder = encoded.slice();
  const chunkRecords = frameRecords(outOfOrder).filter((record) => record.tag === 5);
  const second = chunkRecords.at(-1);
  const contentIdLength = readU32(outOfOrder, second.payloadOffset);
  const chunkIdOffset = second.payloadOffset + 4 + contentIdLength;
  outOfOrder.fill(0, chunkIdOffset, chunkIdOffset + 4);
  await expectDecodeFailure(outOfOrder, /expected chunk 1, got 0/);

  const badEnd = encoded.slice();
  const fileEnd = frameRecords(badEnd).find((record) => record.tag === 6);
  const endJson = new TextDecoder().decode(
    badEnd.subarray(fileEnd.payloadOffset, fileEnd.payloadOffset + fileEnd.length),
  );
  const badJson = new TextEncoder().encode(endJson.replace('"chunkCount":0', '"chunkCount":1'));
  assert.equal(badJson.length, fileEnd.length);
  badEnd.set(badJson, fileEnd.payloadOffset);
  await expectDecodeFailure(badEnd, /file-end chunk count mismatch/);
}

// Decoder acquires credit after the chunk header and before pulling its data.
{
  const data = bytes(17, 3);
  const encoded = await collect(encodeWriteBatchStream({
    inodes: [inode('credit.bin', data)],
    chunks: chunks('credit.bin', data),
  }));
  const chunkRecord = frameRecords(encoded).find((record) => record.tag === 5);
  const idLength = readU32(encoded, chunkRecord.payloadOffset);
  const dataOffset = chunkRecord.payloadOffset + 4 + idLength + 8;
  let retained = false;
  let segment = 0;
  const split = [encoded.slice(0, dataOffset), encoded.slice(dataOffset)];
  const stream = new ReadableStream({
    type: 'bytes',
    pull(controller) {
      if (segment === 1) assert.equal(retained, true, 'chunk data pulled before credit');
      if (segment >= split.length) return controller.close();
      controller.enqueue(split[segment++]);
    },
  }, { highWaterMark: 0 });
  const decoded = await decodeWriteBatchStream(stream, {
    async retainChunk(length) {
      assert.equal(length, data.length);
      retained = true;
      return { bytes: length, release() {} };
    },
  });
  for await (const record of decoded.records) {
    if (record.type === 'file-chunk') record.retention.release();
  }
  assert.equal(retained, true);
}

console.log('W7 v2 incremental protocol: ok');
