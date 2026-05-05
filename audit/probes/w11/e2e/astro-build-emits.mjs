// W11 e2e: Astro fixture `astro build` emits a non-empty dist/.

import path from 'node:path';
import {
  skipIfDisabled, newSession, openWs, send, waitFor,
  materializeFixture, FIXTURES,
} from '../_e2e-driver.mjs';
import { ok, summary } from '../_tap.mjs';

skipIfDisabled('w11/e2e/astro-build-emits');

const FIX = path.join(FIXTURES, 'astro-minimal');
const sid = await newSession();
const ws = await openWs(sid);

await materializeFixture(ws, FIX);
await send(ws, 'cd /home/user/app && npm install', 100);
await waitFor(ws, /added\s+\d+\s+package|up to date/, { timeoutMs: 180_000 });

await send(ws, 'npm run build', 100);
const buildRes = await waitFor(ws, /Complete!|done in|built in/i, { timeoutMs: 180_000 });
ok(`astro build completed (${buildRes.ms}ms)`, buildRes.ok, buildRes.reason);

await send(ws, 'ls /home/user/app/dist 2>/dev/null || echo NO_OUTPUT', 1500);
ok('dist directory non-empty', !/NO_OUTPUT/.test(ws.snapshot()));

ws.close();
summary('w11/e2e/astro-build-emits');
