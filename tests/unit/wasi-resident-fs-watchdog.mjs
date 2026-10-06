#!/usr/bin/env bun
/**
 * wasi-resident-fs-watchdog — a WASI guest's filesystem answers are brought up
 * to date after input reaches it, and the park watchdog's wake is such input.
 *
 * Through the real codec in the real WASI body (lib/wasi-resident-guest.mjs):
 *   - a stat answered from the store does not see a peer's write: nothing
 *     reached the guest that could have told it;
 *   - a poll whose clock outlasts the watchdog is woken by the watchdog with
 *     EAGAIN after __WASI_PARK_DEADLINE_MS (10 s): time passed, and the next
 *     stat takes the barrier and sees the write.
 */

import assert from 'node:assert/strict';
import { canPark, residentGuest, USER } from './lib/wasi-resident-guest.mjs';

if (!canPark) {
  console.log('wasi-resident-fs-watchdog: SKIPPED (this engine has no JSPI, so a guest answers from the session)');
  process.exit(0);
}

const guest = await residentGuest();
guest.kernel.writeFile('home/user/w.txt', 'one', { mode: 0o644 });
guest.kernel.chown('home/user/w.txt', USER.uid, USER.gid);
assert.equal(await guest.statSize('home/user/w.txt'), 3);
assert.equal(await guest.statSize('home/user/w.txt'), 3);
const local = guest.stats().local;
assert.ok(local > 0, 'the store answers the guest');

guest.kernel.writeFile('home/user/w.txt', 'three!', { mode: 0o644 });
assert.equal(await guest.statSize('home/user/w.txt'), 3, 'no input reached the guest: it reads what it read');

const started = Date.now();
const woke = await guest.sleep(15_000);
const waited = Date.now() - started;
assert.ok(waited < 14_000, `the watchdog woke the guest (after ${waited} ms)`);
assert.equal(woke, 6 /* __WASI_EAGAIN */, 'with EAGAIN');
const barriers = guest.stats().barriers;
assert.equal(await guest.statSize('home/user/w.txt'), 6, 'the wake was input: the next answer took the barrier');
assert.equal(guest.stats().barriers, barriers + 1);

await guest.dispose();
console.log(`wasi-resident-fs-watchdog: the watchdog's wake after ${waited} ms took the barrier before the next answer`);
process.exit(0);
