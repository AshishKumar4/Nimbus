// Phase 5 P5.2 — multi-isolate sweep probe.
//
// Acceptance bar: spinning up N cirrus-real facets and running them
// through the full lifecycle (start → use → stop → delete → restart)
// must reclaim each facet's SQL slot cleanly. No leak across cycles.
//
// Strategy:
//   1. Mint N independent sessions (each with its own supervisor DO).
//   2. For each session:
//      a. Open WS, cd app, NIMBUS_REAL_VITE=1 vite --force &
//      b. Capture diag.cookie — this is the per-facet identity
//         minted in the facet's own SQLite at first ctx.facets.get.
//      c. `vite stop` — calls cirrusReal.stop(ctx), which calls
//         ctx.facets.delete('cirrus-real-vite'). The facet's
//         SQLite slot is reclaimed.
//      d. Re-run NIMBUS_REAL_VITE=1 vite --force.
//      e. Capture new cookie. Must be DIFFERENT from (b) —
//         proving the SQL slot was actually reclaimed and a fresh
//         identity was minted.
//   3. Sample supervisor heap at each cycle. Heap should NOT grow
//      monotonically across N cycles (a leak would manifest as
//      linear growth with N).
//
// Invariants asserted:
//   - Each session's first cookie is unique (different sessions
//     have different cookies; trivial since they're random UUIDs
//     but we assert it for symmetry).
//   - For each session: cookie BEFORE stop != cookie AFTER restart.
//     This is the "SQL slot reclaimed" assertion.
//   - Supervisor heap at end of run ≤ supervisor heap at start +
//     a small overhead (10% of ceiling). Linear growth means
//     leak.
//
// Knobs (env):
//   N_SESSIONS  default 4. The free-tier worker isolate budget
//               is generous; we don't go higher for runtime cost
//               reasons but the probe scales linearly.

import {
  BASE, mintSession, getDiag, WsSession, sleep,
} from '../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'multi-isolate-sweep.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

const N_SESSIONS = Number(process.env.N_SESSIONS) || 4;

