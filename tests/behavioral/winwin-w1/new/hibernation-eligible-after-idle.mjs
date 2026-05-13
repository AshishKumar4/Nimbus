#!/usr/bin/env bun
// winwin-w1/hibernation-eligible-after-idle — smoking gun for W1.
//
// Asserts the DO actually hibernates+wakes during idle, by tracking
// `hib.isolateGen` from /api/_diag/memory across an idle window.
//
// Why isolateGen is the right signal:
//   - W9 increments + persists isolateGen on every fresh isolate (cold
//     start OR wake-from-hibernation). See src/session/hibernation.ts:
//     maybeBumpIsolateGen.
//   - If G1 == G0 after a 70s idle window with no requests, the DO
//     never hibernated → never woke → never re-ran the constructor.
//   - If G1 > G0, exactly one (or more) wake cycle ran in between.
//
// PRE-W1 behaviour (setTimeout chain in _ensureLogJanitor): G1 == G0
// because the 60s recurring setTimeout prevents hibernation per CF
// DO docs verbatim ("scheduled callbacks prevent hibernation. This
// includes setTimeout and setInterval usage.").
//
// POST-W1 behaviour: the timer is gone; alarms persist across
// hibernation. After 70s (60s alarm interval + 10s hib grace), at
// least one alarm fires → DO wakes → ctor reruns → isolateGen
// increments.
//
// Probe shape (black-box-ish; uses /api/_diag/memory.hib which is
// the same surface as cache-observability/hit-rate-tracking.mjs):
//   1. Mint session, connect WS, ensure prompt.
//   2. Snapshot G0 = hib.isolateGen via /api/_diag/memory.
//   3. Close WS (no in-flight requests; WS auto-response on so the
//      DO doesn't need to wake for pings).
//   4. Sleep 70 000 ms.
//   5. Reconnect WS, ensure prompt.
//   6. Snapshot G1 = hib.isolateGen.
//   7. Assert G1 > G0.

import { mintSession, Terminal, sleep, makeAsserter, BASE } from '../../_driver.mjs';
import { diagMemory } from '../../heap-correctness/_diag.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('winwin-w1/hibernation-eligible-after-idle');
console.log(`winwin-w1/hibernation-eligible-after-idle — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

let t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const m0 = await diagMemory(sid);
const G0 = m0?.hib?.isolateGen ?? null;
a.check('isolateGen present pre-idle', typeof G0 === 'number',
  `m0.hib=${JSON.stringify(m0?.hib).slice(0, 200)}`);

console.log(`[G0] isolateGen=${G0} — closing WS for 70s idle window`);
await t.close();

// 70s = 60s alarm cadence + 10s hibernation grace per CF docs.
// Need at least one alarm fire (which wakes the DO) within the
// idle window so isolateGen increments.
await sleep(70_000);

t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const m1 = await diagMemory(sid);
const G1 = m1?.hib?.isolateGen ?? null;
a.check('isolateGen present post-idle', typeof G1 === 'number',
  `m1.hib=${JSON.stringify(m1?.hib).slice(0, 200)}`);

console.log(`[G1] isolateGen=${G1}`);
a.check(
  'isolateGen incremented after 70s idle (DO hibernated+woke)',
  typeof G0 === 'number' && typeof G1 === 'number' && G1 > G0,
  `G0=${G0} G1=${G1} delta=${typeof G1 === 'number' && typeof G0 === 'number' ? G1 - G0 : 'N/A'}`,
);

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
