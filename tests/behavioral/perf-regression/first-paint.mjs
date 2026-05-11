#!/usr/bin/env bun
// perf-regression/first-paint — wall-time bound from `npm run dev` to
// first 200 on /preview/.
//
// User flow timed:
//   1. mint session → connect terminal → wait prompt.
//   2. `cd app && npm install` to install the seeded React+Vite project
//      (excluded from timed window).
//   3. Fire-and-forget `npm run dev` (vite blocks the terminal so we
//      use t.cmd() instead of t.run()).
//   4. Poll GET /s/<sid>/preview/ every 250 ms until status==200.
//      Time from cmd-sent to first 200 response.
//
// Baseline: median=577 ms p95=668 ms threshold=1000 ms
//   N=5 runs vs prod. See baselines.md.
//
// Threshold protects against vite-startup regression:
//   - vite plugin chain inflated.
//   - cirrus-real proxy regressed.
//   - Preview route lost the dev-server detection fast path.

import { mintSession, Terminal, makeAsserter, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('perf-regression/first-paint');
console.log(`perf-regression/first-paint — ${BASE}`);

const THRESHOLD_MS = 1000;

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

// Install deps (untimed).
await t.run('cd app && npm install', 300_000);

// Start dev server (fire-and-forget — vite blocks terminal).
const t0 = performance.now();
t.cmd('npm run dev');

// Poll preview URL until first 200. NO setTimeout sleep in assertion
// path — this is a tight bounded poll-until-found that fails loudly
// when the bound expires.
let firstPaintMs = 0;
let lastStatus = 0;
const POLL_BUDGET_MS = 90_000;
const POLL_INTERVAL_MS = 250;
while (performance.now() - t0 < POLL_BUDGET_MS) {
  try {
    const r = await fetch(`${BASE}/s/${sid}/preview/`, { redirect: 'manual' });
    lastStatus = r.status;
    if (r.status === 200) {
      firstPaintMs = performance.now() - t0;
      break;
    }
  } catch { /* fetch may transiently fail while vite is binding the port */ }
  await new Promise((rs) => setTimeout(rs, POLL_INTERVAL_MS));
}
await t.close();

a.check('preview returned 200 within poll budget', firstPaintMs > 0,
  `lastStatus=${lastStatus} budget=${POLL_BUDGET_MS}ms`);

a.check(`first-paint duration ≤ ${THRESHOLD_MS} ms threshold`,
  firstPaintMs > 0 && firstPaintMs <= THRESHOLD_MS,
  `duration=${firstPaintMs.toFixed(0)}ms threshold=${THRESHOLD_MS}ms p95-baseline=668ms`);

console.log(`[first-paint] duration=${firstPaintMs.toFixed(0)}ms (threshold=${THRESHOLD_MS}ms, p95-baseline=668ms)`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
