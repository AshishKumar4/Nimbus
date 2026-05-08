// Phase 1 C'.3 / interactive-liveness — error-recovery probe.
//
// Asserts Track B' invariants under a synthetic error trigger.
// Pre-Track-B': RED (recovery does not preserve state, no recovery
// events recorded). Post-Track-B': GREEN (state preserved, ring
// shows clean transitions, dataLoss=false).
//
// Probe sequence:
//   1. Mint a fresh session.
//   2. Connect WS, wait for prompt + MOTD #1.
//   3. cd into the seeded /home/user/app project.
//   4. Note isolateGen baseline + reset recovery-event ring.
//   5. Force a webSocketClose (synthetic equivalent of webSocketError
//      for shell.null path, src/nimbus-session-ws.ts:165 vs :221).
//   6. Reconnect WS.
//   7. Assert (Track B' green criteria):
//      - isolateGen unchanged (same isolate; we're testing recovery,
//        not cold boot)
//      - bannerCount === 1 on second connect (the original cold-start
//        banner is replayed via scrollback persistence, NOT reprinted
//        by Phase O — banner=2 would be a regression)
//      - cwd === '~/app' (state persisted across drained→hydrated)
//      - recoveryEvents ring shows: drained THEN hydrated, both
//        with dataLoss=false
//
// Pre-fix expected RED:
//   - bannerCount === 2 on second connect (MOTD reprint)
//   - cwd === '~' (cwd lost)
//   - recoveryEvents ring is empty (no transitions recorded)

import {
  BASE, mintSession, getDiag, WsSession, sleep,
} from '../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'error-recovery.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

async function resetRing(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_test/recovery-event/reset`, { method: 'POST' });
  if (r.status === 404) {
    log('NOTE: NIMBUS_DEBUG not set; recovery-event reset unavailable');
    return false;
  }
  return r.ok;
}

async function main() {
  log('==== interactive-liveness / error-recovery ====');
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);

  const sid = await mintSession();
  log('SID: ' + sid);

  // ── Stage 1: fresh connect, observe MOTD #1 + cwd=~ ────────────────────
  const s1 = new WsSession(sid);
  await s1.connect();
  await s1.waitForPrompt(8000);
  const banner1 = s1.bannerCount;
  const cwd1 = s1.promptCwd();
  log(`stage 1: bannerCount=${banner1} cwd=${JSON.stringify(cwd1)}`);
  if (banner1 !== 1) fail(`expected MOTD count 1 on first connect, got ${banner1}`);
  if (cwd1 !== '~') fail(`expected cwd '~' on first connect, got ${JSON.stringify(cwd1)}`);

  // ── Stage 2: cd into the seeded app ────────────────────────────────────
  s1.reset();
  s1.send('cd app\r');
  await s1.waitForPrompt(5000);
  const cwd1b = s1.promptCwd();
  log(`stage 2: after 'cd app' cwd=${JSON.stringify(cwd1b)}`);
  if (cwd1b !== '~/app') fail(`expected cwd '~/app' after cd app, got ${JSON.stringify(cwd1b)}`);

  // ── Stage 3: capture isolateGen baseline + reset recovery ring ─────────
  await resetRing(sid);
  const diagBefore = await getDiag(sid);
  const isoBefore = diagBefore?.hib?.isolateGen ?? -1;
  log(`stage 3: isolateGen baseline = ${isoBefore}`);
  log(`stage 3: heap.estimatedBytes = ${diagBefore?.heap?.estimatedBytes ?? '<missing>'}`);
  log(`stage 3: heap.percentOfCeiling = ${diagBefore?.heap?.percentOfCeiling ?? '<missing>'}`);

  // ── Stage 4: synthetic close ──────────────────────────────────────────
  await s1.close();
  log('stage 4: client WS closed (synthetic webSocketError equivalent)');
  await sleep(750);

  // ── Stage 5: reconnect, observe MOTD count + cwd ──────────────────────
  const s2 = new WsSession(sid);
  await s2.connect();
  await s2.waitForPrompt(8000);
  const banner2 = s2.bannerCount;
  const cwd2 = s2.promptCwd();
  const diagAfter = await getDiag(sid);
  const isoAfter = diagAfter?.hib?.isolateGen ?? -1;
  log(`stage 5: bannerCount=${banner2} cwd=${JSON.stringify(cwd2)} isolateGen=${isoAfter}`);

  // ── Architectural assertions ──────────────────────────────────────────
  if (isoAfter !== isoBefore) {
    fail(`isolateGen bumped (${isoBefore} → ${isoAfter}); not a same-isolate recovery test`);
  } else {
    pass(`isolateGen stable at ${isoBefore} across reconnect (same-isolate recovery)`);
  }

  // Track B' green criterion: silent re-init.
  // As of B'.3 (scrollback persistence), the banner from the original
  // cold start is REPLAYED on rehydrate from nimbus_terminal_scrollback.
  // banner=1 = correct ("you see what you saw before"). banner=0 would
  // mean replay missed the banner; banner=2+ would mean Phase O
  // reprinted on top of the replay.
  if (banner2 === 1) {
    pass("banner appears exactly once on rehydrate (replayed via scrollback, not reprinted by Phase O)");
  } else if (banner2 === 0) {
    fail("banner=0 on rehydrate — scrollback replay missed the original MOTD");
  } else {
    fail(`banner=${banner2} on rehydrate — Phase O reprinted on top of replay`);
  }

  // Track B' green criterion: cwd preserved.
  if (cwd2 === '~/app') {
    pass(`cwd preserved as ~/app across reconnect (Track B' invariant)`);
  } else {
    fail(`cwd reset to ${JSON.stringify(cwd2)} (Track B' regression or not yet shipped — should be ~/app)`);
  }

  // Track B' green criterion: recovery events were recorded.
  const events = diagAfter.recoveryEvents || [];
  log(`stage 5: recoveryEvents.length = ${events.length}`);
  if (events.length === 0) {
    fail("no recovery events recorded — Track B' transitions not landed yet OR regression");
  } else {
    // Look for a drained→hydrated pair.
    const drainedIdx = events.findIndex(e => e.toState === 'drained');
    const hydratedIdx = events.findIndex(e => e.toState === 'hydrated');
    if (drainedIdx === -1) {
      fail('no drained transition in recoveryEvents');
    } else {
      pass(`drained transition present (trigger=${events[drainedIdx].trigger})`);
      if (events[drainedIdx].dataLoss === false) {
        pass('drained transition reports dataLoss=false');
      } else {
        fail(`drained transition reports dataLoss=${events[drainedIdx].dataLoss}; expected false`);
      }
    }
    if (hydratedIdx === -1) {
      fail('no hydrated transition in recoveryEvents');
    } else {
      pass(`hydrated transition present (trigger=${events[hydratedIdx].trigger}, snapshotKeysRehydrated=${events[hydratedIdx].snapshotKeysRehydrated})`);
      if (events[hydratedIdx].dataLoss === false) {
        pass('hydrated transition reports dataLoss=false');
      } else {
        fail(`hydrated transition reports dataLoss=${events[hydratedIdx].dataLoss}; expected false`);
      }
    }
    // Newest-first ordering: hydrated MUST come before drained in the
    // ring (because hydrated happened more recently).
    if (drainedIdx !== -1 && hydratedIdx !== -1 && hydratedIdx < drainedIdx) {
      pass('event ordering: hydrated newer than drained (newest-first)');
    } else if (drainedIdx !== -1 && hydratedIdx !== -1) {
      fail('event ordering broken: hydrated should be newer than drained in newest-first ring');
    }
  }

  await s2.close();
  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
