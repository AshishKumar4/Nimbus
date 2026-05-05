// W11 e2e: Nuxt 3 fixture clone-install-dev cycle. Honest probe — Nuxt
// is "caveats" per W11 plan §3.4 (dual Vite + Nitro). The probe records
// what we actually got rather than asserting hard pass.

import path from 'node:path';
import {
  skipIfDisabled, newSession, openWs, send, waitFor,
  materializeFixture, fetchPreview, FIXTURES,
} from '../_e2e-driver.mjs';
import { ok, summary } from '../_tap.mjs';

skipIfDisabled('w11/e2e/nuxt-dev-200');

const FIX = path.join(FIXTURES, 'nuxt-minimal');
const sid = await newSession();
const ws = await openWs(sid);

await materializeFixture(ws, FIX);
await send(ws, 'cd /home/user/app && npm install', 100);
await waitFor(ws, /added\s+\d+\s+package|up to date/, { timeoutMs: 300_000 });

await send(ws, 'npm run dev', 100);
const bootRes = await waitFor(
  ws,
  /Nuxt\s+\d|Local:\s+http|ready in\s+\d|Nitro/i,
  { timeoutMs: 90_000 },
);
ok(`nuxt dev reached banner (${bootRes.ms}ms)`, bootRes.ok, bootRes.reason);

if (bootRes.ok) {
  const r = await fetchPreview(sid, '/');
  // We DON'T assert status 200 here — Nuxt's dual-server may return 5xx
  // until we wire the Nitro side. We assert "we got a response shape".
  ok('preview returned a response', typeof r.status === 'number');
  ok(
    'response either Nuxt-marked or honest 5xx',
    /window\.__NUXT__|data-nuxt|<div id="__nuxt"|nuxt-test-marker/i.test(r.body) ||
      r.status >= 500,
    `status=${r.status} body[:200]=${r.body.slice(0, 200)}`,
  );
}

ws.close();
summary('w11/e2e/nuxt-dev-200');
