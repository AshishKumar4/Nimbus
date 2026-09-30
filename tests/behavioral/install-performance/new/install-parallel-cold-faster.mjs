#!/usr/bin/env bun
// install-performance/install-parallel-cold-faster — a cold clang install
// completes, and within a bound no user would mistake for a hang.
//
// clang is 5 blobs, 50.6 MiB (a 29.8 MiB compiler and an 18.6 MiB linker),
// copied from R2 into the session's filesystem three at a time. Measured on
// 2026-09-30, 10 fresh sessions each: the release candidate p50 2.2 s / p95
// 3.4 s, production p50 2.8 s / p95 4.6 s. R2's per-read latency moves it by
// seconds from run to run, so a bound near the median fails for no change in
// Nimbus.
//
// Threshold: 30 s. The product requirement is that the install reliably
// finishes, not a latency target; a hang, a retry storm or a serial fetch of
// every blob crosses it, and speed is tracked by measurement, not by this
// gate.

import { mintSession, Terminal, makeAsserter, stripAnsi, BASE } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('install-performance/install-parallel-cold-faster');
console.log(`install-performance/install-parallel-cold-faster — ${BASE}`);

const THRESHOLD_MS = 30_000;

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const t0 = performance.now();
const { output } = await t.run('nimbus install clang', 180_000);
const elapsed = performance.now() - t0;
await t.close();

const installedOk = /installed at/.test(stripAnsi(output));
a.check('clang install completed successfully', installedOk,
  `tail=${JSON.stringify(stripAnsi(output).slice(-300))}`);

a.check(
  `clang cold install duration ≤ ${THRESHOLD_MS} ms`,
  elapsed <= THRESHOLD_MS,
  `duration=${elapsed.toFixed(0)}ms threshold=${THRESHOLD_MS}ms`,
);

console.log(`[install-parallel-cold-faster] duration=${elapsed.toFixed(0)}ms threshold=${THRESHOLD_MS}ms`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
