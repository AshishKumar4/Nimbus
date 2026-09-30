#!/usr/bin/env bun
// perf-regression/install-cold — wall-time bound for npm install on a
// fresh session.
//
// User flow timed: mint session → connect terminal → wait prompt →
// `npm install left-pad@1.3.0` → time from command-issued to prompt-
// returns. Note: in practice the R2 packument cache is hot from cross-
// session traffic so this is "cold session, warm L2" — still the
// canonical install path most users see (cold L1, hot L2).
//
// Threshold: 30 s. The product requirement is that the install reliably
// finishes, not a latency target. Measured on 2026-09-30, 10 fresh sessions
// each: the release candidate p50 0.8 s / p95 1.2 s, production p50 0.8 s /
// p95 1.3 s, and 1.7 s once under a loaded suite run. Resolving the one
// package waits on an R2 packument read of 0.4-0.6 s whenever the colo cache
// misses, so a bound near the median failed on both builds for no change in
// Nimbus. A hang, a retry storm or a resolver that stops completing crosses
// 30 s; speed is tracked by measurement, not by this gate.

import { mintSession, Terminal, makeAsserter, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('perf-regression/install-cold');
console.log(`perf-regression/install-cold — ${BASE}`);

const THRESHOLD_MS = 30_000;

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const t0 = performance.now();
const { output, elapsed: shellElapsed } = await t.run('npm install left-pad@1.3.0', 120_000);
const elapsed = performance.now() - t0;
await t.close();

const installedOk = /added \d+ package|already installed|installed: \d/.test(output);
a.check('npm install left-pad@1.3.0 reports success marker', installedOk,
  `tail=${JSON.stringify(output.slice(-300))}`);

a.check(`install-cold duration ≤ ${THRESHOLD_MS} ms threshold`,
  elapsed <= THRESHOLD_MS,
  `duration=${elapsed.toFixed(0)}ms shellElapsed=${shellElapsed}ms threshold=${THRESHOLD_MS}ms`);

console.log(`[install-cold] duration=${elapsed.toFixed(0)}ms (threshold=${THRESHOLD_MS}ms)`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
