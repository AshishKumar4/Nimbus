#!/usr/bin/env bun
// Normal poll/sleep wakeups must invalidate the resident file-byte answer,
// including same-size peer rewrites, not just changes visible through stat.
import assert from 'node:assert/strict';
import { residentGuest, canPark } from './lib/wasi-resident-guest.mjs';
if (!canPark) { console.log('wasi-resident-fs-sleep: SKIPPED (no JSPI)'); process.exit(0); }
const guest = await residentGuest();
const read = async () => {
  const fd = await guest.open('home/user/watch.txt');
  try { return await guest.pread(fd, 64); } finally { await guest.close(fd); }
};
try {
  guest.kernel.writeFile('home/user/watch.txt', 'one');
  assert.equal(await read(), 'one');
  const before = guest.stats();
  const sleeping = guest.sleep(100);
  guest.kernel.writeFile('home/user/watch.txt', 'two');
  assert.equal(await sleeping, 0);
  assert.equal(await read(), 'two', 'same-size file rewrite is visible after sleep wakes');
  assert.ok(guest.stats().barriers > before.barriers, 'the wake took the shared barrier');
  for (let n = 0; n < 3; n++) {
    const wake = guest.sleep(20);
    guest.kernel.writeFile('home/user/watch.txt', `v${n}!`);
    await wake;
    assert.equal(await read(), `v${n}!`);
  }
} finally { await guest.dispose(); }
console.log('wasi-resident-fs-sleep: every normal wake sees the peer rewrite');
