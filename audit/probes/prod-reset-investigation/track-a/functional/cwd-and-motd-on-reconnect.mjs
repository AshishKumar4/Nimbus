// Track A functional probe — cwd persists + MOTD does NOT reprint
// across a same-isolate WS reconnect.
//
// Trigger model: the user's reported Bug C reset is a `webSocketError`
// nulling self.shell. We reproduce a FUNCTIONALLY-IDENTICAL state by
// closing the client WS — `webSocketClose` runs the same null-out path
// (src/nimbus-session-ws.ts:165 vs :221). Both routes leave shell=null
// in a non-restarted DO. After fix:
//   1. cwd from before the close is restored on the new shell
//   2. MOTD is NOT reprinted (silent re-init, same isolate)
//
// PRE-FIX (red): cwd resets to ~ AND MOTD reprints.
// POST-FIX (green): cwd is ~/app AND MOTD count stays at 1.
//
// Asserts isolateGen does NOT bump — confirms we're testing the
// same-isolate path (the post-WS-error re-init), not a cold start.

import { mintSession, getDiag, WsSession, sleep, strip } from '../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'cwd-and-motd-on-reconnect.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (msg) => { exitCode = 1; log('FAIL: ' + msg); };
const pass = (msg) => { log('PASS: ' + msg); };

async function main() {
  log('==== FUNCTIONAL PROBE: cwd-and-motd-on-reconnect ====');
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

  const sid = await mintSession();
  log('SID: ' + sid);

  // ── First connect ────────────────────────────────────────────────────
  const s1 = new WsSession(sid);
  await s1.connect();
  await s1.waitForPrompt(8000);
  const banner1 = s1.bannerCount;
  const cwd1 = s1.promptCwd();
  log(`first connect: bannerCount=${banner1} cwd=${JSON.stringify(cwd1)}`);
  if (banner1 !== 1) fail(`expected MOTD count 1 on first connect, got ${banner1}`);
  if (cwd1 !== '~') fail(`expected cwd '~' on first connect, got ${JSON.stringify(cwd1)}`);

  // ── Change cwd ───────────────────────────────────────────────────────
  s1.reset();
  s1.send('mkdir -p app && cd app\r');
  await s1.waitForPrompt(5000);
  const cwd1b = s1.promptCwd();
  log(`after cd app: cwd=${JSON.stringify(cwd1b)}`);
  if (cwd1b !== '~/app') fail(`expected cwd '~/app' after cd app, got ${JSON.stringify(cwd1b)}`);

  // Snapshot isolateGen before disconnect
  const diagBefore = await getDiag(sid);
  const isoBefore = diagBefore?.hib?.isolateGen ?? -1;
  log(`isolateGen before disconnect: ${isoBefore}`);

  // ── Disconnect (triggers wsClose → self.shell=null) ──────────────────
  await s1.close();
  log('s1 closed');
  await sleep(500);

  // Confirm isolateGen unchanged — same isolate
  const diagBetween = await getDiag(sid);
  const isoBetween = diagBetween?.hib?.isolateGen ?? -1;
  log(`isolateGen after disconnect: ${isoBetween}`);
  if (isoBetween !== isoBefore) {
    fail(`isolateGen bumped (${isoBefore} -> ${isoBetween}); not same-isolate test`);
  }

  // ── Reconnect ────────────────────────────────────────────────────────
  const s2 = new WsSession(sid);
  await s2.connect();
  await s2.waitForPrompt(8000);
  const banner2 = s2.bannerCount;
  const cwd2 = s2.promptCwd();
  log(`second connect: bannerCount=${banner2} cwd=${JSON.stringify(cwd2)}`);

  // ── Assertions ───────────────────────────────────────────────────────
  if (banner2 === 0) pass(`MOTD suppressed on silent re-init (bannerCount=0)`);
  else fail(`MOTD reprinted on same-isolate re-init (bannerCount=${banner2}; expected 0)`);

  if (cwd2 === '~/app') pass(`cwd preserved across re-init (cwd=~/app)`);
  else fail(`cwd reset to ${JSON.stringify(cwd2)} (expected ~/app)`);

  await s2.close();
  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
