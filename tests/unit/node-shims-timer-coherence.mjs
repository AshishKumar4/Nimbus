#!/usr/bin/env bun
// The owner's invariant: a node process sees the latest coherent filesystem
// through sync OR async APIs. A facet-local timer resumption carries no
// supervisor message, so without a barrier a sync read inside a timer
// callback serves the spawn-time cell even after a peer overwrote the file.
//
// The shim wraps every timer callback in an ACQUIRE-and-refetch, manufacturing
// the message the resumption lacked. This test drives a REAL setTimeout and a
// REAL peer write against the real session, and asserts the sync read inside
// the callback sees the peer's bytes — the case that was stale before.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const authority = createAuthority();
const dir = '/home/user/t';
const resident = `${dir}/r.txt`;
authority.kfs.mkdir(dir, { recursive: true });
authority.kfs.writeFile(resident, 'V1');

const { fs, setTimeout: later, handle } = shimsOnSession({ authority });
const acquires = () => handle.log.calls.fsAcquire ?? 0;

// Warm the resident cell into the cursor's known state via one async touch.
assert.equal(await fs.promises.readFile(resident, 'utf8'), 'V1');

// A peer overwrites AFTER the facet is idle. No supervisor message reaches
// the facet — the only thing that will wake it is the timer below.
await authority.peer.writeFile(resident, 'REWRITTEN_BY_PEER');

const seen = await new Promise((resolve) => {
  later(() => { resolve(fs.readFileSync(resident, 'utf8')); }, 5);
});

// Before the fix this was 'V1' — the spawn-time cell served with no error.
assert.equal(seen, 'REWRITTEN_BY_PEER', 'sync read inside a timer callback sees the peer write');

// The barrier fired: the callback paid an ACQUIRE.
assert.ok(acquires() >= 1, 'timer callback performed an ACQUIRE');

// And the stat is consistent with the bytes — no fresh-content/stale-size split.
assert.equal(fs.statSync(resident).size, 'REWRITTEN_BY_PEER'.length);

// A timer that changes nothing still pays a "still R" round trip (the cost the
// owner accepted); it must NOT drop or corrupt the resident cell.
const before = acquires();
const stable = await new Promise((resolve) => {
  later(() => resolve(fs.readFileSync(resident, 'utf8')), 5);
});
assert.equal(stable, 'REWRITTEN_BY_PEER', 'a no-op resumption leaves the cache intact');
assert.equal(acquires(), before + 1, 'exactly one ACQUIRE per timer callback');

console.log('node-shims-timer-coherence: all assertions passed');
