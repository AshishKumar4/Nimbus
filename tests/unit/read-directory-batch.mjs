import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { readDirectoryBatch } from '../../packages/core/src/runtime/read-directory-batch.ts';
import { DIRECTORY_PREFETCH_LIMIT, DIRECTORY_SEQUENCE_WINDOW } from '../../packages/core/src/constants.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const files = new ProcessFiles(engine);
const fs = files.bind({ pid: 1, cred: CRED_KERNEL });
const root = '/home/user/directories';
await fs.mkdir(root, { recursive: true });
const count = DIRECTORY_PREFETCH_LIMIT + 30;
for (let i = 0; i < count; i++) await fs.mkdir(`${root}/d${i}`);
const channel = crypto.randomUUID();
// Where a request's position is taken from: a binding no rewind or release ends.
const positions = files.bind({ pid: 2, cred: CRED_KERNEL });
let sequence = 0;
const request = (open = [], options = {}) => ({ channel, sequence: ++sequence, position: positions.acquire(null).position, open, retire: [], claim: [], lease: false, ...options });
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
  const full = await readDirectoryBatch(fs, request([`${root}/d${count - 1}`], { claim: held }));
  assert.equal(full.opened.length, 0, 'capacity allows only retirement/acknowledgement, not more speculative opens');
  assert.equal(full.outstanding, DIRECTORY_PREFETCH_LIMIT);
  await readDirectoryBatch(fs, request([], { retire: held }));
  assert.equal((await readDirectoryBatch(fs, request([`${root}/d${count - 1}`]))).opened.length, 1);

  const lostChannel = crypto.randomUUID();
  await readDirectoryBatch(fs, { ...request(), channel: lostChannel, sequence: 2 });
  await assert.rejects(() => readDirectoryBatch(fs, { ...request([`${root}/d${count - 2}`]), channel: lostChannel, sequence: 1 }), { code: 'ESTALE' }, 'a late abandoned first request cannot allocate after id-free recovery');

  const originalOpen = fs.open.bind(fs);
  const issued = [];
  fs.open = async (path, ...args) => {
    if (path === `${root}/unexpected`) throw new Error('unexpected backend failure');
    const handle = await originalOpen(path, ...args);
    issued.push(handle.id);
    return handle;
  };
  try {
    await assert.rejects(() => readDirectoryBatch(fs, request([`${root}/d2`, `${root}/unexpected`])), /unexpected backend failure/);
    for (const id of issued) await assert.rejects(async () => fs.fstat(id), { code: 'EBADF' }, 'a failed partial batch closes everything it issued');
  } finally { fs.open = originalOpen; }

  await fs.mkdir(`${root}/over`);
  const mounted = new MemoryVFS(CRED_KERNEL);
  const backend = {
    stat(path, options) { const stat = mounted.stat(path, options); return stat && { ...stat, dev: engine.deviceId }; },
    readdir: mounted.readdir.bind(mounted), readFile: mounted.readFile.bind(mounted),
    writeFile: mounted.writeFile.bind(mounted), mkdir: mounted.mkdir.bind(mounted), unlink: mounted.unlink.bind(mounted),
  };
  files.vfs.mount(`${root}/over/mnt`, backend);
  for (const path of ['/', `${root}/over`, `${root}/over/mnt`]) {
    const answer = await readDirectoryBatch(fs, request([path]));
    assert.equal(answer.opened.length, 1, 'the actual required descriptor is retained');
    assert.equal(answer.opened[0].key, null, 'canonical placement excludes root, composed ancestors and mounts even with the same reported dev');
  }

  // A shell's commands share its pid and scope: each run's last exchange ends
  // its channel, so more runs than the channel bound keep their prefetch.
  for (let run = 0; run < DIRECTORY_PREFETCH_LIMIT + 5; run++) {
    const runChannel = crypto.randomUUID();
    const first = await readDirectoryBatch(fs, { ...request([`${root}/d1`, `${root}/d2`]), channel: runChannel, sequence: 1 });
    assert.equal(first.opened.length, 2, `run ${run} still prefetches`);
    await readDirectoryBatch(fs, { ...request([], { retire: [first.opened[0].handle.id] }), channel: runChannel, sequence: 2, end: true });
    for (const opened of first.opened) await assert.rejects(async () => fs.fstat(opened.handle.id), { code: 'EBADF' }, 'its end closes every description of the channel');
  }
  // A first request of a run that reaches the session after the run's end
  // (its second exchange arrived, and ended the channel, first) opens nothing.
  {
    const late = crypto.randomUUID();
    await readDirectoryBatch(fs, { ...request([]), channel: late, sequence: 2, end: true });
    await assert.rejects(() => readDirectoryBatch(fs, { ...request([`${root}/d3`]), channel: late, sequence: 1 }), { code: 'ESTALE' }, 'an ended channel is not a channel again');
    // Its last outstanding request in, the ended channel is forgotten; a request numbered past its end makes a channel again.
    const again = await readDirectoryBatch(fs, { ...request([`${root}/d3`]), channel: late, sequence: 1 });
    assert.equal(again.opened.length, 1, 'remembered only while one of its requests was outstanding');
    await readDirectoryBatch(fs, { ...request([], { retire: [again.opened[0].handle.id] }), channel: late, sequence: 2, end: true });
    // What the session keeps of a channel's requests is bounded: a request numbered far past those that arrived is refused.
    const far = crypto.randomUUID();
    await assert.rejects(() => readDirectoryBatch(fs, { ...request([]), channel: far, sequence: Number.MAX_SAFE_INTEGER, end: true }), { code: 'ESTALE' });
    const opened = await readDirectoryBatch(fs, { ...request([`${root}/d4`]), channel: far, sequence: 1 });
    // Sequence 1 arrived, so 2 is the first that has not: the window ends DIRECTORY_SEQUENCE_WINDOW past it.
    await assert.rejects(() => readDirectoryBatch(fs, { ...request([]), channel: far, sequence: 2 + DIRECTORY_SEQUENCE_WINDOW }), { code: 'ESTALE' });
    await readDirectoryBatch(fs, { ...request([], { retire: opened.opened.map((entry) => entry.handle.id) }), channel: far, sequence: 2, end: true });
  }

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
