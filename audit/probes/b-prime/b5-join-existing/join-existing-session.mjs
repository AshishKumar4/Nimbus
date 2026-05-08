// Phase 3 B'.5 functional probe — /ws upgrade joins an existing
// in-isolate session instead of rebuilding the kernel/shell.
//
// Acceptance bar:
//   1. Cold start: kernel + shell + terminal built (Phase B+W+O).
//      C'.2 ring records: rehydrate → wire → build → online → hydrated.
//
//   2. Force ws-close on the SAME isolate. Critically: the in-memory
//      kernel/shell remain alive (Track B' invariant — the DO is
//      still alive, only the WS connection died, so the session
//      stays warm). Phase = 'drained'.
//
//   3. Open a NEW /ws on the same SID. The handler detects warm
//      kernel/shell already in self.* and runs the JOIN path:
//      Phase R + Phase W only (re-attach terminal to existing
//      Shell, replay scrollback). Phase B is SKIPPED.
//
//      The recovery_event ring's transition sequence for the second
//      init MUST contain 'rehydrate' and 'wire' but MUST NOT contain
//      'build' (that's the architectural assertion: B'.5 actually
//      skipped Build).
//
//   4. After join, the prior Shell's state is observable: cwd from
//      stage 2 is preserved; env from stage 2 is preserved; a
//      command from stage 2 is in the live shell history.
//
// Pre-build (RED): wsClose nulls self.shell/terminal/kernel; the
// next /ws either gets 409 (current behaviour) or rebuilds (after
// B'.5's reject removal). Without join detection, the ring shows
// 'build' on the second init.
//
// Post-build (GREEN): warm path's recovery_event ring entries:
//   first init (cold)  : rehydrate, wire, build, online, hydrated
//   close              : drained
//   second init (warm) : rehydrate, wire, hydrated   (no build!)

