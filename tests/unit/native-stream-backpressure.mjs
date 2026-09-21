#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { PipeChannel } from '../../packages/core/src/substrate/lifo/shell/pipe.ts';
import { SinkWriter, streamRange } from '../../packages/core/src/_shared/byte-stream.ts';

const bytes = Uint8Array.from({ length: 200_003 }, (_, i) => i % 251);
const pipe = new PipeChannel();
let completed = false;
const producer = Promise.resolve(pipe.writer.writeBytes(bytes)).then(() => {
  completed = true;
  pipe.close();
});
await Promise.resolve();
assert.equal(completed, false, 'producer must wait for the reader once its bounded queue fills');
let offset = 0;
for (;;) {
  const chunk = await pipe.reader.readBytes(997);
  if (chunk === null) break;
  assert.deepEqual(chunk, bytes.subarray(offset, offset + chunk.length));
  offset += chunk.length;
}
await producer;
assert.equal(offset, bytes.length);
console.log('PASS bounded pipe preserves binary bytes across partial reads');

const controller = new AbortController();
const blocked = new PipeChannel(controller.signal);
const blockedWrite = Promise.resolve(blocked.writer.writeBytes(bytes));
controller.abort();
await assert.rejects(blockedWrite, { code: 'EPIPE' });
console.log('PASS cancellation releases blocked pipe writer');

let release;
const gate = new Promise((resolve) => { release = resolve; });
let reads = 0;
let transferred = 0;
const sink = new SinkWriter({
  write() { throw new Error('binary sink must not decode'); },
  async writeBytes(chunk) {
    await gate;
    assert.deepEqual(chunk, bytes.subarray(transferred, transferred + chunk.length));
    transferred += chunk.length;
  },
});
const copying = streamRange(async (start, length) => {
  reads++;
  return bytes.subarray(start, Math.min(start + Math.min(length, 131), bytes.length));
}, sink);
await Promise.resolve();
await Promise.resolve();
assert.equal(reads, 1, 'range producer cannot outrun a pending sink write');
release();
assert.equal(await copying, bytes.length);
await sink.end();
assert.equal(transferred, bytes.length, 'short nonempty reads are not EOF');
console.log('PASS ranged copy awaits delayed sink and continues short reads');

const failure = new Error('backend write rejected');
await assert.rejects(streamRange(async () => new Uint8Array([1]), new SinkWriter({
  async write() { throw failure; },
})), (error) => error === failure);
console.log('PASS asynchronous sink rejection reaches caller');

let text = '';
const decoder = new SinkWriter({ async write(chunk) { text += chunk; } });
await decoder.write(new Uint8Array([0xc3]));
await decoder.write(new Uint8Array([0xa9, 0xff]));
await decoder.end();
assert.equal(text, 'é�');
console.log('PASS asynchronous text sink preserves decoder boundaries');
