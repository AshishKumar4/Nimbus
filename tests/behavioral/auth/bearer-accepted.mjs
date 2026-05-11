#!/usr/bin/env node
// auth/bearer-accepted — verifies that a valid Bearer token unlocks
// protected /api/* endpoints.
//
// Tests:
//   1. POST /new with Bearer → 302 (session minted)
//   2. POST /api/mkdir on that session with Bearer → 200 (creates dir)
//   3. POST /api/write-file with Bearer → 200 (writes file)
//   4. GET  /api/processes with Bearer → 200 (lists)
//   5. GET  /api/stats with Bearer → 200
//
// All requests use the ADMIN_KEY (the bootstrap key) directly — this
// also confirms the admin path works as a Bearer token for /api/*.

import { BASE, ADMIN_KEY, mintSessionWithAuth } from './_auth-helpers.mjs';

if (!ADMIN_KEY) {
  console.error('NIMBUS_ADMIN_KEY env var required');
  process.exit(2);
}

const auth = { 'Authorization': `Bearer ${ADMIN_KEY}` };
const jsonAuth = { ...auth, 'Content-Type': 'application/json' };

const sid = await mintSessionWithAuth();
console.log(`[bearer-accepted] sid=${sid} BASE=${BASE}`);

const results = [];

// 1. /new (already done; mintSessionWithAuth returns sid only on success).
// Session IDs are `<adj>-<noun>-<4-digit>` so we just assert it's a
// non-empty string and contains two hyphens.
results.push({
  name: 'POST /new with Bearer → 302',
  ok: typeof sid === 'string' && sid.split('-').length === 3,
});

// 2. /api/mkdir
{
  const r = await fetch(`${BASE}/s/${sid}/api/mkdir`, {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ path: 'auth-probe-dir' }),
  });
  const ok = r.ok;
  results.push({ name: 'POST /api/mkdir Bearer → 200', ok, status: r.status });
}

// 3. /api/write-file
{
  const r = await fetch(`${BASE}/s/${sid}/api/write-file`, {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ path: 'auth-probe-dir/x.txt', content: 'hello' }),
  });
  const ok = r.ok;
  results.push({ name: 'POST /api/write-file Bearer → 200', ok, status: r.status });
}

// 4. /api/processes
{
  const r = await fetch(`${BASE}/s/${sid}/api/processes`, { method: 'GET', headers: auth });
  const ok = r.ok;
  results.push({ name: 'GET /api/processes Bearer → 200', ok, status: r.status });
}

// 5. /api/stats
{
  const r = await fetch(`${BASE}/s/${sid}/api/stats`, { method: 'GET', headers: auth });
  const ok = r.ok;
  results.push({ name: 'GET /api/stats Bearer → 200', ok, status: r.status });
}

let pass = 0;
for (const r of results) {
  console.log(`  ${r.ok ? '✓ PASS' : '✗ FAIL'}  ${r.name}${r.status ? ` (got ${r.status})` : ''}`);
  if (r.ok) pass++;
}
const verdict = pass === results.length ? 'GREEN' : 'RED';
console.log(`\n[bearer-accepted] ${verdict} — ${pass}/${results.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
