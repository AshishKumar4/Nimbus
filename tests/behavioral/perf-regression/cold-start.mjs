#!/usr/bin/env bun
// perf-regression/cold-start — cold session boot, against the baseline.
//
// User flow timed: POST /new (mint session DO) → first GET /api/_diag/cache
// (validates the DO booted to the point of serving HTTP). End-to-end.
//
// Graded paired (_paired.mjs): each round boots one session on each of the
// baseline's two Previews and the candidate's, at once. The fixed 1200 ms
// bound it replaces failed 25 of 561 full runs of main commits (10-09..10-16)
// with the same code measuring 226-3022 ms, and passed a 1.5x slower boot
// whenever its one sample landed under 800 ms.
//
// Realistic causes of a fail here:
//   - DO module-init time inflated by a new import.
//   - SqliteVFS init regressed (boot path reads from DO storage).
//   - First-request handler took on heavy synchronous work.

import { mintSession, makeAsserter, deleteSession, requestHeaders } from '../_driver.mjs';
import { assertCandidateRounds, assertPaired, measurePaired, requirePairedTargets } from '../_paired.mjs';

const a = makeAsserter('perf-regression/cold-start');
const arms = requirePairedTargets('perf-regression/cold-start');
console.log(`perf-regression/cold-start — baseline ${arms.a1.base}, ${arms.a2.base}; candidate ${arms.b1.base}, ${arms.b2.base}`);

// Resampling the rounds of a main-against-main run (2026-10-16) graded a
// +300 ms boot red in 79% of draws at 15 rounds and 99% at 40, and the
// unchanged code red in 1% at 40. A round takes about a second.
const ROUNDS = 40;

const result = await measurePaired(arms, ROUNDS, async (target) => {
  const t0 = performance.now();
  const sid = await mintSession(target);
  try {
    const r = await fetch(`${target.base}/s/${sid}/api/_diag/cache`, { headers: requestHeaders({}, sid) });
    const body = await r.text();
    const ms = performance.now() - t0;
    if (r.status !== 200) throw new Error(`${sid}: first /api/_diag/cache answered ${r.status}: ${JSON.stringify(body.slice(0, 80))}`);
    return { 'cold start': ms };
  } finally {
    await deleteSession(sid);
  }
});

assertCandidateRounds(a, 'its session serves its first /api/_diag/cache with 200', result);
const graded = assertPaired(a, 'cold start', result);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : graded ? 0 : 2);