import {
  BASE, mintSession, getDiag, WsSession, sleep,
} from '../../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'join-existing-session.txt');
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
  log("==== B'.5 join-existing-session probe ====");
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);

  const sid = await mintSession();
  log('SID: ' + sid);

  // ── Stage 1: cold start, mutate state ────────────────────────────────
  const s1 = new WsSession(sid);
  await s1.connect();
  await s1.waitForPrompt(8000);
  s1.reset();
  s1.send('cd app && export NIMBUS_B5_TEST=joined\r');
  await s1.waitForNewPrompt(5000);
  log('stage 1: cwd=' + JSON.stringify(s1.promptCwd()));
  if (s1.promptCwd() !== '~/app') {
    fail(`stage 1 cwd setup failed: ${s1.promptCwd()}`);
  } else {
    pass('stage 1: cd into ~/app succeeded');
  }
  // Snapshot timestamp BEFORE close — used to filter post-close
  // events out of the bounded recovery_event ring. Earlier we used
  // ring length (slice(0, n)) but the ring is bounded at 50 and a
  // long-running wrangler process accumulates events from prior
  // probes that fill the ring; ring-length subtraction yields 0
  // when the ring was already at cap. Using `e.at > sinceMs`
  // doesn't depend on length.
  const sinceMs = Date.now();
  const beforeClose = await getDiag(sid);
  const ringCountBefore = (beforeClose.recoveryEvents || []).length;
  log('stage 1: ring count = ' + ringCountBefore + ' (sinceMs = ' + sinceMs + ')');

  // ── Stage 2: force ws-close ──────────────────────────────────────────
  const isoBefore = (await getDiag(sid)).hib.isolateGen;
  await s1.close();
  await sleep(800);
  const isoAfter = (await getDiag(sid)).hib.isolateGen;
  if (isoAfter !== isoBefore) {
    fail(`isolateGen bumped (${isoBefore} → ${isoAfter}); not a same-isolate test`);
  } else {
    pass(`isolateGen stable at ${isoBefore} across close`);
  }

  // After close, /api/_diag/session.phase should be 'drained'.
  const drained = await getSessionDebug(sid);
  log('stage 2: post-close debug.phase = ' + JSON.stringify(drained.phase));
  if (drained.phase !== 'drained') {
    fail(`post-close phase = ${JSON.stringify(drained.phase)} (expected 'drained')`);
  } else {
    pass("post-close phase = 'drained'");
  }

  // ── Stage 3: warm rejoin — open a new /ws ────────────────────────────
  // This is the join-existing path. The handler should NOT 409 and
  // should NOT rebuild the kernel. The /api/_diag/session.warmJoin
  // counter (added by B'.5) increments on a warm-join init.
  const s2 = new WsSession(sid);
  await s2.connect();
  await s2.waitForPrompt(8000);
  await sleep(400);

  const warm = await getSessionDebug(sid);
  log('stage 3: post-warmjoin debug.phase = ' + JSON.stringify(warm.phase));
  log('stage 3: warmJoinCount = ' + JSON.stringify(warm.warmJoinCount));
  if (warm.phase !== 'hydrated') {
    fail(`post-warmjoin phase = ${JSON.stringify(warm.phase)} (expected 'hydrated')`);
  } else {
    pass("post-warmjoin phase = 'hydrated'");
  }
  if (warm.warmJoinCount === undefined) {
    fail("warmJoinCount missing on /api/_diag/session — B'.5 surface not landed");
  } else if (warm.warmJoinCount >= 1) {
    pass(`warmJoinCount = ${warm.warmJoinCount} (≥1 — join path executed)`);
  } else {
    fail(`warmJoinCount = ${warm.warmJoinCount} (expected ≥1 — full rebuild happened instead of join)`);
  }

  // ── Stage 4: ring transitions for second init ────────────────────────
  // Filter events by timestamp (e.at > sinceMs) so we get the events
  // recorded AFTER stage 1's snapshot. Length-subtraction is wrong
  // when the ring is bounded and already at cap — see sinceMs comment
  // above.
  const finalDiag = await getDiag(sid);
  const allEvents = finalDiag.recoveryEvents || [];
  log('stage 4: total ring count = ' + allEvents.length);
  const newEvents = allEvents.filter(e => Number(e?.at) > sinceMs);
  const newToStates = newEvents.map(e => e.toState);
  log('stage 4: post-close toState sequence (newest-first) = ' + JSON.stringify(newToStates));

  // Expect the warm path: rehydrate, wire, hydrated, plus the
  // 'drained' from close. Critically NOT 'build' (the join skips
  // it) and NOT 'online' (the warm path skips Phase O too).
  const newToStatesSet = new Set(newToStates);
  if (newToStatesSet.has('rehydrate')) {
    pass('warm init: ring shows rehydrate');
  } else {
    fail('warm init: rehydrate missing');
  }
  if (newToStatesSet.has('wire')) {
    pass('warm init: ring shows wire');
  } else {
    fail('warm init: wire missing');
  }
  if (newToStatesSet.has('hydrated')) {
    pass('warm init: ring shows hydrated');
  } else {
    fail('warm init: hydrated missing');
  }
  if (newToStatesSet.has('drained')) {
    pass('warm init: ring shows drained from close');
  } else {
    fail('warm init: drained missing');
  }
  if (!newToStatesSet.has('build')) {
    pass("warm init: 'build' SKIPPED (join path executed — kernel reused)");
  } else {
    fail("warm init: 'build' present — full rebuild happened, join didn't fire");
  }
  if (!newToStatesSet.has('online')) {
    pass("warm init: 'online' SKIPPED (Phase O not reprinted)");
  } else {
    fail("warm init: 'online' present — Phase O re-ran on warm init");
  }

  // ── Stage 5: verify in-memory state survived the join ────────────────
  // The Shell from stage 1 is the same Shell we just rejoined to
  // (Track B' invariant). Therefore env vars set in stage 1 should
  // STILL be live without any SQL rehydrate (we never lost them).
  s2.reset();
  s2.send('echo NIMBUS_B5_TEST=$NIMBUS_B5_TEST\r');
  await s2.waitForNewPrompt(5000);
  if (s2.buf.includes('NIMBUS_B5_TEST=joined')) {
    pass('env NIMBUS_B5_TEST=joined survived warm rejoin (live Shell preserved)');
  } else {
    fail('env NIMBUS_B5_TEST not preserved — Shell was rebuilt or env was lost');
  }
  // cwd from stage 1 should be live in the rejoined Shell.
  const cwd2 = s2.promptCwd();
  if (cwd2 === '~/app') {
    pass('cwd ~/app survived warm rejoin');
  } else {
    fail(`cwd = ${JSON.stringify(cwd2)} (expected ~/app — Shell state lost)`);
  }

  await s2.close();
  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
