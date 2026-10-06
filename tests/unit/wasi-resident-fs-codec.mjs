#!/usr/bin/env bun
/**
 * wasi-resident-fs-codec — the resident filesystem as a guest reaches it:
 * through the real codec (wasi/filesystem.ts) in the real WASI body, with the
 * guest's calls made as a guest makes them (lib/wasi-resident-guest.mjs).
 *
 *   - A descriptor the codec answers itself pins the bytes it read for its
 *     lifetime, one buffer per revision, charged to the store's one budget;
 *     past the budget the codec opens the session's descriptor, and closing
 *     descriptors gives the budget back.
 *   - A refusal met by a flush that something else caused is still the
 *     answer of a later fsync, through the writer's descriptor or any other.
 *   - A held file's fstat is the session's live one: a peer's unlink shows
 *     (nlink 0) while the size is what the process holds.
 */

import assert from 'node:assert/strict';
import { canPark, residentGuest, USER } from './lib/wasi-resident-guest.mjs';

if (!canPark) {
  console.log('wasi-resident-fs-codec: SKIPPED (this engine has no JSPI, so a guest answers from the session)');
  process.exit(0);
}

const MiB = 1024 * 1024;
const ENOSPC = 51;
let passed = 0;
let index = 0;
/** ONLY=<n> runs the n-th check alone (1-based). */
const only = process.env.ONLY === undefined ? null : Number(process.env.ONLY);
const check = async (name, fn) => {
  index++;
  if (only !== null && only !== index) return;
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

await check('descriptors pin one buffer per revision, within the store\'s budget, and give it back on close', async () => {
  const guest = await residentGuest();
  for (let i = 0; i < 24; i++) {
    guest.kernel.writeFile(`home/user/f${i}.bin`, new Uint8Array(2 * MiB + i).fill(i), { mode: 0o644 });
    guest.kernel.chown(`home/user/f${i}.bin`, USER.uid, USER.gid);
  }
  // Two descriptors on one file share its bytes.
  const a = await guest.open('home/user/f0.bin');
  const b = await guest.open('home/user/f0.bin');
  assert.equal(guest.stats().pins, 1);
  assert.equal(guest.stats().pinnedBytes, 2 * MiB);
  // Many files, every descriptor kept open: pins stop at the budget, and the rest are the session's descriptors.
  const before = guest.stats().delegated.open ?? 0;
  const fds = [];
  for (let i = 1; i < 24; i++) fds.push(await guest.open(`home/user/f${i}.bin`));
  const pinned = guest.stats().pinnedBytes;
  const sessionOpens = (guest.stats().delegated.open ?? 0) - before;
  assert.ok(pinned <= 32 * MiB, `pinned ${pinned} bytes, within the budget`);
  assert.ok(sessionOpens > 0, 'past the budget, opens are the session\'s descriptors');
  assert.ok(guest.stats().pins + sessionOpens >= 23);
  for (const fd of [a, b, ...fds]) assert.equal(await guest.close(fd), 0);
  assert.equal(guest.stats().pinnedBytes, 0, 'closing gives every pinned byte back');
  // With the budget back, a file is pinned again.
  const again = await guest.open('home/user/f23.bin');
  assert.equal(guest.stats().pins, 1);
  await guest.close(again);
  await guest.dispose();
});

await check('a refusal met by another operation\'s flush is the answer of a later fsync, through any descriptor', async () => {
  const guest = await residentGuest({ refuse: (path) => /refused(-again)?\.bin$/.test(path) });
  const writer = await guest.open('home/user/refused.bin', { create: true, truncate: true, write: true });
  assert.equal(await guest.write(writer, 'lost bytes'), 0);
  // A path change flushes what is held; the session refuses the write.
  assert.equal(await guest.mkdir('home/user/elsewhere'), 0);
  // A reader's fsync (the codec's own copy of the file) reports it.
  const reader = await guest.open('home/user/refused.bin');
  assert.equal(await guest.sync(reader), ENOSPC, 'fsync through a reader');
  assert.equal(await guest.sync(reader), ENOSPC, 'and again: the reader does not consume the writer\'s error');
  assert.equal(await guest.close(reader), 0);
  assert.equal(await guest.close(writer), ENOSPC, 'the writer\'s close reports it');
  // The writer's own fsync reports it once, as Linux does per descriptor; its close then has nothing left to say.
  const second = await guest.open('home/user/refused-again.bin', { create: true, truncate: true, write: true });
  assert.equal(await guest.write(second, 'lost too'), 0);
  assert.equal(await guest.mkdir('home/user/elsewhere-too'), 0);
  assert.equal(await guest.sync(second), ENOSPC, 'fsync through the writer');
  assert.equal(await guest.close(second), 0);
  assert.equal(await guest.P.__wasiSettleWrites(), null, 'every refusal was reported to the program');
  await guest.dispose();
});

await check('a held file\'s fstat is the session\'s live one, with the held size', async () => {
  const guest = await residentGuest();
  const fd = await guest.open('home/user/held.txt', { create: true, truncate: true, write: true });
  assert.equal(await guest.write(fd, 'abc'), 0);
  assert.deepEqual(await guest.fstat(fd), { nlink: 1, size: 3 });
  guest.kernel.unlink('home/user/held.txt');
  assert.deepEqual(await guest.fstat(fd), { nlink: 0, size: 3 }, 'a peer\'s unlink shows');
  assert.equal(await guest.close(fd), 0);
  await guest.dispose();
});

await check('a reader of a file held again after its writer closed reads the new bytes, the old reader still open', async () => {
  const guest = await residentGuest();
  const first = await guest.open('home/user/again.txt', { create: true, truncate: true, write: true });
  assert.equal(await guest.write(first, 'old'), 0);
  const oldReader = await guest.open('home/user/again.txt');
  assert.equal(await guest.pread(oldReader, 16), 'old');
  assert.equal(await guest.close(first), 0);
  // The same inode, held again from empty.
  const second = await guest.open('home/user/again.txt', { truncate: true, write: true });
  assert.equal(await guest.write(second, 'new'), 0);
  const newReader = await guest.open('home/user/again.txt');
  assert.equal(await guest.pread(newReader, 16), 'new', 'the new reader reads what the second writer wrote');
  assert.equal(await guest.pread(oldReader, 16), 'old', 'the old reader keeps what it opened');
  for (const fd of [oldReader, newReader, second]) assert.equal(await guest.close(fd), 0);
  await guest.dispose();
});

await check('closing the last reader of a held file frees its copy while the writer goes on', async () => {
  const { heapStats } = await import('bun:jsc');
  const external = () => { Bun.gc(true); return heapStats().extraMemorySize; };
  const guest = await residentGuest();
  const writer = await guest.open('home/user/big-held.bin', { create: true, truncate: true, write: true });
  assert.equal(await guest.writeBytes(writer, new Uint8Array(6 * MiB).fill(9)), 0);
  const before = external();
  const reader = await guest.open('home/user/big-held.bin');
  assert.equal(guest.stats().pinnedBytes, 6 * MiB);
  const during = external();
  assert.ok(during - before > 5 * MiB, `the reader's copy is ${during - before} bytes`);
  assert.equal(await guest.close(reader), 0);
  assert.equal(guest.stats().pinnedBytes, 0);
  const after = external();
  assert.ok(after - before < 1 * MiB, `after the last reader closed, ${after - before} bytes stay beyond the held file`);
  assert.equal(await guest.close(writer), 0);
  await guest.dispose();
});

console.log(`wasi-resident-fs-codec: ${passed} checks passed`);
process.exit(0);