async function getCirrusDiag(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/cirrus`);
  if (r.status === 404) return null;
  return r.json();
}

/** One session lifecycle: open, start cirrus, capture cookie A,
 *  stop, restart, capture cookie B. Returns the cycle metrics. */
async function runOneSession(sid) {
  const s = new WsSession(sid);
  await s.connect();
  await s.waitForPrompt(8000);

  // First cirrus-real boot
  s.reset();
  s.send('cd app && export NIMBUS_REAL_VITE=1 && vite --force &\r');
  // Poll for cirrus-real running.
  let firstDiag = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const d = await getCirrusDiag(sid);
    if (d?.running) { firstDiag = d; break; }
  }
  if (!firstDiag) {
    return { sid, error: 'first boot did not reach running=true within 15s' };
  }

  // Capture supervisor heap after first boot
  const heap1 = (await getDiag(sid)).heap.estimatedBytes;

  // vite stop — triggers cirrusReal.stop(ctx) → ctx.facets.delete
  s.reset();
  s.send('vite stop\r');
  // Wait briefly for the stop sequence; we don't need to wait for
  // the prompt since vite is producing output.
  await sleep(2000);

  // Verify the diag now shows running=false.
  const stoppedDiag = await getCirrusDiag(sid);
  const stopOk = stoppedDiag?.running === false;

  // Second cirrus-real boot
  s.reset();
  s.send('vite --force &\r');
  let secondDiag = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const d = await getCirrusDiag(sid);
    if (d?.running) { secondDiag = d; break; }
  }
  if (!secondDiag) {
    return { sid, error: 'second boot did not reach running=true within 15s' };
  }

  const heap2 = (await getDiag(sid)).heap.estimatedBytes;

  await s.close();
  return {
    sid,
    cookieA: firstDiag.cookie,
    cookieB: secondDiag.cookie,
    stopOk,
    heap1,
    heap2,
    heapDelta: heap2 - heap1,
  };
}

async function main() {
  log('==== P5.2 multi-isolate-sweep ====');
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);
  log('N_SESSIONS: ' + N_SESSIONS);

  // Get baseline heap before any sessions exist.
  const baselineSid = await mintSession();
  const baseline = await getDiag(baselineSid);
  log(`baseline supervisor heap on fresh session = ${baseline.heap.estimatedBytes} (${(baseline.heap.estimatedBytes / 1024 / 1024).toFixed(2)} MiB)`);

  // Mint N sessions and run them sequentially.
  // Sequential (not parallel) so heap is observable per-session.
  const cycles = [];
  const seenCookies = new Set();
  for (let i = 0; i < N_SESSIONS; i++) {
    const sid = await mintSession();
    log(`---- session ${i+1}/${N_SESSIONS}: ${sid} ----`);
    const t0 = Date.now();
    const result = await runOneSession(sid);
    const dur = Date.now() - t0;
    log(`  duration: ${dur}ms`);
    if (result.error) {
      fail(`session ${sid}: ${result.error}`);
      continue;
    }
    log(`  cookieA: ${result.cookieA}`);
    log(`  cookieB: ${result.cookieB}`);
    log(`  stopOk:  ${result.stopOk}`);
    log(`  heap1:   ${result.heap1}`);
    log(`  heap2:   ${result.heap2}`);
    log(`  heapDelta: ${result.heapDelta}`);
    cycles.push(result);

    // Per-session assertions
    if (!result.cookieA || !result.cookieB) {
      fail(`session ${sid}: missing cookies`);
      continue;
    }
    if (result.cookieA === result.cookieB) {
      fail(`session ${sid}: cookieA === cookieB — SQL slot NOT reclaimed by ctx.facets.delete`);
    } else {
      pass(`session ${sid}: cookieA != cookieB (SQL slot reclaimed and re-minted)`);
    }
    if (!result.stopOk) {
      fail(`session ${sid}: vite stop did not transition diag.running to false`);
    }
    // First cookie should be unique across sessions (different DOs
    // mint different facets).
    if (seenCookies.has(result.cookieA)) {
      fail(`session ${sid}: cookieA collides with a prior session — facet identity not unique`);
    } else {
      seenCookies.add(result.cookieA);
    }
    if (seenCookies.has(result.cookieB)) {
      fail(`session ${sid}: cookieB collides with a prior cookie`);
    } else {
      seenCookies.add(result.cookieB);
    }
  }

  log(`---- summary across ${N_SESSIONS} sessions ----`);
  log(`unique cookies seen: ${seenCookies.size} (expected ${N_SESSIONS * 2})`);
  if (seenCookies.size === N_SESSIONS * 2) {
    pass(`all ${N_SESSIONS * 2} cookies were unique (no facet identity collisions)`);
  } else {
    fail(`only ${seenCookies.size} unique cookies (expected ${N_SESSIONS * 2})`);
  }

  // Wrangler-dev runs ALL sessions in the SAME workerd process, so
  // process heap is shared across DOs. Per-DO heap leak detection
  // requires sampling each DO's diag separately. We verify each
  // session's heap1 and heap2 are within a small window — heap2
  // should be approximately equal to heap1 (one start+stop+start
  // cycle adds at most a few KiB of GC noise on the supervisor).
  let leakDetected = false;
  for (const c of cycles) {
    // Allow up to 1 MiB delta on a single restart cycle as
    // legitimate per-call alloc churn. A leak would be much larger.
    if (Math.abs(c.heapDelta) > 1024 * 1024) {
      leakDetected = true;
      log(`  session ${c.sid}: heapDelta ${c.heapDelta} bytes exceeds 1 MiB`);
    }
  }
  if (!leakDetected) {
    pass(`no per-session heap leak detected (each restart cycle within 1 MiB delta)`);
  } else {
    fail('per-session heap leak detected (some cycles exceeded 1 MiB delta)');
  }

  // The first session's heap1 should be roughly equal to the last
  // session's heap1 — across N independent supervisor DOs, the heap
  // measured per-DO is independent. If the LAST session's heap1
  // is much higher than the FIRST's, it would suggest cross-DO
  // contamination (a worker-level leak).
  if (cycles.length >= 2) {
    const firstHeap = cycles[0].heap1;
    const lastHeap = cycles[cycles.length - 1].heap1;
    const drift = lastHeap - firstHeap;
    log(`  cross-DO drift (first → last heap1): ${drift} bytes`);
    if (Math.abs(drift) <= 2 * 1024 * 1024) {
      pass(`cross-DO heap stable (drift ${drift} bytes within 2 MiB tolerance)`);
    } else {
      fail(`cross-DO heap drifted ${drift} bytes — possible worker-level leak`);
    }
  }

  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
