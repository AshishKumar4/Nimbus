#!/usr/bin/env bun
// The W7 decoder reads a stream in blocks, not one read per record field: a
// stream read is an await through the stream machinery (and across RPC, its
// pump), and a wave of small files is mostly small fields.
//
// Red before: every record cost two to five reads (envelope header, payload,
// chunk id, chunk header, data), so a 120-file wave took ~500 reads.

import assert from 'node:assert/strict';

import { decodeWriteBatchStream, encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';

const FILES = 120;
const inodes = [{ path: 'r', parentPath: '', kind: 'directory', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 }];
const chunks = [];
for (let index = 0; index < FILES; index++) {
  const data = new TextEncoder().encode(`file ${index} `.repeat(1 + (index % 40)));
  inodes.push({ path: `r/f${index}`, parentPath: 'r', kind: 'file', isDir: false, size: data.byteLength, mtime: 1, mode: 0o644, chunkCount: 1 });
  chunks.push({ path: `r/f${index}`, chunkId: 0, data });
}
// Encoding transfers each chunk's buffer, so the total is taken first.
const expectedBytes = chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
// The wire bytes, then served to the decoder as a byte stream that counts
// the reads it is asked for.
const wire = new Uint8Array(await new Response(encodeWriteBatchStream({ inodes, chunks })).arrayBuffer());
let reads = 0;
let offset = 0;
const stream = new ReadableStream({
  type: 'bytes',
  pull(controller) {
    reads++;
    const request = controller.byobRequest;
    if (offset >= wire.byteLength) {
      controller.close();
      request?.respond(0);
      return;
    }
    if (request) {
      const length = Math.min(request.view.byteLength, wire.byteLength - offset);
      new Uint8Array(request.view.buffer, request.view.byteOffset, length).set(wire.subarray(offset, offset + length));
      offset += length;
      request.respond(length);
    } else {
      controller.enqueue(wire.slice(offset));
      offset = wire.byteLength;
    }
  },
});

const decoded = await decodeWriteBatchStream(stream);
let files = 0;
let bytes = 0;
for await (const record of decoded.records) {
  if (record.type === 'file-chunk') {
    bytes += record.data.byteLength;
    record.retention.release();
  }
  if (record.type === 'file-end') files++;
}
assert.equal(files, FILES);
assert.equal(bytes, expectedBytes);
const blocks = Math.ceil(wire.byteLength / (64 * 1024));
assert.ok(reads <= blocks + 4,
  `${reads} stream reads decoded a ${wire.byteLength}-byte wave of ${FILES} files (${blocks} blocks)`);

console.log(`w7 decode read-ahead: ok (${reads} reads for ${wire.byteLength} bytes)`);

// ── No encoder or decoder made per record ───────────────────────────────
// A small file is three records; measuring a name's bytes, or decoding a
// record's text, made a TextEncoder or TextDecoder for each (red before: 3+
// encoders per file decoded).
{
  const payloadOf = () => {
    const inodes = [{ path: 'r', parentPath: '', kind: 'directory', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 }];
    const chunks = [];
    for (let index = 0; index < 120; index++) {
      const data = new Uint8Array(2_000).fill(index);
      inodes.push({ path: `r/f${index}`, parentPath: 'r', kind: 'file', isDir: false, size: data.byteLength, mtime: 1, mode: 0o644, chunkCount: 1 });
      chunks.push({ path: `r/f${index}`, chunkId: 0, data });
    }
    return { inodes, chunks };
  };
  const bytes = new Uint8Array(await new Response(encodeWriteBatchStream(payloadOf())).arrayBuffer());
  const RealEncoder = globalThis.TextEncoder;
  const RealDecoder = globalThis.TextDecoder;
  let made = 0;
  globalThis.TextEncoder = class extends RealEncoder { constructor(...args) { super(...args); made++; } };
  globalThis.TextDecoder = class extends RealDecoder { constructor(...args) { super(...args); made++; } };
  try {
    const decoded = await decodeWriteBatchStream(new ReadableStream({
      type: 'bytes',
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }));
    for await (const record of decoded.records) if (record.type === 'file-chunk') record.retention.release();
  } finally {
    globalThis.TextEncoder = RealEncoder;
    globalThis.TextDecoder = RealDecoder;
  }
  assert.ok(made <= 2, `decoding a 120-file wave made ${made} text encoders and decoders`);
  console.log('w7 decode makes no encoder per record: ok');
}
