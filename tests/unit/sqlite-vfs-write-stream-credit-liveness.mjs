#!/usr/bin/env bun
// A write stream never waits for credit while holding credit it could give
// back. When the session's allocation budget is busy (a large owner holds or
// awaits it), a stream's chunk retentions fall to the small-request reserve
// (1 MiB). Before: a stream waited there while its own unflushed group and
// its own in-progress file held the reserve, so no release could ever reach
// it, and it stayed parked after the large owner left. Live, a clone's wave
// stopped ~1 MB into its stream for as long as anyone watched (GitPackStream:
// 3 of 10 next.js clones).

import assert from 'node:assert/strict';

import { CHUNK_SIZE, SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES } from '../../packages/platform/src/limits.ts';
import { acquireSupervisorAllocation, readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);

const random = (size, seed) => {
  const data = new Uint8Array(size);
  let state = seed;
  for (let index = 0; index < size; index++) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    data[index] = state >>> 24;
  }
  return data;
};

// Two concurrent streams, each a few small files (a group it has not yet
// committed) and then a file it holds whole until its end: each fits the
// 1 MiB reserve alone, together they do not.
function wave(prefix, seed) {
  const files = [];
  for (let index = 0; index < 4; index++) files.push({ path: `${prefix}/small-${index}`, data: random(60_000, seed + index) });
  files.push({ path: `${prefix}/whole.bin`, data: random(700_000, seed + 99) });
  const inodes = [{ path: prefix, parentPath: '', kind: 'directory', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 }];
  const chunks = [];
  for (const file of files) {
    const chunkCount = Math.ceil(file.data.byteLength / CHUNK_SIZE);
    inodes.push({ path: file.path, parentPath: prefix, kind: 'file', isDir: false, size: file.data.byteLength, mtime: 1, mode: 0o644, chunkCount });
    for (let chunkId = 0; chunkId < chunkCount; chunkId++) {
      chunks.push({ path: file.path, chunkId, data: file.data.slice(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE) });
    }
  }
  return { files, payload: { inodes, chunks } };
}
const waves = [wave('a', 1), wave('b', 1_000)];

// A large owner holds the whole shared budget, and leaves shortly.
const owner = await acquireSupervisorAllocation(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES);
let ownerLeft = false;
setTimeout(() => { owner.release(); ownerLeft = true; }, 100);

const written = Promise.all(waves.map((entry) => vfs.writeStream(encodeWriteBatchStream(entry.payload))));
const outcome = await Promise.race([
  written.then((results) => ({ results })),
  new Promise((resolve) => setTimeout(() => resolve({ stalled: true }), 5_000)),
]);
assert.ok(!outcome.stalled,
  `the streams stalled holding ${readSupervisorAllocationBudget().current} bytes of budget ` +
  `(the large owner ${ownerLeft ? 'had left' : 'still held it'})`);
for (const result of outcome.results) assert.equal(result.ok, true, result.error?.message);
for (const entry of waves) for (const file of entry.files) assert.deepEqual(vfs.readFile(file.path), file.data, file.path);
if (!ownerLeft) await new Promise((resolve) => setTimeout(resolve, 150));
assert.equal(readSupervisorAllocationBudget().current, 0);

console.log('sqlite vfs write stream credit liveness: ok');
process.exit(0);
