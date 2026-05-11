#!/usr/bin/env bun
// perf-regression/clone-fast — wall-time bound for git clone.
//
// User flow timed: `git clone https://github.com/AshishKumar4/markflow.git`
// on a fresh session. End-to-end including HTTPS handshake, packfile
// fetch, and VFS write.
//
// Baseline: median=2631 ms p95=3695 ms threshold=5600 ms
//   N=5 runs vs prod. See baselines.md.
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

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const t0 = performance.now();
const { output } = await t.run('git clone https://github.com/AshishKumar4/markflow.git mf', 60_000);
const elapsed = performance.now() - t0;
await t.close();

const cloneOk = /Cloning into|cloned/.test(output) && !/clone failed/.test(output);
a.check('git clone reports success', cloneOk,
  `tail=${JSON.stringify(output.slice(-300))}`);

a.check(`clone-fast duration ≤ ${THRESHOLD_MS} ms threshold`,
  elapsed <= THRESHOLD_MS,
  `duration=${elapsed.toFixed(0)}ms threshold=${THRESHOLD_MS}ms p95-baseline=3695ms`);

console.log(`[clone-fast] duration=${elapsed.toFixed(0)}ms (threshold=${THRESHOLD_MS}ms, p95-baseline=3695ms)`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
