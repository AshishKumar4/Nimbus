// Track A regression probe — cold-start MUST still print MOTD.
//
// The MOTD-suppression gate must NOT break the cold path. Every
// fresh isolate (or fresh DO instance, since wrangler dev gives a
// new isolate per session) MUST emit MOTD on the very first
// initSession invocation. This probe protects against a
// gate-too-aggressive regression.
//
// PASS criteria: a brand-new session shows bannerCount === 1.
// FAIL criteria: bannerCount === 0 on first connect ⇒ MOTD lost.

import { mintSession, WsSession } from '../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'cold-start-prints-motd.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (msg) => { exitCode = 1; log('FAIL: ' + msg); };
const pass = (msg) => { log('PASS: ' + msg); };

async function main() {
  log('==== REGRESSION PROBE: cold-start-prints-motd ====');
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

  // Three back-to-back fresh sessions; each MUST print MOTD on its
  // first connect. Even within the same wrangler-dev isolate, every
  // new SID has a new DO instance ⇒ a new isolate-scoped flag ⇒
  // MOTD must print.
  for (let i = 0; i < 3; i++) {
    const sid = await mintSession();
    log(`trial ${i + 1} SID: ${sid}`);
    const s = new WsSession(sid);
    await s.connect();
    await s.waitForPrompt(8000);
    const banner = s.bannerCount;
    log(`trial ${i + 1}: bannerCount=${banner}`);
    if (banner === 1) pass(`trial ${i + 1}: MOTD printed on cold start`);
    else fail(`trial ${i + 1}: bannerCount=${banner} (expected 1)`);
    await s.close();
  }

  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
