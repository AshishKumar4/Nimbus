#!/usr/bin/env bun
// perf-regression/cold-start — wall-time bound for cold session boot.
//
// User flow timed: POST /new (mint session DO) → first GET /api/_diag/cache
// (validates the DO booted to the point of serving HTTP). End-to-end.
//
// Baseline: median=596 ms p95=808 ms threshold=1200 ms
//   N=10 runs vs prod (commit at time of TST-3, post-ruby-v1 deploy).
//   See /workspace/.seal-internal/2026-05-11-tst3-perf-probes/baselines.md.
//
// Threshold protects against >50% cold-start regression. Realistic
// causes of a fail here:
//   - DO module-init time inflated by a new import.
//   - SqliteVFS init regressed (boot path reads from DO storage).
//   - First-request handler took on heavy synchronous work.

import { mintSession, makeAsserter, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('perf-regression/cold-start');
console.log(`perf-regression/cold-start — ${BASE}`);

const THRESHOLD_MS = 1200;

const t0 = performance.now();
const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/api/_diag/cache`);
const body = await r.text();
const elapsed = performance.now() - t0;

const status200 = r.status === 200;
a.check('first /api/_diag/cache returns 200', status200,
  `status=${r.status} body0=${JSON.stringify(body.slice(0, 80))}`);

a.check(`cold-start duration ≤ ${THRESHOLD_MS} ms threshold`,
  elapsed <= THRESHOLD_MS,
  `duration=${elapsed.toFixed(0)}ms threshold=${THRESHOLD_MS}ms p95-baseline=808ms`);

console.log(`[cold-start] duration=${elapsed.toFixed(0)}ms (threshold=${THRESHOLD_MS}ms, p95-baseline=808ms)`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
