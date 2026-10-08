#!/usr/bin/env bun
// perf-regression/clone-fast — wall-time bound for git clone.
//
// User flow timed: `git clone https://github.com/AshishKumar4/markflow.git`
// on a fresh session. End-to-end including HTTPS handshake, packfile
// fetch, and VFS write.
//
// Budget: 5600 ms on the median of CLONE_RUNS clones, each on its own fresh
// session. Re-measured 2026-08-07, N=3 against a throwaway carrying the npm
// fanout branch: 1557/1610/1859 ms; 2026-10-08 on staging alone, N=7:
// 1847-2866 ms. One sample measures the tail rather than the typical clone:
// inside the full matrix (~16 probes on one target) a single clone took
// 14074 ms on a build that cloned in 1.8-2.9 s alone, 7 of 7. A regression
// moves the median; one slow clone does not. The 62-140 ms of client
// round-trip in each reading is ~2.5% of the budget.
//
// A per-clone ceiling stays as a backstop for a regression that only some
// clones show.
//
// Threshold protects against git-clone regression:
//   - cf-git pack-fetch path slowed.
//   - VFS writeBatchStream regressed (pack expansion).
//   - Network-facet round-trip inflation.

import { mintSession, Terminal, makeAsserter, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('perf-regression/clone-fast');
console.log(`perf-regression/clone-fast — ${BASE}`);

const THRESHOLD_MS = 5600;
const CLONE_RUNS = 5;
const CLONE_CEILING_MS = 20_000;

const durations = [];
for (let run = 1; run <= CLONE_RUNS; run++) {
  const sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(30_000);

  const t0 = performance.now();
  const { output } = await t.run('git clone https://github.com/AshishKumar4/markflow.git mf', 60_000);
  const elapsed = performance.now() - t0;
  await t.close();

  const cloneOk = /Cloning into|cloned/.test(output) && !/clone failed/.test(output);
  a.check(`clone ${run} reports success`, cloneOk, `tail=${JSON.stringify(output.slice(-300))}`);
  a.check(`clone ${run} ≤ ${CLONE_CEILING_MS} ms backstop`, elapsed <= CLONE_CEILING_MS, `duration=${elapsed.toFixed(0)}ms`);
  durations.push(elapsed);
  console.log(`[clone-fast] run ${run}: duration=${elapsed.toFixed(0)}ms session=${sid}`);
}

const sorted = [...durations].sort((x, y) => x - y);
const median = sorted[Math.floor(sorted.length / 2)];
a.check(`clone-fast median ≤ ${THRESHOLD_MS} ms threshold`, median <= THRESHOLD_MS,
  `median=${median.toFixed(0)}ms runs=${durations.map((d) => d.toFixed(0)).join(',')} threshold=${THRESHOLD_MS}ms`);
console.log(`[clone-fast] median=${median.toFixed(0)}ms of ${CLONE_RUNS} (threshold=${THRESHOLD_MS}ms)`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
