#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { processFsClient } from '../../packages/core/src/_shared/process-fs-client.ts';

if (!process.argv.includes('--child')) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
    timeout: 45_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
  });
  assert.equal(child.error, undefined, `fold waiter child: ${child.error}\n${child.stdout}\n${child.stderr}`);
  assert.equal(child.status, 0, `fold waiter child exited ${child.status} (${child.signal})\n${child.stdout}\n${child.stderr}`);
  console.log('process-fs-client-fold-waiters: ok');
} else {
  process.on('unhandledRejection', (error) => { console.error(error); process.exit(1); });
  const piece = new TextEncoder().encode('0123456789');
  const count = 200_000;
  const expected = new Uint8Array(count * piece.byteLength);
  for (let i = 0; i < count; i++) expected.set(piece, i * piece.byteLength);
  const received = new Uint8Array(expected.byteLength);
  let used = 0;
  let waves = 0;
  const client = processFsClient({ session: {
    openWriter: async () => null,
    writeBatchStream: async (stream) => {
      waves++;
      const decoded = await decodeWriteBatchStream(stream);
      let committedOps = 0;
      let chunks = 0;
      for await (const record of decoded.records) {
        if (record.type === 'file-chunk') {
          received.set(record.data, used);
          used += record.data.byteLength;
          chunks++;
          record.retention.release();
        } else if (record.type === 'file-end') committedOps++;
      }
      return { ok: true, committedGroupSequence: 0, committedPathCount: 1, committedOps, inodes: committedOps, chunks, receipts: [] };
    },
  } });
  const path = 'home/user/waiters';
  const answers = [client.submit({ type: 'call', call: { call: 'writeFile', path, mode: 0o644, data: new Uint8Array() } }, { acknowledged: true })];
  for (let i = 0; i < count; i++) answers.push(client.submit({ type: 'call', call: { call: 'appendFile', path, mode: 0o644, data: piece } }, { acknowledged: true }));
  assert.equal(client.stats().folded, count, 'the test did not create one 200k-fold entry');
  const all = Promise.all(answers);
  await client.settle();
  const resolved = await all;
  assert.equal(resolved.length, count + 1);
  assert.ok(resolved.every((answer) => answer.failed === undefined));
  assert.equal(waves, 1);
  assert.equal(used, expected.byteLength);
  assert.deepEqual(received, expected);

  const rejectedClient = processFsClient({ session: {
    openWriter: async () => null,
    writeBatchStream: async (stream) => {
      const decoded = await decodeWriteBatchStream(stream);
      for await (const record of decoded.records) if (record.type === 'file-chunk') record.retention.release();
      return { ok: false, committedGroupSequence: 0, committedPathCount: 0, committedOps: 0, inodes: 0, chunks: 0, receipts: [], error: { errno: 'EACCES', message: 'denied', phase: 'publish' } };
    },
  } });
  const rejected = [rejectedClient.submit({ type: 'call', call: { call: 'writeFile', path, mode: 0o644, data: new Uint8Array() } })];
  for (let i = 0; i < 1024; i++) rejected.push(rejectedClient.submit({ type: 'call', call: { call: 'appendFile', path, mode: 0o644, data: piece } }));
  const failures = Promise.allSettled(rejected);
  await rejectedClient.settle();
  const results = await failures;
  assert.equal(results.length, 1025);
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.code === 'EACCES'));
  console.log('fold waiter child: 200000 answers and 1025 rejections settled');
}
