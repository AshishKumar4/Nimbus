// Phase 3 B'.1 functional probe — shell state survives a forced
// webSocketClose + reconnect.
//
// Acceptance bar:
//   - cwd preserved across reconnect (was ~/app pre-close → ~/app post)
//   - env preserved (NIMBUS_TEST=cool stays set)
//   - new connect on same session reuses the persisted state
//   - persisted state is a property of the DO instance (read from
//     /api/_diag/session — a debug endpoint added in B'.1)
//
// Pre-fix: the wsClose handler at src/nimbus-session-ws.ts:165
// nulls self.shell, dropping its in-memory cwd + env. Next /ws
// upgrade builds a fresh Shell with cwd=/home/user (HOME default)
// and the constructor-time env. Cwd reverts to '~'; user env vars lost.
//
// Post-fix: a state-store module persists cwd + env to DO SQLite
// on every prompt cycle (or, if cleaner, debounced after every
// command boundary). Next /ws upgrade reads SQL and constructs the
// fresh Shell with the persisted cwd + env. Cwd survives; env
// survives.
//
// The probe also checks the C'.2 recovery_event ring records the
// transition (drained → hydrated) with dataLoss=false.

import {
  BASE, mintSession, getDiag, WsSession, sleep,
} from '../../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'shell-state-survives-reconnect.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

