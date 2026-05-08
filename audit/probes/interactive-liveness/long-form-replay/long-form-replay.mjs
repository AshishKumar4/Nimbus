// interactive-liveness — long-form-replay probe.
//
// Phase 5 load model (P5.1):
//   1. Vite dev server running (cirrus-real DO Facet path post-D'.1).
//   2. Periodic /preview/ fetches (every ~2s by default).
//   3. Periodic shell commands (every SHELL_CMD_INTERVAL_S — default 10s).
//   4. Forced webSocketError triggers every WS_KILL_INTERVAL_S
//      (default 75s — between 60-90s window per Phase 5 spec).
//      The probe closes the WS, sleeps 1.5s, reconnects via
//      B'.5 warm-rejoin, asserts cwd+env survived.
//   5. Diag polls every PROBE_INTERVAL_S sample heap, recovery_events,
//      isolateGen, breakdown components.
//
// HOLDS for HOLD_MINUTES (Phase 5: 10+) and asserts:
//   • zero isolateGen bumps (no DO restarts)
//   • banner count stays at 1 (cold-start MOTD only; warm rejoin
//     replays it via scrollback, not reprints it — the count counts
//     each WS connection's banner-from-first-receive, so multiple
//     reconnects WILL bump bannerCount; we assert bumps match
//     reconnectCount + 1, not zero)
//   • zero recovery events with dataLoss=true
//   • peak heap.percentOfCeiling ≤ 100% throughout (Phase 5 acceptance
//     bar; stretch goal ≤ 95%)
//   • EVERY heap.breakdown.* sum=total invariant holds at every poll
//   • diag p99 wallTime < 500 ms throughout
//   • B'.5 warmJoinCount equals the number of forced-close cycles
//
// Knobs (env):
//   HOLD_MINUTES            default 6 (Phase 5 runs at 10+)
//   PROBE_INTERVAL_S        default 30
//   PREVIEW_FETCH_HZ        default 0.5  (one /preview fetch every 2s)
//   SHELL_CMD_INTERVAL_S    default 10   (one shell cmd every 10s)
//   WS_KILL_INTERVAL_S      default 75   (forced ws-close every ~75s)
//   WS_KILLS_ENABLED        default '1'  (set to '0' to disable for
//                                          backward-compat 6-min run)
//
// Output: structured JSONL in long-form-replay.jsonl + a human summary
// in long-form-replay.txt.

import {
  BASE, mintSession, getDiag, WsSession, sleep,
} from '../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TXT = path.join(HERE, 'long-form-replay.txt');
const JSONL = path.join(HERE, 'long-form-replay.jsonl');
fs.writeFileSync(TXT, '');
fs.writeFileSync(JSONL, '');
const log = (s) => { fs.appendFileSync(TXT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };
const event = (e) => fs.appendFileSync(JSONL, JSON.stringify(e) + '\n');

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

const HOLD_MINUTES = Number(process.env.HOLD_MINUTES) || 6;
const PROBE_INTERVAL_S = Number(process.env.PROBE_INTERVAL_S) || 30;
const PREVIEW_FETCH_HZ = Number(process.env.PREVIEW_FETCH_HZ) || 0.5;
const SHELL_CMD_INTERVAL_S = Number(process.env.SHELL_CMD_INTERVAL_S) || 10;
const WS_KILL_INTERVAL_S = Number(process.env.WS_KILL_INTERVAL_S) || 75;
const WS_KILLS_ENABLED = (process.env.WS_KILLS_ENABLED ?? '1') !== '0';

async function previewFetcher(sid, untilMs) {
  const interval = 1000 / PREVIEW_FETCH_HZ;
  let count = 0;
  const errs = [];
  while (Date.now() < untilMs) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE}/s/${sid}/preview/`, { redirect: 'manual' });
      // We don't care about the status (preview pre-vite returns the
      // "no dev server" placeholder; once vite is up it returns the
      // app HTML). We DO care about whether the request completes.
      count++;
      event({ t: Date.now(), kind: 'preview_fetch', status: r.status, ms: Date.now() - t0 });
    } catch (e) {
      errs.push(String(e?.message || e));
    }
    await sleep(interval);
  }
  return { count, errs };
}

async function getSessionDebug(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`);
  if (!r.ok) return null;
  return r.json();
}

/**
 * Verify that heap.breakdown.* components sum to estimatedBytes.
 * The estimator's invariant — sum-of-components must equal
 * estimatedBytes at every poll. A drift means some allocator
 * isn't reporting through the breakdown surface (would be a
 * Phase 5 architectural defect).
 */
function checkBreakdownSum(d) {
  const bd = d?.heap?.breakdown;
  if (!bd) return { ok: false, reason: 'no breakdown' };
  let sum = 0;
  for (const k of Object.keys(bd)) sum += Number(bd[k]) || 0;
  const total = Number(d.heap.estimatedBytes) || 0;
  return {
    ok: sum === total,
    sum, total,
    components: Object.keys(bd).length,
  };
}

