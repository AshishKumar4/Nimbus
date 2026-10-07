#!/usr/bin/env bun
// perf-regression/install-warm — npm install with a 100% warm tarball cache.
//
// User flow timed:
//   1. First `npm install left-pad@1.3.0` seeds the session cache.
//      (excluded from the measurement)
//   2. `rm -rf node_modules` to force the install path.
//   3. `npm install left-pad@1.3.0` again — every tarball should now come
//      from the shared cache rather than the registry. Five times: the
//      budget is about the typical cost, and one sample measures the tail.
//
// What this probe asserts, and why it changed:
//
// It used to bound the CLIENT wall clock at 250 ms against a "median=102 ms
// p95=103 ms" baseline attributed to a baselines.md that has never existed in
// this repository — no target, date, or method was ever recorded for it.
// Measured over 50 interleaved warm installs, the client contributes 62-140 ms
// of that wall clock on its own (HTTPS round-trip, the WebSocket hop, and the
// driver's 50 ms waitFor poll), against a server-side install of 94-263 ms.
// A 103 ms total is therefore not reachable from a client that is not
// colocated with the colo, and the 250 ms bound sat inside the run-to-run
// spread rather than above it: the SAME commit measured 4/12 runs over
// threshold on long-lived staging and 6/12 on a fresh throwaway (p=0.79 for
// the difference), so the verdict was decided by luck and by where the probe
// ran, not by what it measured.
//
// So assert the two things the install itself owns:
//   1. Every tarball came from the cache. This is the direct form of the
//      regression class the timing bound was a proxy for — L2/L3 lookup path
//      lost, or the installer re-fetching when it should skip on a cache hit.
//   2. Server-side install time, read from the installer's own per-phase
//      breakdown, which excludes client round-trip and poll quantization.
// A loose wall-clock ceiling stays as a backstop for a regression that is
// visible to the user but lands outside the install phases.

import { mintSession, Terminal, makeAsserter, deleteSession, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('perf-regression/install-warm');
console.log(`perf-regression/install-warm — ${BASE}`);

// Server-side budget, on the median of WARM_RUNS installs. Observed 94-263
// ms (n=50, median 124, p95 216) across two targets, so this is ~1.9x p95,
// tight enough to catch the >3x blowup that losing the cache path or
// re-walking the tree would cause. On one install it measured the tail
// instead: 1 of 58 samples on 2026-10-07 went over, at 1128 ms, all of it one
// warm tarball read (fetch+write 1.0 s against a typical 60-120 ms). A 3x
// regression moves the median; one slow read does not.
const SERVER_BUDGET_MS = 400;
const WARM_RUNS = 5;
// Backstop only. The client's own 62-140 ms is inside this, so it catches a
// catastrophic regression without re-introducing a bound on network distance.
const WALL_CEILING_MS = 1500;

/** Sum the installer's `phases:` line. Values print as `123ms` or `1.2s`. */
function parsePhaseTotal(output) {
  const line = output.match(/phases:.*/)?.[0];
  if (!line) return null;
  const ms = [...line.matchAll(/=(\d+)ms/g)].reduce((t, m) => t + Number(m[1]), 0);
  const s = [...line.matchAll(/=([\d.]+)s/g)].reduce((t, m) => t + Number(m[1]) * 1000, 0);
  // A target predating millisecond phase output prints every sub-second phase
  // as `0.0s`, which would sum to ~0 and pass this probe without measuring
  // anything. Refuse to score that rather than report a silent green.
  if (!/=\d+ms/.test(line) && s === 0) return null;
  return { line, total: ms + s };
}

let sid;
try {
  sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(30_000);

  // Seed the cache (untimed).
  await t.run('npm install left-pad@1.3.0', 120_000);
  await t.run('rm -rf node_modules', 10_000);

  const totals = [];
  for (let run = 1; run <= WARM_RUNS; run++) {
    if (run > 1) await t.run('rm -rf node_modules', 10_000);
    const t0 = performance.now();
    const { output } = await t.run('npm install left-pad@1.3.0', 60_000);
    const wall = performance.now() - t0;

    a.check(`run ${run}: npm install reports a cache hit on the warm session`,
      /from cache|already installed/.test(output),
      `tail=${JSON.stringify(output.slice(-300))}`);

    // 1. Every tarball served from cache. The `R2 cache wins` field is
    //    omitted entirely when no tarball won its cache race, so an absent
    //    field is the cache path being lost and fails here.
    const wins = output.match(/R2 cache wins=(\d+)\/(\d+)/);
    a.check(`run ${run}: every tarball came from the shared cache, none from the registry`,
      wins !== null && wins[1] === wins[2] && Number(wins[2]) > 0,
      wins ? `R2 cache wins=${wins[1]}/${wins[2]}` : 'no "R2 cache wins" field — cache race won by nothing');

    // 2. Server-side install time, scored on the median below.
    const phases = parsePhaseTotal(output);
    a.check(`run ${run}: installer reports a scoreable phase breakdown`, phases !== null,
      'no `phases:` line, or every phase rounded to 0.0s on a target predating millisecond output — the budget below cannot be scored');
    if (phases) {
      totals.push(phases.total);
      console.log(`[install-warm] run ${run}: server=${phases.total}ms wall=${wall.toFixed(0)}ms (client overhead ${(wall - phases.total).toFixed(0)}ms) — ${phases.line}`);
    }

    a.check(`run ${run}: wall clock ≤ ${WALL_CEILING_MS} ms backstop`,
      wall <= WALL_CEILING_MS,
      `wall=${wall.toFixed(0)}ms ceiling=${WALL_CEILING_MS}ms`);
  }
  await t.close();

  if (totals.length === WARM_RUNS) {
    const median = [...totals].sort((x, y) => x - y)[Math.floor(WARM_RUNS / 2)];
    a.check(`server-side install, median of ${WARM_RUNS}, ≤ ${SERVER_BUDGET_MS} ms`,
      median <= SERVER_BUDGET_MS,
      `median=${median}ms of [${totals.join(', ')}] budget=${SERVER_BUDGET_MS}ms`);
    console.log(`[install-warm] server median=${median}ms of [${totals.join(', ')}]`);
  }
} finally {
  if (sid) { try { await deleteSession(sid); } catch { /* best-effort cleanup */ } }
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
