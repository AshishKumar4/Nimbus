#!/usr/bin/env bun
// perf-regression/resolve-deep — wall-time bound for transitive-dep
// resolution on a moderately-deep package tree.
//
// User flow timed: `npm install vite@5.0.0` on a fresh session. Vite 5
// has ~50-80 transitive deps including esbuild, rollup, and a few
// peers — exercises the resolver fan-out + cache-write paths.
//
// Baseline: median=21482 ms p95=22351 ms threshold=45000 ms
//   N=3/5 successful runs vs prod (2 hit DO eviction during the long
//   install — known issue, baseline captures the canonical success
//   path). Threshold widened from raw `p95 * 1.5` (33526 ms) to 45000 ms
//   after a flake-check run-3 produced 35744 ms — vite installs are
//   bursty enough that even a wide `p95 * 2` ≈ 44000 ms is needed to
//   absorb DO-eviction-recovery overhead without false-flagging.
//   See /workspace/.seal-internal/2026-05-11-tst3-perf-probes/baselines.md.
//
// Threshold protects against transitive-dep regression:
//   - Resolver fan-out scheduler regression.
//   - Packument-fetch parallelism reduced.
//   - install-batch-facet shard-dispatch overhead growth.

import { mintSession, Terminal, makeAsserter, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('perf-regression/resolve-deep');
console.log(`perf-regression/resolve-deep — ${BASE}`);

const THRESHOLD_MS = 45_000;

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const t0 = performance.now();
// Long timeout — vite install regularly exceeds 20s; under DO eviction
// recovery it can hit 35-40s. Shell timeout is THRESHOLD_MS + 20s so
// the timing-assertion message fires on regression instead of a shell
// timeout-exception.
const { output } = await t.run('npm install vite@5.0.0', THRESHOLD_MS + 20_000);
const elapsed = performance.now() - t0;
await t.close();

const installedOk = /added \d+ package|installed: \d|Done!/.test(output);
a.check('npm install vite@5.0.0 reports success marker', installedOk,
  `tail=${JSON.stringify(output.slice(-300))}`);

a.check(`resolve-deep duration ≤ ${THRESHOLD_MS} ms threshold`,
  elapsed <= THRESHOLD_MS,
  `duration=${elapsed.toFixed(0)}ms threshold=${THRESHOLD_MS}ms p95-baseline=22351ms`);

console.log(`[resolve-deep] duration=${elapsed.toFixed(0)}ms (threshold=${THRESHOLD_MS}ms, p95-baseline=22351ms)`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