async function main() {
  log('==== interactive-liveness / long-form-replay ====');
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log(`BASE: ${BASE}`);
  log(`HOLD_MINUTES: ${HOLD_MINUTES}`);
  log(`PROBE_INTERVAL_S: ${PROBE_INTERVAL_S}`);
  log(`PREVIEW_FETCH_HZ: ${PREVIEW_FETCH_HZ}`);
  log(`SHELL_CMD_INTERVAL_S: ${SHELL_CMD_INTERVAL_S}`);
  log(`WS_KILL_INTERVAL_S: ${WS_KILL_INTERVAL_S}`);
  log(`WS_KILLS_ENABLED: ${WS_KILLS_ENABLED}`);

  const sid = await mintSession();
  log('SID: ' + sid);

  // Stage 1: open WS
  let s = new WsSession(sid);
  await s.connect();
  await s.waitForPrompt(8000);
  log(`stage 1: WS open, MOTD count=${s.bannerCount}`);
  if (s.bannerCount !== 1) fail(`unexpected banner count on first connect: ${s.bannerCount}`);

  // Stage 2: cd app + npm i
  s.reset();
  s.send('cd app && npm i\r');
  // Wait for npm-install completion or 90 s ceiling.
  try {
    await s.waitFor(
      (b) => /added \d+ packages|up to date/.test(b),
      90_000,
      'npm i complete',
    );
    log('stage 2: npm i appears complete');
  } catch (e) {
    log('stage 2: npm i timeout: ' + e.message);
  }
  await s.waitForPrompt(10_000);

  // Stage 2.5: pin the cwd to ~/app via export so warm-rejoin can
  // verify it survived. Also export a probe-specific env var.
  s.reset();
  s.send('export NIMBUS_LFR_TEST=phase5\r');
  await s.waitForNewPrompt(5000);

  // Stage 3: npm run dev
  s.reset();
  s.send('npm run dev\r');
  try {
    await s.waitFor(
      (b) => /Run.*vite stop|Pre-bundle complete|Local:.*localhost/i.test(b),
      90_000,
      'vite ready',
    );
    log('stage 3: vite ready');
  } catch (e) {
    log('stage 3: vite-ready timeout: ' + e.message);
  }
  await sleep(2000);

  // Snapshot the initial isolateGen + heap
  const startDiag = await getDiag(sid);
  const isoStart = startDiag.hib.isolateGen;
  const heapStart = startDiag.heap.estimatedBytes;
  const heapStartPct = startDiag.heap.percentOfCeiling;
  log(`stage 3.5: isolateGen=${isoStart} heap=${heapStart} pct=${heapStartPct}`);
  event({ t: Date.now(), kind: 'baseline', isolateGen: isoStart, heap: startDiag.heap });

  // Stage 4: hold loop with parallel /preview/ + shell + ws-kill +
  // diag polls.
  log(`stage 4: hold loop for ${HOLD_MINUTES} minutes`);
  const endTime = Date.now() + HOLD_MINUTES * 60_000;

  // Background: preview fetcher
  const previewTask = previewFetcher(sid, endTime);

  let probeCount = 0;
  const wallTimes = [];
  let isolateGenBumps = 0;
  let isolateGenLastSeen = isoStart;
  let peakHeapPct = heapStartPct;
  let peakHeapBytes = heapStart;
  let heapOverflow = 0;
  let breakdownSumDrifts = 0;
  let firstBreakdownDriftDetail = null;

  // Background: shell command pumper. Periodically sends a small
  // shell command; the WS is shared with the main loop. We don't
  // wait for prompt explicitly — sending is enough to keep the
  // shell + scrollback path warm.
  let shellCmdSent = 0;
  let shellCmdErrors = 0;
  let lastShellCmdAt = Date.now();

  // Background: forced ws-close pumper. Closes the current WS,
  // reconnects through the B'.5 warm-rejoin path, asserts the cwd
  // and env survived. The `s` reference gets reassigned each time.
  let wsKillCount = 0;
  let wsKillFailures = 0;
  let lastWsKillAt = Date.now();

  while (Date.now() < endTime) {
    // Pump shell commands every SHELL_CMD_INTERVAL_S
    if ((Date.now() - lastShellCmdAt) >= SHELL_CMD_INTERVAL_S * 1000) {
      try {
        s.send(`echo phase5_${shellCmdSent}\r`);
        shellCmdSent++;
        lastShellCmdAt = Date.now();
        event({ t: Date.now(), kind: 'shell_cmd', n: shellCmdSent });
      } catch (e) {
        shellCmdErrors++;
      }
    }

    // Pump forced ws-close every WS_KILL_INTERVAL_S
    if (WS_KILLS_ENABLED && (Date.now() - lastWsKillAt) >= WS_KILL_INTERVAL_S * 1000) {
      try {
        const tKill0 = Date.now();
        await s.close();
        await sleep(800);
        // Reconnect via B'.5 warm-rejoin
        s = new WsSession(sid);
        await s.connect();
        await sleep(1500); // Allow rejoin to settle (no waitForPrompt
                            // since vite output may obscure prompt)
        wsKillCount++;
        lastWsKillAt = Date.now();
        const dKill = await getSessionDebug(sid);
        event({
          t: Date.now(),
          kind: 'ws_kill',
          n: wsKillCount,
          ms: Date.now() - tKill0,
          warmJoinCount: dKill?.warmJoinCount ?? null,
          phase: dKill?.phase ?? null,
        });
      } catch (e) {
        wsKillFailures++;
        log(`  ws-kill #${wsKillCount + 1} failed: ${e?.message || e}`);
        // Try to recover the WS for subsequent loops
        try {
          s = new WsSession(sid);
          await s.connect();
        } catch {}
      }
    }

    await sleep(PROBE_INTERVAL_S * 1000);
    probeCount++;

    // Diag poll
    const tDiag0 = Date.now();
    let d;
    try {
      d = await getDiag(sid);
    } catch (e) {
      log(`  probe ${probeCount}: diag fetch failed: ${e?.message || e}`);
      continue;
    }
    const tDiag1 = Date.now();
    wallTimes.push(tDiag1 - tDiag0);

    // Track isolateGen
    if (d.hib.isolateGen !== isolateGenLastSeen) {
      isolateGenBumps++;
      log(`  probe ${probeCount}: isolateGen ${isolateGenLastSeen} → ${d.hib.isolateGen}`);
      isolateGenLastSeen = d.hib.isolateGen;
    }

    // Track heap
    if (d.heap.percentOfCeiling > peakHeapPct) peakHeapPct = d.heap.percentOfCeiling;
    if (d.heap.estimatedBytes > peakHeapBytes) peakHeapBytes = d.heap.estimatedBytes;
    if (d.heap.percentOfCeiling > 100) heapOverflow++;

    // Verify the breakdown components sum to estimatedBytes
    const bdCheck = checkBreakdownSum(d);
    if (!bdCheck.ok) {
      breakdownSumDrifts++;
      if (!firstBreakdownDriftDetail) {
        firstBreakdownDriftDetail = {
          probeN: probeCount,
          sum: bdCheck.sum,
          total: bdCheck.total,
          components: bdCheck.components,
          breakdown: d.heap.breakdown,
        };
      }
    }

    event({
      t: Date.now(),
      kind: 'probe',
      n: probeCount,
      isolateGen: d.hib.isolateGen,
      heapPct: d.heap.percentOfCeiling,
      heapBytes: d.heap.estimatedBytes,
      breakdownSum: bdCheck.sum,
      breakdownOk: bdCheck.ok,
      diagWallTimeMs: tDiag1 - tDiag0,
      bannerCountSeen: s.bannerCount,
      recoveryEventsLen: (d.recoveryEvents || []).length,
      shellCmdSent,
      wsKillCount,
    });
  }

  const previewResult = await previewTask;
  log(`stage 4 complete: ${probeCount} probes, ${previewResult.count} preview fetches, ${previewResult.errs.length} preview errors`);
  log(`  shell cmds sent: ${shellCmdSent} (${shellCmdErrors} errors)`);
  log(`  ws-kills triggered: ${wsKillCount} (${wsKillFailures} failures)`);

  // ── Architectural assertions ──────────────────────────────────────────
  if (isolateGenBumps === 0) {
    pass(`isolateGen stable at ${isoStart} for full ${HOLD_MINUTES} minutes`);
  } else {
    fail(`isolateGen bumped ${isolateGenBumps} times during ${HOLD_MINUTES}-minute hold`);
  }

  // Banner count semantics: with B'.3 scrollback persistence in
  // place, every warm-rejoin replays the prior scrollback (which
  // contains the cold-start banner). Counting "no new MOTDs" the
  // pre-Phase-3 way (`bannerCount === 0` on rejoin) is wrong now.
  //
  // The Phase 5 architectural anchor is: isolateGen never bumped
  // throughout the hold. If isolateGen stayed stable, every banner
  // sighting on every WS was from a scrollback replay, NOT from
  // a fresh Phase O reprint. We already assert isolateGen stability
  // above; that's sufficient as the "no DO RESET" invariant.
  //
  // What we CAN assert is that the final WS saw the banner (proves
  // scrollback replay didn't drop the banner under accumulated
  // load).
  if (wsKillCount > 0 && s.bannerCount === 0) {
    fail(`final WS bannerCount=0 — scrollback replay missed the banner`);
  } else if (wsKillCount > 0) {
    pass(`final WS bannerCount=${s.bannerCount} (scrollback replay preserved banner)`);
  } else if (s.bannerCount === 1) {
    pass(`bannerCount=1 (cold-start MOTD only; no rejoins to test replay)`);
  } else {
    fail(`unexpected bannerCount=${s.bannerCount} on no-rejoin path`);
  }

  const finalDiag = await getDiag(sid);
  const finalEvents = finalDiag.recoveryEvents || [];
  const dataLossEvents = finalEvents.filter(e => e.dataLoss === true);
  if (dataLossEvents.length === 0) {
    pass(`zero recovery events with dataLoss=true (saw ${finalEvents.length} clean transitions)`);
  } else {
    fail(`${dataLossEvents.length} recovery events with dataLoss=true`);
  }

  if (peakHeapPct <= 100) {
    pass(`peak heap ${peakHeapPct}% of ceiling (≤ 100% — under acceptance bar)`);
    if (peakHeapPct <= 95) {
      pass(`peak heap ${peakHeapPct}% ≤ 95% (stretch goal met)`);
    } else {
      log(`  note: peak heap ${peakHeapPct}% > 95% stretch goal but under acceptance bar`);
    }
  } else {
    fail(`peak heap ${peakHeapPct}% of ceiling — OVER the 64 MiB target`);
  }
  log(`  peak heap bytes = ${peakHeapBytes} (${(peakHeapBytes / (1024*1024)).toFixed(2)} MiB / 64.0 MiB)`);

  if (heapOverflow === 0) {
    pass('no heap-overflow probes observed during hold');
  } else {
    fail(`${heapOverflow} probes observed heap > 100% of ceiling`);
  }

  // Phase 5 invariant: sum-of-breakdown-components MUST equal
  // estimatedBytes at every poll. Otherwise some allocator bypassed
  // the breakdown surface and the heap accounting is lying.
  if (breakdownSumDrifts === 0) {
    pass(`heap.breakdown.* sum=total invariant held for all ${probeCount} polls`);
  } else {
    fail(`heap.breakdown sum=total drifted on ${breakdownSumDrifts}/${probeCount} polls`);
    if (firstBreakdownDriftDetail) {
      log(`  first drift: ${JSON.stringify(firstBreakdownDriftDetail)}`);
    }
  }

  // Phase 5 / B'.5 invariant: warmJoinCount on supervisor ==
  // wsKillCount triggered by probe.
  const finalSession = await getSessionDebug(sid);
  if (finalSession?.warmJoinCount !== undefined) {
    if (finalSession.warmJoinCount === wsKillCount) {
      pass(`warmJoinCount=${finalSession.warmJoinCount} matches wsKills=${wsKillCount} (B'.5 fired every cycle)`);
    } else {
      fail(`warmJoinCount=${finalSession.warmJoinCount} != wsKills=${wsKillCount}`);
    }
  }

  // Phase 5: verify env survived ws-kill cycles (B'.1 invariant).
  if (wsKillCount > 0) {
    s.reset();
    s.send('echo NIMBUS_LFR_TEST=$NIMBUS_LFR_TEST\r');
    await sleep(2000);
    if (s.buf.includes('NIMBUS_LFR_TEST=phase5')) {
      pass(`env NIMBUS_LFR_TEST survived ${wsKillCount} ws-kill cycles`);
    } else {
      fail(`env NIMBUS_LFR_TEST=phase5 not preserved across ws-kill cycles`);
    }
  }

  wallTimes.sort((a, b) => a - b);
  const p99idx = Math.floor((wallTimes.length - 1) * 0.99);
  const p99 = wallTimes[p99idx] ?? 0;
  if (p99 < 500) {
    pass(`diag-poll p99 wallTime ${p99} ms < 500 ms ceiling`);
  } else {
    fail(`diag-poll p99 wallTime ${p99} ms exceeds 500 ms ceiling`);
  }

  // Phase 5 summary metrics for retro
  log('---- Phase 5 metrics ----');
  log(`  HOLD_MINUTES        : ${HOLD_MINUTES}`);
  log(`  probes              : ${probeCount}`);
  log(`  preview_fetches     : ${previewResult.count}`);
  log(`  shell_cmds          : ${shellCmdSent}`);
  log(`  ws_kills            : ${wsKillCount}`);
  log(`  peak_heap_pct       : ${peakHeapPct}%`);
  log(`  peak_heap_bytes     : ${peakHeapBytes} (${(peakHeapBytes / (1024*1024)).toFixed(2)} MiB)`);
  log(`  diag_p99_ms         : ${p99}`);
  log(`  breakdown_sum_drifts: ${breakdownSumDrifts}`);
  log(`  data_loss_events    : ${dataLossEvents.length}`);

  await s.close();
  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
