// W11 e2e: Next.js fixture probe. Per W11 plan §3.5, Next is BLOCKED
// on Phase 1 substrate. This probe records the first failure mode
// honestly — it does NOT assert hard pass. The test passes if we got
// a CLEAR error message (loud-block stub from src/frameworks/next.ts)
// rather than a silent hang.

import path from 'node:path';
import {
  skipIfDisabled, newSession, openWs, send, waitFor,
  materializeFixture, FIXTURES,
} from '../_e2e-driver.mjs';
import { ok, summary } from '../_tap.mjs';

skipIfDisabled('w11/e2e/next-dev-200');

const FIX = path.join(FIXTURES, 'next-minimal');
const sid = await newSession();
const ws = await openWs(sid);

await materializeFixture(ws, FIX);
await send(ws, 'cd /home/user/app && npm install', 100);
const installRes = await waitFor(ws, /added\s+\d+\s+package|up to date|npm ERR/, {
  timeoutMs: 240_000,
});
ok('npm install reached terminal state', installRes.ok, installRes.reason);

await send(ws, 'npm run dev', 100);
const res = await waitFor(
  ws,
  // Either: Next actually started (unexpected for Phase 1, but accept it!)
  // OR: our loud-block stub fired
  /Next\.js\s+\d|Ready in|BLOCKED in Phase 1|next\.js dev server is/i,
  { timeoutMs: 60_000, errorRegex: /^XXXNeverMatchXXX$/ },
);
ok('reached terminal state (boot or block)', res.ok, res.reason);

const snap = ws.snapshot();
const blocked = /BLOCKED in Phase 1|next\.js dev server is/i.test(snap);
const booted = /Next\.js\s+\d|Ready in/i.test(snap);
ok('outcome is loud (blocked or booted)', blocked || booted, snap.slice(-400));

console.log('# next outcome: ' + (booted ? 'BOOTED (unexpected!)' : blocked ? 'BLOCKED (expected)' : 'UNCLEAR'));

ws.close();
summary('w11/e2e/next-dev-200');
