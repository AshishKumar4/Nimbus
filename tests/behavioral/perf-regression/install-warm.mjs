#!/usr/bin/env bun
// perf-regression/install-warm — wall-time bound for npm install with
// 100% L2 (session-local) cache hit.
//
// User flow timed:
//   1. First `npm install left-pad@1.3.0` seeds the session cache.
//      (excluded from timed window)
//   2. `rm -rf node_modules` to force re-install path.
//   3. `npm install left-pad@1.3.0` again — now everything resolves
//      from the per-session R2 cache. Timed.
//
// Baseline: median=102 ms p95=103 ms threshold=250 ms
//   N=5 runs vs prod. Median is dominated by HTTPS round-trip; raw
//   p95 * 1.5 (155 ms) is too tight for normal HTTP jitter so we use
//   a 250 ms slack floor. See baselines.md.
//
// Threshold protects against the warm-cache regression class:
//   - L2 cache lookup path lost (every request goes back to R2).
//   - Lock-file fast-path regressed.
//   - Installer iterates through files when it should skip-on-cache-hit.

import { mintSession, Terminal, makeAsserter, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('perf-regression/install-warm');
console.log(`perf-regression/install-warm — ${BASE}`);

const THRESHOLD_MS = 250;

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

// Seed cache (untimed).
await t.run('npm install left-pad@1.3.0', 120_000);
await t.run('rm -rf node_modules', 10_000);

// Warm install — timed.
const t0 = performance.now();
const { output } = await t.run('npm install left-pad@1.3.0', 60_000);
const elapsed = performance.now() - t0;
await t.close();

// L2 cache hit marker: "(N from cache)" or "already installed".
const cacheHit = /from cache|already installed/.test(output);
a.check('npm install reports cache-hit on warm session', cacheHit,
  `tail=${JSON.stringify(output.slice(-300))}`);

a.check(`install-warm duration ≤ ${THRESHOLD_MS} ms threshold`,
  elapsed <= THRESHOLD_MS,
  `duration=${elapsed.toFixed(0)}ms threshold=${THRESHOLD_MS}ms p95-baseline=103ms`);

console.log(`[install-warm] duration=${elapsed.toFixed(0)}ms (threshold=${THRESHOLD_MS}ms, p95-baseline=103ms)`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
