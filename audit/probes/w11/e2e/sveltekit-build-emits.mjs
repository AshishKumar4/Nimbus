// W11 e2e: SvelteKit fixture `vite build` emits a non-empty .svelte-kit
// or build/ directory. Honors MASTER-ROADMAP §W11 "dev, build" line.

import path from 'node:path';
import {
  skipIfDisabled, newSession, openWs, send, waitFor,
  materializeFixture, FIXTURES,
} from '../_e2e-driver.mjs';
import { ok, group, summary } from '../_tap.mjs';

skipIfDisabled('w11/e2e/sveltekit-build-emits');

const FIX = path.join(FIXTURES, 'sveltekit-minimal');
const sid = await newSession();
const ws = await openWs(sid);

await materializeFixture(ws, FIX);
await send(ws, 'cd /home/user/app && npm install', 100);
await waitFor(ws, /added\s+\d+\s+package|up to date/, { timeoutMs: 180_000 });

await send(ws, 'npm run build', 100);
const buildRes = await waitFor(ws, /built in|build complete|done in/i, { timeoutMs: 120_000 });
ok(`build completed (${buildRes.ms}ms)`, buildRes.ok, buildRes.reason);

await send(ws, 'ls -la /home/user/app/.svelte-kit/output 2>/dev/null || ls -la /home/user/app/build 2>/dev/null || echo NO_OUTPUT', 1500);
const out = ws.snapshot();
ok('output directory non-empty', !/NO_OUTPUT/.test(out));

ws.close();
summary('w11/e2e/sveltekit-build-emits');
