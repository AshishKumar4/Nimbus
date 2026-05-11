#!/usr/bin/env node
// auth/bearer-invalid-rejected — verifies that a malformed or revoked
// Bearer token is rejected with 401 or 403.
//
// Tests:
//   1. POST /api/mkdir with random gibberish Bearer → 401
//   2. POST /api/mkdir with empty Bearer → 401
//   3. POST /api/mkdir with prefix-only "Bearer " → 401
//   4. POST /api/mkdir with Bearer using a key we just revoked → 401
//   5. POST /auth/keys/create with WRONG admin key → 401

import { BASE, ADMIN_KEY, mintKey, revokeKey, mintSessionWithAuth } from './_auth-helpers.mjs';

if (!ADMIN_KEY) {
  console.error('NIMBUS_ADMIN_KEY env var required');
  process.exit(2);
}

const sid = await mintSessionWithAuth();
console.log(`[bearer-invalid-rejected] sid=${sid}`);

const results = [];

async function tryMkdir(headers, label, expectStatus = 401) {
  const r = await fetch(`${BASE}/s/${sid}/api/mkdir`, {
    method: 'POST', headers,
    body: JSON.stringify({ path: 'reject-test' }),
  });
  const ok = r.status === expectStatus;
  results.push({ name: label, ok, status: r.status });
}

// 1. gibberish
await tryMkdir({
  'Authorization': 'Bearer nimbus_deadbeefdeadbeefdeadbeefdeadbeef',
  'Content-Type': 'application/json',
}, 'gibberish bearer → 401', 401);

// 2. empty
await tryMkdir({
  'Authorization': 'Bearer ',
  'Content-Type': 'application/json',
}, 'empty bearer → 401', 401);

// 3. prefix-only "Bearer"
await tryMkdir({
  'Authorization': 'Bearer',
  'Content-Type': 'application/json',
}, 'Bearer-no-space → 401', 401);

// 4. revoked
const { keyId, key } = await mintKey('to-revoke');
const revoked = await revokeKey(keyId);
results.push({ name: 'revoke API ack', ok: revoked === true });
await tryMkdir({
  'Authorization': `Bearer ${key}`,
  'Content-Type': 'application/json',
}, 'revoked bearer → 401', 401);

// 5. wrong admin key
{
  const r = await fetch(`${BASE}/auth/keys/create`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer nimbus_wrongadmin000000000000000000000000',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'should-fail' }),
  });
  results.push({ name: 'wrong admin key on /auth/keys/create → 401', ok: r.status === 401, status: r.status });
}

let pass = 0;
for (const r of results) {
  console.log(`  ${r.ok ? '✓ PASS' : '✗ FAIL'}  ${r.name}${r.status !== undefined ? ` (got ${r.status})` : ''}`);
  if (r.ok) pass++;
}
const verdict = pass === results.length ? 'GREEN' : 'RED';
console.log(`\n[bearer-invalid-rejected] ${verdict} — ${pass}/${results.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
