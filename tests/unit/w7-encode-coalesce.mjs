#!/usr/bin/env bun
// The W7 encoder hands its stream a few large chunks per wave, not one per
// record: across RPC each chunk is a pump iteration, and a wave of small
// files is mostly small records. The bytes are the same records either way.
//
// Red before: a 120-file wave was ~360 chunks (file-begin, chunk, file-end).

import assert from 'node:assert/strict';

import { decodeWriteBatchStream, encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';

const FILES = 120;
const payload = () => {
  const inodes = [{ path: 'r', parentPath: '', kind: 'directory', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 }];
  const chunks = [];
  for (let index = 0; index < FILES; index++) {
    const data = new TextEncoder().encode(`file ${index}\n`.repeat(1 + (index % 30)));
    inodes.push({ path: `r/f${index}`, parentPath: 'r', kind: 'file', isDir: false, size: data.byteLength, mtime: 1, mode: 0o644, chunkCount: 1 });
    chunks.push({ path: `r/f${index}`, chunkId: 0, data });
  }
  return { inodes, chunks };
};

const given = payload();
const reader = encodeWriteBatchStream(given).getReader();
const parts = [];
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  parts.push(value);
}
const bytes = parts.reduce((total, part) => total + part.byteLength, 0);
assert.ok(parts.length <= Math.ceil(bytes / (256 * 1024)) + 2,
  `the encoder enqueued ${parts.length} chunks for a ${bytes}-byte wave of ${FILES} files`);

// The encoder copied the caller's chunk bytes into buffers it built: none
// was transferred, so a payload can be encoded again (a writer's re-send).
assert.ok(given.chunks.every((chunk) => chunk.data.byteLength > 0 && chunk.data.buffer.byteLength > 0),
  'encoding detached a caller buffer');
const again = await decodeWriteBatchStream(encodeWriteBatchStream(given));
let againBytes = 0;
for await (const record of again.records) {
  if (record.type === 'file-chunk') {
    againBytes += record.data.byteLength;
    record.retention.release();
  }
}
assert.equal(againBytes, given.chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0),
  'the payload did not encode again whole');

// The coalesced bytes decode to the same wave.
const wire = new Uint8Array(bytes);
let offset = 0;
for (const part of parts) { wire.set(part, offset); offset += part.byteLength; }
const decoded = await decodeWriteBatchStream(new ReadableStream({
  type: 'bytes',
  start(controller) {
    controller.enqueue(wire);
    controller.close();
  },
}));
let files = 0;
for await (const record of decoded.records) {
  if (record.type === 'file-chunk') record.retention.release();
  if (record.type === 'file-end') files++;
}
assert.equal(files, FILES);

console.log(`w7 encode coalesce: ok (${parts.length} chunks for ${bytes} bytes)`);
