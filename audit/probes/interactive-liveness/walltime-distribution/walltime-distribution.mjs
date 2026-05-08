// Phase 1 C'.3 / interactive-liveness — wallTime-distribution probe.
//
// Asserts the workerd request scheduling distribution is healthy.
// During the prod-reset investigation we observed a bimodal wallTime
// distribution on /api/_diag/memory:
//   - 22 frames at ~5085 ms (clustered ±200 ms of the 5000 ms
//     setHibernatableWebSocketEventTimeout)
//   - 12 frames at 15-60 s
//   - 4 frames > 60 s (max 106 747 ms)
// (See audit/sections/PROD-RESET-INVESTIGATION-plan.md §1 H6 for the
//  raw histogram.)
//
// A healthy steady-state for a cheap GET endpoint is: > 90 % of frames
// in the < 100 ms bucket. The 5-s cluster is a smoking gun for a
// hibernatable WS handler holding the input lock.
//
// This probe drives diag traffic locally then computes the histogram.
// In Phase 1 it runs against wrangler dev (no real workerd scheduling
// games, so we expect almost everything in <100 ms — this is the
// architectural baseline, not a prod-side capture).
//
// In Phase 5 (post-Track-A'/B'/D') we re-run against prod-style
// scenarios and assert < 5 % of frames in the ~5 s bucket.

import {
  BASE, mintSession, getDiag, sleep, wallTimeBucket, percentile,
} from '../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'walltime-distribution.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

// Probe knobs — kept low so the probe is fast in Phase 1. Phase 5
// re-runs with higher numbers against a realistic-load environment.
const SAMPLES = Number(process.env.SAMPLES) || 60;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 100;

async function main() {
  log('==== interactive-liveness / walltime-distribution ====');
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log(`BASE: ${BASE}`);
  log(`SAMPLES: ${SAMPLES}`);
  log(`POLL_INTERVAL_MS: ${POLL_INTERVAL_MS}`);

  const sid = await mintSession();
  log('SID: ' + sid);

  // Drive SAMPLES /api/_diag/memory polls; record each request's
  // CLIENT-SIDE wall time. In a wrangler-dev environment this is
  // network roundtrip + handler time. In prod it would be
  // captured via wrangler tail JSON; we use client-side here so
  // the probe is self-contained.
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = Date.now();
    await getDiag(sid);
    const t1 = Date.now();
    samples.push(t1 - t0);
    await sleep(POLL_INTERVAL_MS);
  }

  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);

  // Histogram by bucket
  const histogram = {};
  for (const s of samples) {
    const b = wallTimeBucket(s);
    histogram[b] = (histogram[b] || 0) + 1;
  }

  log('--- distribution ---');
  log(`p50: ${p50} ms`);
  log(`p95: ${p95} ms`);
  log(`p99: ${p99} ms`);
  log(`histogram: ${JSON.stringify(histogram, null, 2)}`);

  // ── Architectural assertions ──────────────────────────────────────────

  // Assertion 1: p99 < 500 ms for a cheap diag endpoint. This is the
  // primary "is the supervisor healthy" signal.
  if (p99 < 500) {
    pass(`p99 ${p99} ms < 500 ms ceiling`);
  } else {
    fail(`p99 ${p99} ms exceeds 500 ms ceiling — supervisor is not healthy under poll load`);
  }

  // Assertion 2: ≥ 90% of frames in the <100 ms bucket. This is the
  // architectural target for an idle session — no hibernatable WS
  // handler in flight, so input-lock contention should be invisible.
  const fastCount = histogram['<100'] || 0;
  const fastFraction = fastCount / SAMPLES;
  if (fastFraction >= 0.9) {
    pass(`${(fastFraction * 100).toFixed(1)}% of frames in <100 ms bucket (target ≥ 90%)`);
  } else {
    fail(`only ${(fastFraction * 100).toFixed(1)}% of frames in <100 ms bucket (target ≥ 90%)`);
  }

  // Assertion 3: < 5% of frames in the ~5 s bucket (the cluster we
  // saw in prod). Local wrangler dev should have ZERO frames there;
  // this assertion is calibrated for prod-side runs of the probe.
  const fiveSecondCount = histogram['~5s'] || 0;
  const fiveSecondFraction = fiveSecondCount / SAMPLES;
  if (fiveSecondFraction < 0.05) {
    pass(`${(fiveSecondFraction * 100).toFixed(1)}% of frames in ~5s bucket (target < 5%)`);
  } else {
    fail(`${(fiveSecondFraction * 100).toFixed(1)}% of frames in ~5s bucket — input-lock contention smoking gun`);
  }

  // Assertion 4: zero frames > 60 s (the catastrophic outlier bucket).
  const catastrophicCount = (histogram['>60s'] || 0);
  if (catastrophicCount === 0) {
    pass('zero frames > 60 s (catastrophic outlier bucket clean)');
  } else {
    fail(`${catastrophicCount} frames > 60 s — input lock or waitUntil chain bug`);
  }

  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
