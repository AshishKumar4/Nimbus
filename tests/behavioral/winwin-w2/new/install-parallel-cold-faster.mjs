#!/usr/bin/env bun
// winwin-w2/install-parallel-cold-faster — clang cold-install wall-clock
// bound.
//
// W2 parallelizes the runtime blob-fetch loop with concurrency=3. For
// clang (5 blobs; ~31 MB clang.wasm + ~19 MB wasm-ld + 3 small) the
// dominant blobs overlap. Empirical PRE baseline on prod 25e302c4
// (10 fresh-session cold installs, L2-warm): p50 ≈ 1100 ms,
// p95 ≈ 3300 ms (first run cold L2; subsequent L2-warm).
//
// Threshold: 2000 ms — comfortably above p50 PRE but should be well
// below POST p50 (target ≤ ~700-800 ms, 30-50% improvement).
//
// PROBE-QUALITY contract: this is a perf probe, asserts a duration
// upper bound the user would notice. The W2 build verification ALSO
// captures a 10-run distribution + Mann-Whitney p<0.05 vs PRE to
// confirm strict-improvement statistically; that's done in the
// build-time driver, not this probe.

import { mintSession, Terminal, makeAsserter, stripAnsi, BASE } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('winwin-w2/install-parallel-cold-faster');
console.log(`winwin-w2/install-parallel-cold-faster — ${BASE}`);

const THRESHOLD_MS = 2000;

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
  `duration=${elapsed.toFixed(0)}ms threshold=${THRESHOLD_MS}ms (PRE baseline p50≈1100ms; POST target ≤700-800ms)`,
);

console.log(`[install-parallel-cold-faster] duration=${elapsed.toFixed(0)}ms threshold=${THRESHOLD_MS}ms`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
