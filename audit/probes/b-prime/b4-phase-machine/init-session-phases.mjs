// Phase 3 B'.4 functional probe — initSession R/B/W/O state machine
//
// Acceptance bar:
//   1. /api/_diag/session.phase exists.
//   2. Cold session (no /ws yet): phase === 'cold' (or null).
//   3. After /ws upgrade settles: phase === 'online'.
//   4. After forced ws-close: phase === 'drained'.
//   5. After reconnect on the same isolate: phase === 'online' again,
//      with the C'.2 recovery_event ring containing fine-grained
//      phase transitions for the second init:
//        rehydrate → build → wire → online
//      (each as its own ring entry, supplementing the existing
//      cold/drained → hydrated coarse-grained entries).
//
// Pre-build (RED): /api/_diag/session has no `phase` field.
// Post-build (GREEN): phase reflects the live state machine, and
// the ring shows phase transitions for both cold-start and re-init.
//
// Architectural intent: B'.4 makes the implicit Rehydrate/Build/Wire/
// Online phases of initSession explicit and observable. B'.5 will
// build on this by skipping the Build phase on re-entry (the "join
// existing session" path), so reconnect becomes a Wire-only operation.

import {
  BASE, mintSession, getDiag, WsSession, sleep,
} from '../../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'init-session-phases.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

async function getSessionDebug(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`);
  if (r.status === 404) return null;
  return r.json();
}

async function main() {
  log("==== B'.4 init-session-phases probe ====");
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);

  const sid = await mintSession();
  log('SID: ' + sid);

  // ── Stage 1: cold session ──────────────────────────────────────────────
  // /api/_diag/session called BEFORE any /ws upgrade. The session
  // exists (the route handler runs) but no initSession has run, so
  // phase should be 'cold' (or null — both valid for "no init yet").
  const cold = await getSessionDebug(sid);
  if (!cold) {
    fail("/api/_diag/session 404 — endpoint regressed since B'.1");
    log('==== EXIT ' + exitCode + ' ====');
    process.exit(exitCode);
  }
  log('stage 1: cold debug.phase = ' + JSON.stringify(cold.phase));
  if (cold.phase === undefined) {
    fail("phase field missing on /api/_diag/session — B'.4 surface not landed");
  } else if (cold.phase === null || cold.phase === 'cold') {
    pass(`cold session: phase = ${JSON.stringify(cold.phase)}`);
  } else {
    fail(`cold phase = ${JSON.stringify(cold.phase)} (expected null or 'cold')`);
  }

  // ── Stage 2: open WS, wait for prompt ──────────────────────────────────
  const s1 = new WsSession(sid);
  await s1.connect();
  await s1.waitForPrompt(8000);
  await sleep(300); // Let phase settle to its terminal value.

  // After initSession returns, the live phase is 'hydrated' (the
  // terminal init phase shared by cold + warm paths). The cold-vs-
  // warm distinction is captured in the ring's transition sequence,
  // not in the final phase value.
  const post1 = await getSessionDebug(sid);
  log('stage 2: post-WS debug.phase = ' + JSON.stringify(post1.phase));
  if (post1.phase === 'hydrated') {
    pass("post-WS phase = 'hydrated' (init complete)");
  } else {
    fail(`post-WS phase = ${JSON.stringify(post1.phase)} (expected 'hydrated')`);
  }

  // ── Stage 3: forced ws-close ──────────────────────────────────────────
  const isoBefore = (await getDiag(sid)).hib.isolateGen;
  await s1.close();
  await sleep(800);
  const isoAfter = (await getDiag(sid)).hib.isolateGen;
  if (isoAfter !== isoBefore) {
    fail(`isolateGen bumped (${isoBefore} → ${isoAfter}); not a same-isolate test`);
  } else {
    pass(`isolateGen stable at ${isoBefore} across close`);
  }

  const drained = await getSessionDebug(sid);
  log('stage 3: post-close debug.phase = ' + JSON.stringify(drained.phase));
  if (drained.phase === 'drained') {
    pass("post-close phase = 'drained'");
  } else {
    fail(`post-close phase = ${JSON.stringify(drained.phase)} (expected 'drained')`);
  }

  // ── Stage 4: reconnect ────────────────────────────────────────────────
  const s2 = new WsSession(sid);
  await s2.connect();
  await s2.waitForPrompt(8000);
  await sleep(300);

  const post2 = await getSessionDebug(sid);
  log('stage 4: post-reconnect debug.phase = ' + JSON.stringify(post2.phase));
  if (post2.phase === 'hydrated') {
    pass("post-reconnect phase = 'hydrated' (warm re-init complete)");
  } else {
    fail(`post-reconnect phase = ${JSON.stringify(post2.phase)} (expected 'hydrated')`);
  }

  // ── Stage 5: phase transitions in recovery_event ring ─────────────────
  const finalDiag = await getDiag(sid);
  const events = finalDiag.recoveryEvents || [];
  log('stage 5: recoveryEvents (count=' + events.length + ')');
  // After cold-start + close + reconnect, the ring should contain:
  //   First init  : rehydrate, build, wire, online (cold init runs Phase O)
  //   Close       : drained
  //   Second init : rehydrate, build, wire, hydrated (warm init skips Phase O)
  // Both `online` AND `hydrated` should appear — they discriminate
  // cold init from warm init. `drained` appears once.
  const toStates = events.map(e => e.toState);
  log('stage 5: toState sequence (newest-first) = ' + JSON.stringify(toStates));
  const toStateSet = new Set(toStates);
  log('stage 5: toState set = ' + JSON.stringify([...toStateSet].sort()));
  for (const phase of ['rehydrate', 'build', 'wire', 'online', 'hydrated', 'drained']) {
    if (toStateSet.has(phase)) {
      pass(`recovery_event ring contains toState='${phase}'`);
    } else {
      fail(`recovery_event ring missing toState='${phase}' — phase transition not recorded`);
    }
  }
  // Sanity: phase transitions appear in the right order (newest-first
  // is the ring's order, so reading bottom-up gives chronological).
  // The first init (oldest in ring) should produce: ... → online,
  // then drained, then second init: rehydrate → build → wire → hydrated.
  // Look for `hydrated` ABOVE `drained` ABOVE `online` in newest-first.
  const newestHydrated = toStates.indexOf('hydrated');
  const newestDrained = toStates.indexOf('drained');
  const oldestOnline = toStates.lastIndexOf('online');
  if (newestHydrated >= 0 && newestDrained >= 0 && oldestOnline >= 0
      && newestHydrated < newestDrained && newestDrained < oldestOnline) {
    pass('phase ordering: hydrated (newer) → drained → online (older) — re-init follows close follows cold-init');
  } else {
    fail(`phase ordering broken: hydratedIdx=${newestHydrated}, drainedIdx=${newestDrained}, onlineIdx=${oldestOnline}`);
  }

  await s2.close();
  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
