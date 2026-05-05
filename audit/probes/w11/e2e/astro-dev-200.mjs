// W11 e2e: Astro fixture clone-install-dev cycle hits 200 + marker.

import path from 'node:path';
import {
  skipIfDisabled, newSession, openWs, send, waitFor,
  materializeFixture, fetchPreview, FIXTURES,
} from '../_e2e-driver.mjs';
import { ok, eq, summary } from '../_tap.mjs';

skipIfDisabled('w11/e2e/astro-dev-200');

const FIX = path.join(FIXTURES, 'astro-minimal');
const sid = await newSession();
const ws = await openWs(sid);

await materializeFixture(ws, FIX);
await send(ws, 'cd /home/user/app && npm install', 100);
await waitFor(ws, /added\s+\d+\s+package|up to date/, { timeoutMs: 180_000 });

await send(ws, 'npm run dev', 100);
const bootRes = await waitFor(
  ws,
  /astro\s+v\d|Local\s+http:\/\/|astro\s+\d.*started/i,
  { timeoutMs: 60_000 },
);
ok(`astro dev started (${bootRes.ms}ms)`, bootRes.ok, bootRes.reason);

if (bootRes.ok) {
  const r = await fetchPreview(sid, '/');
  eq('status 200', r.status, 200);
  ok(
    'Astro marker present',
    /<astro-island|data-astro-cid|astro:client/i.test(r.body) ||
      // Plain HTML fallback (no island) — accept the doctype + title we shipped
      /<title>Astro minimal/.test(r.body),
    r.body.slice(0, 400),
  );
}

ws.close();
summary('w11/e2e/astro-dev-200');
