// W11 e2e: SvelteKit fixture clone-install-dev cycle hits 200 + marker.
// Self-skip when NIMBUS_W11_E2E unset.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  E2E_ENABLED, skipIfDisabled, newSession, openWs, send, waitFor,
  materializeFixture, fetchPreview, FIXTURES,
} from '../_e2e-driver.mjs';
import { ok, eq, group, summary } from '../_tap.mjs';

skipIfDisabled('w11/e2e/sveltekit-dev-200');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(FIXTURES, 'sveltekit-minimal');

const sid = await newSession();
console.log('# session: ' + sid);
const ws = await openWs(sid);

console.log('# materialize fixture');
await materializeFixture(ws, FIX);

console.log('# npm install');
await send(ws, 'cd /home/user/app && npm install', 100);
const installRes = await waitFor(ws, /added\s+\d+\s+package|up to date/, { timeoutMs: 180_000 });
ok(`npm install completed (${installRes.ms}ms)`, installRes.ok, installRes.reason);

console.log('# npm run dev');
await send(ws, 'npm run dev', 100);
const bootRes = await waitFor(
  ws,
  /VITE\s+v\d|Local:\s+http|ready in\s+\d/,
  { timeoutMs: 60_000 },
);
ok(`dev server reported ready (${bootRes.ms}ms)`, bootRes.ok, bootRes.reason);

if (bootRes.ok) {
  console.log('# GET preview/');
  const r = await fetchPreview(sid, '/');
  eq('status 200', r.status, 200);
  ok(
    'SvelteKit marker present',
    /data-sveltekit-|\.svelte-kit\/|svelte\.config|sveltekit-test-marker/i.test(r.body),
    r.body.slice(0, 400),
  );
}

ws.close();
summary('w11/e2e/sveltekit-dev-200');
