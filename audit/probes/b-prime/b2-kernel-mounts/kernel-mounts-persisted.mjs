// Phase 3 B'.2 probe — kernel mount tree is SQL-backed.
//
// Acceptance bar:
//   - nimbus_kernel_mounts table is populated with the 7 default
//     mount points (DEFAULT_MOUNT_POINTS) after initSession
//   - The /api/_diag/session debug endpoint surfaces the mount list
//   - A future code path that adds a custom mount can write to the
//     same table; the rehydrate path reads + restores it
//
// The architectural intent: even though DEFAULT_MOUNT_POINTS is a
// static constant today, the runtime SHAPE of mount-tree persistence
// matches B'.1's shell-state persistence. A future feature that
// introduces user-controlled mounts (e.g. `mount /r2/<bucket>`) can
// land on a stable storage surface without re-architecting B'.

import {
  BASE, mintSession, WsSession, sleep,
} from '../../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'kernel-mounts-persisted.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

// Source of truth — must stay in sync with src/constants.ts
const EXPECTED_MOUNTS = ['bin', 'etc', 'home', 'tmp', 'var', 'usr', 'opt'];

async function getSessionDebug(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`);
  if (r.status === 404) return null;
  return r.json();
}

async function main() {
  log("==== B'.2 kernel-mounts-persisted probe ====");
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

  const sid = await mintSession();
  log('SID: ' + sid);

  // Reset state-store so we start from cold (this clears any prior probe's
  // mount rows too).
  await fetch(`${BASE}/s/${sid}/api/_test/session/reset`, { method: 'POST' });

  // Initially, with no WS open and no initSession run, mount table is empty.
  let snap = await getSessionDebug(sid);
  if (snap?.mounts && Array.isArray(snap.mounts) && snap.mounts.length === 0) {
    pass('cold session: mount table is empty (no initSession run yet)');
  } else if (snap?.mounts === undefined) {
    fail("/api/_diag/session does not surface .mounts — B'.2 endpoint update missing");
  } else {
    log(`pre-WS mounts: ${JSON.stringify(snap?.mounts)}`);
    fail(`pre-WS expected empty mounts; got ${JSON.stringify(snap?.mounts)}`);
  }

  // Open WS — initSession runs, mounts get persisted.
  const s = new WsSession(sid);
  await s.connect();
  await s.waitForPrompt(8000);
  await sleep(200);

  snap = await getSessionDebug(sid);
  log('post-WS mounts: ' + JSON.stringify(snap?.mounts));

  if (!Array.isArray(snap?.mounts)) {
    fail('mounts is not an array post-WS');
  } else if (snap.mounts.length !== EXPECTED_MOUNTS.length) {
    fail(`mounts.length = ${snap.mounts.length}, expected ${EXPECTED_MOUNTS.length}`);
  } else {
    pass(`mount table populated with ${snap.mounts.length} entries`);
    const got = [...snap.mounts].sort();
    const want = [...EXPECTED_MOUNTS].sort();
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      if (got[i] !== want[i]) { ok = false; break; }
    }
    if (ok) {
      pass(`mounts match DEFAULT_MOUNT_POINTS (${got.join(', ')})`);
    } else {
      fail(`mounts mismatch: got ${JSON.stringify(got)} expected ${JSON.stringify(want)}`);
    }
  }

  // Idempotency: closing + reconnecting does not duplicate or lose entries.
  await s.close();
  await sleep(500);
  const s2 = new WsSession(sid);
  await s2.connect();
  await s2.waitForPrompt(8000);
  await sleep(200);

  snap = await getSessionDebug(sid);
  if (Array.isArray(snap?.mounts) && snap.mounts.length === EXPECTED_MOUNTS.length) {
    pass(`reconnect: mount table still has ${snap.mounts.length} entries (no duplicates)`);
  } else {
    fail(`reconnect: mounts changed unexpectedly: ${JSON.stringify(snap?.mounts)}`);
  }

  await s2.close();
  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
