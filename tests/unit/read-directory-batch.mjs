import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { readDirectoryBatch } from '../../packages/core/src/runtime/read-directory-batch.ts';
import { DIRECTORY_PREFETCH_LIMIT } from '../../packages/core/src/constants.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const files = new ProcessFiles(engine);
const fs = files.bind({ pid: 1, cred: CRED_KERNEL });
const root = '/home/user/directories';
await fs.mkdir(root, { recursive: true });
for (let i = 0; i < 90; i++) await fs.mkdir(`${root}/d${i}`);
const channel = crypto.randomUUID();
let sequence = 0;
const request = (open = [], options = {}) => ({ channel, sequence: ++sequence, epoch: engine.epoch, cursor: engine.revision(), open, retire: [], claim: [], lease: false, ...options });
try {
  const first = await readDirectoryBatch(fs, request([`${root}/d0`, `${root}/d1`]));
  assert.equal(first.opened.length, 2);
  const [a, unused] = first.opened;
  assert.equal((await fs.fstat(a.handle.id)).ino, a.ino, 'issued IDs belong to the real descriptor scope');
  const second = await readDirectoryBatch(files.bind({ pid: 1, cred: CRED_KERNEL }), request([`${root}/d2`], { claim: [a.handle.id] }));
  await assert.rejects(async () => fs.fstat(unused.handle.id), { code: 'EBADF' }, 'the next batch disposes unclaimed prefetch');
  await fs.rename(`${root}/d0`, `${root}/renamed`);
  assert.equal((await fs.fstat(a.handle.id)).ino, a.ino, 'claimed descriptors retain inode identity across rename');
  await fs.rmdir(`${root}/renamed`);
  assert.equal((await fs.fstat(a.handle.id)).nlink, 0, 'an unlinked guest-owned description stays live');
  const retired = [a.handle.id, second.opened[0].handle.id];
  await readDirectoryBatch(fs, request([], { retire: retired }));
  await readDirectoryBatch(fs, request([], { retire: retired }));
  for (const id of retired) await assert.rejects(async () => fs.fstat(id), { code: 'EBADF' });

  // Every issued descriptor, even a claimed one, conservatively consumes
  // the prefetch budget until its real close. Batches cannot evade it.
  const held = [];
  for (let i = 0; i < DIRECTORY_PREFETCH_LIMIT; i += 16) {
    const result = await readDirectoryBatch(fs, request(Array.from({ length: 16 }, (_, at) => `${root}/d${i + at + 3}`), { claim: held }));
    held.push(...result.opened.map((entry) => entry.handle.id));
  }
  const full = await readDirectoryBatch(fs, request([`${root}/d89`], { claim: held }));
  assert.equal(full.opened.length, 0, 'capacity allows only retirement/acknowledgement, not more speculative opens');
  assert.equal(full.outstanding, DIRECTORY_PREFETCH_LIMIT);
  await readDirectoryBatch(fs, request([], { retire: held }));
  assert.equal((await readDirectoryBatch(fs, request([`${root}/d89`]))).opened.length, 1);

  const lostChannel = crypto.randomUUID();
  await readDirectoryBatch(fs, { ...request(), channel: lostChannel, sequence: 2 });
  await assert.rejects(() => readDirectoryBatch(fs, { ...request([`${root}/d88`]), channel: lostChannel, sequence: 1 }), { code: 'ESTALE' }, 'a late abandoned first request cannot allocate after id-free recovery');

  // Rewinding creates another descriptor scope: an old channel must not
  // retire numbers the new run might already have reused.
  await files.rewindProcess(1);
  const fresh = files.bind({ pid: 1, cred: CRED_KERNEL });
  const live = await fresh.open(`${root}/d1`, { read: true, directory: true });
  await assert.rejects(() => readDirectoryBatch(fresh, request([], { retire: [live.id] })), { code: 'ESTALE' });
  assert.equal((await fresh.fstat(live.id)).type, 'directory');
} finally {
  await files.releaseProcess(1);
  harness.db.close();
}
console.log('read-directory-batch: scope identity, bounded ownership, abandoned replies and idempotent retirement');
