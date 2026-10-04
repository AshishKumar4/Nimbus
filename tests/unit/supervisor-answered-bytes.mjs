#!/usr/bin/env bun
// The bytes a session hands its processes are counted once, where an answer
// leaves the session.
//
// The diag counter `supervisorAnsweredBytes` bounds what a run can hold (the
// node-runtime-code-workerd gate reads it). It was counted inside the
// dispatcher, which the session also calls itself: an fsAcquired carrying an
// fsReadBatch counted the batch's bytes when the inner read answered and
// again in the fsAcquired answer around it. And it walked every answer's
// values, a stat's and a listing's included. What has to hold, through the
// session's own supervisor surface (session/supervisor-op.ts, rpc.ts):
//
//   (1) an fsAcquired's read is counted once, as the read alone is;
//   (2) each read op counts the contents it hands over, and an answer that
//       hands none (a stat, a listing) counts nothing.

import assert from 'node:assert/strict';
import { readDiagCounters } from '../../packages/platform/src/diag-counters.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';

const { host, rawVfs, kfs } = createAuthority();
const { pid } = host.processes.spawn('node', ['main.js'], '/home/user', { cred: CRED_SESSION_USER });
const SIZE = 100_000;
kfs.writeFile('home/user/data.bin', new Uint8Array(SIZE).fill(7));
for (let i = 0; i < 50; i++) kfs.writeFile(`home/user/entry-with-a-long-name-${i}.txt`, 'x');

/** What answering `envelope` added to the counter. */
async function counted(envelope) {
  const before = readDiagCounters().supervisorAnsweredBytes;
  await host.supervisorOp({ pid, ...envelope });
  return readDiagCounters().supervisorAnsweredBytes - before;
}
const batch = [[{ path: '/home/user/data.bin', offset: 0, length: SIZE }]];
const acquire = () => ({ epoch: rawVfs.epoch, cursor: rawVfs.revision() });

// ── (1) an fsAcquired's read is counted once ───────────────────────────────
const alone = await counted({ op: 'fsReadBatch', args: batch });
const carried = await counted({ op: 'fsAcquired', args: [acquire(), 'fsReadBatch', batch] });
assert.equal(carried, alone, '(1) a read carried by fsAcquired counts what it does alone, not again in the answer around it');
assert.equal(alone, SIZE, 'a batch read counts the bytes it hands over');

// ── (2) contents are counted, and only contents ────────────────────────────
assert.equal(await counted({ op: 'readFileBytes', args: ['/home/user/data.bin'] }), SIZE);
assert.equal(await counted({ op: 'fsReadRange', args: ['/home/user/data.bin', 10, 1000] }), 1000);
assert.equal(await counted({ op: 'readFile', args: ['/home/user/entry-with-a-long-name-0.txt'] }), 1);
assert.equal(await counted({ op: 'fsAcquired', args: [acquire(), 'stat', ['/home/user/data.bin']] }), 0, '(2) a stat hands no contents');
assert.equal(await counted({ op: 'readdir', args: ['/home/user'] }), 0, '(2) nor does a listing');

console.log('ok - supervisor-answered-bytes (an fsAcquired read counted once; contents only)');