async function getSessionDebug(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`);
  if (r.status === 404) return null; // endpoint not landed yet
  return r.json();
}

async function main() {
  log("==== B'.1 shell-state-survives-reconnect probe ====");
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);

  const sid = await mintSession();
  log('SID: ' + sid);

  // ── Stage 1: connect, mutate state ──────────────────────────────────────
  const s1 = new WsSession(sid);
  await s1.connect();
  await s1.waitForPrompt(8000);
  log('stage 1: WS open; banner=' + s1.bannerCount);
  if (s1.bannerCount !== 1) fail(`banner count ${s1.bannerCount} (expected 1 on cold start)`);

  s1.reset();
  s1.send('cd app && export NIMBUS_TEST=cool && export NIMBUS_DEBUG_FLAG=on\r');
  await s1.waitForPrompt(5000);
  const cwd1 = s1.promptCwd();
  log('stage 1: post-cd cwd=' + JSON.stringify(cwd1));
  if (cwd1 !== '~/app') fail(`cwd after cd app = ${JSON.stringify(cwd1)} (expected ~/app)`);

  // Verify env via shell echo
  s1.reset();
  s1.send('echo NIMBUS_TEST=$NIMBUS_TEST NIMBUS_DEBUG_FLAG=$NIMBUS_DEBUG_FLAG\r');
  await s1.waitForPrompt(5000);
  if (!s1.buf.includes('NIMBUS_TEST=cool')) {
    fail('env NIMBUS_TEST=cool not set pre-close (test setup broken)');
  } else {
    pass('env NIMBUS_TEST=cool set pre-close');
  }

  // Brief settle so the periodic snapshot runs and writes to SQL.
  await sleep(500);

  // Snapshot the persisted state via debug endpoint.
  const beforeDebug = await getSessionDebug(sid);
  if (!beforeDebug) {
    fail("/api/_diag/session not implemented — B'.1 endpoint missing");
  } else {
    log('stage 1: persisted state pre-close = ' + JSON.stringify(beforeDebug));
    if (beforeDebug.cwd === '/home/user/app') {
      pass('persisted cwd = /home/user/app pre-close');
    } else {
      fail(`persisted cwd = ${JSON.stringify(beforeDebug.cwd)} (expected /home/user/app)`);
    }
    if (beforeDebug.env?.NIMBUS_TEST === 'cool') {
      pass('persisted env.NIMBUS_TEST = cool pre-close');
    } else {
      fail(`persisted env.NIMBUS_TEST = ${JSON.stringify(beforeDebug.env?.NIMBUS_TEST)}`);
    }
  }

  // ── Stage 2: force ws close ────────────────────────────────────────────
  const isoBefore = (await getDiag(sid)).hib.isolateGen;
  await s1.close();
  await sleep(1000);
  const isoAfter = (await getDiag(sid)).hib.isolateGen;
  if (isoAfter !== isoBefore) {
    fail(`isolateGen bumped (${isoBefore} → ${isoAfter}); not a same-isolate test`);
  } else {
    pass(`isolateGen stable at ${isoBefore} across close`);
  }

  // ── Stage 3: reconnect, verify state survived ──────────────────────────
  const s2 = new WsSession(sid);
  await s2.connect();
  await s2.waitForPrompt(8000);
  const banner2 = s2.bannerCount;
  const cwd2 = s2.promptCwd();
  log('stage 3: reconnect banner=' + banner2 + ' cwd=' + JSON.stringify(cwd2));

  // Track B' invariant: MOTD must not be REPRINTED by Phase O on
  // re-init. As of B'.3, scrollback persistence is in place, so the
  // banner from the original cold start is REPLAYED via the
  // scrollback rehydrate path. The right assertion is therefore
  // banner=1 (replayed exactly once, not 0 / not 2). banner=0
  // would mean the scrollback replay missed; banner=2+ would mean
  // Phase O reprinted on top of the replay.
  if (banner2 === 1) {
    pass('banner appears exactly once on rehydrate (replayed via scrollback, not reprinted by Phase O)');
  } else if (banner2 === 0) {
    fail('banner=0 on rehydrate — scrollback replay missed the original MOTD');
  } else {
    fail(`banner=${banner2} on rehydrate — Phase O reprinted on top of replay`);
  }

  // cwd SHOULD be ~/app (the architectural invariant).
  if (cwd2 === '~/app') {
    pass('cwd preserved as ~/app across forced close');
  } else {
    fail(`cwd = ${JSON.stringify(cwd2)} (expected ~/app — state lost)`);
  }

  // env vars should survive too.
  s2.reset();
  s2.send('echo NIMBUS_TEST=$NIMBUS_TEST NIMBUS_DEBUG_FLAG=$NIMBUS_DEBUG_FLAG\r');
  await s2.waitForPrompt(5000);
  if (s2.buf.includes('NIMBUS_TEST=cool')) {
    pass('env NIMBUS_TEST=cool survived reconnect');
  } else {
    fail(`env NIMBUS_TEST not preserved: ${JSON.stringify(s2.buf.slice(-200))}`);
  }
  if (s2.buf.includes('NIMBUS_DEBUG_FLAG=on')) {
    pass('env NIMBUS_DEBUG_FLAG=on survived reconnect');
  } else {
    fail('env NIMBUS_DEBUG_FLAG not preserved');
  }

  // ── Stage 4: recovery_event ring should record the transition ──────────
  const finalDiag = await getDiag(sid);
  const events = finalDiag.recoveryEvents || [];
  const drained = events.find(e => e.toState === 'drained');
  const hydrated = events.find(e => e.toState === 'hydrated');
  log('stage 4: recoveryEvents = ' + JSON.stringify(events));
  if (drained) {
    pass(`drained event recorded (trigger=${drained.trigger}, dataLoss=${drained.dataLoss})`);
    if (drained.dataLoss === false) pass('drained dataLoss=false');
    else fail(`drained dataLoss=${drained.dataLoss}`);
  } else {
    fail('drained event not recorded — wsClose did not transitionTo');
  }
  if (hydrated) {
    pass(`hydrated event recorded (snapshotKeys=${hydrated.snapshotKeysRehydrated})`);
    if (hydrated.dataLoss === false) pass('hydrated dataLoss=false');
    else fail(`hydrated dataLoss=${hydrated.dataLoss}`);
  } else {
    fail('hydrated event not recorded — second connect did not rehydrate from SQL');
  }

  await s2.close();
  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
