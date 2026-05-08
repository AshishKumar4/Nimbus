// Track A e2e probe — replay the user's Bug-C-class flow against
// local wrangler dev.
//
// User's flow:
//   1. cd app
//   2. npm i           (gives the post-install heap state)
//   3. npm run dev     (vite running)
//   4. session lags / DO reset trigger fires
//   5. user-side WS reconnects
//
// Bug C visible symptoms before fix:
//   - welcome banner reprinted
//   - PWD jumped from ~/app back to ~
//
// After Track A:
//   - banner not reprinted (silent re-init flag)
//   - PWD preserved as ~/app (cwd persisted)
//
// Synthetic trigger: client-side ws.close(). Functionally identical
// to webSocketError for self.shell=null path
// (src/nimbus-session-ws.ts:165 vs :221).

import { mintSession, getDiag, WsSession, sleep } from '../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'user-flow-with-reset.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (msg) => { exitCode = 1; log('FAIL: ' + msg); };
const pass = (msg) => { log('PASS: ' + msg); };

async function main() {
  log('==== E2E PROBE: user-flow-with-reset ====');
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

  const sid = await mintSession();
  log('SID: ' + sid);

  // ── Stage 1: cd app + npm install ────────────────────────────────────
  const s1 = new WsSession(sid);
  await s1.connect();
  await s1.waitForPrompt(8000);
  log(`stage 1 connect: bannerCount=${s1.bannerCount} cwd=${JSON.stringify(s1.promptCwd())}`);

  s1.reset();
  s1.send('cd app && npm i\r');
  // Allow generous time for npm install. Some local dev setups are
  // network-slow; if this times out we report the timeout cleanly.
  try {
    await s1.waitFor((b) => /added \d+ packages|up to date|\$ ?$/i.test(b), 180000, 'npm i');
  } catch (e) {
    log('WARN: npm i did not complete cleanly: ' + e.message);
  }
  await s1.waitForPrompt(10000);
  const cwdAfterInstall = s1.promptCwd();
  log(`stage 1 after npm i: cwd=${JSON.stringify(cwdAfterInstall)}`);

  // ── Stage 2: capture isolateGen baseline ─────────────────────────────
  const diagBefore = await getDiag(sid);
  const isoBefore = diagBefore?.hib?.isolateGen ?? -1;
  log(`stage 2 isolateGen baseline: ${isoBefore}`);

  // ── Stage 3: synthetic reset (close client WS) ───────────────────────
  await s1.close();
  log('stage 3: client WS closed (synthetic reset)');
  await sleep(750);

  const diagAfter = await getDiag(sid);
  const isoAfter = diagAfter?.hib?.isolateGen ?? -1;
  log(`stage 3 isolateGen post-close: ${isoAfter}`);
  if (isoAfter !== isoBefore) {
    fail(`isolateGen bumped (${isoBefore} -> ${isoAfter}); not same-isolate path`);
  }

  // ── Stage 4: reconnect ───────────────────────────────────────────────
  const s2 = new WsSession(sid);
  await s2.connect();
  await s2.waitForPrompt(8000);
  const banner2 = s2.bannerCount;
  const cwd2 = s2.promptCwd();
  log(`stage 4 reconnect: bannerCount=${banner2} cwd=${JSON.stringify(cwd2)}`);

  // ── Assertions ───────────────────────────────────────────────────────
  if (banner2 === 0) pass(`MOTD suppressed on silent re-init (banner=0)`);
  else fail(`MOTD reprinted on reconnect (banner=${banner2}; expected 0 for silent re-init)`);

  if (cwd2 === '~/app') pass(`cwd preserved as ~/app across reset`);
  else fail(`cwd reset to ${JSON.stringify(cwd2)} (expected ~/app)`);

  await s2.close();
  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
