#!/usr/bin/env node
// auth/key-create-list-revoke — CRUD lifecycle of an API key.
//
// Steps:
//   1. /auth/keys/list (admin) — record baseline count
//   2. /auth/keys/create — mint a key; assert response shape
//   3. /auth/keys/list — new key appears, plaintext NOT included
//   4. Use the new key to call /api/mkdir (validate auth path)
//   5. /auth/keys/revoke — revoke it
//   6. /auth/keys/list — key still appears with revokedAt set
//   7. Try /api/mkdir with revoked key → 401

import { BASE, ADMIN_KEY, mintKey, revokeKey, mintSessionWithAuth } from './_auth-helpers.mjs';

if (!ADMIN_KEY) {
  console.error('NIMBUS_ADMIN_KEY env var required');
  process.exit(2);
}

const auth = { 'Authorization': `Bearer ${ADMIN_KEY}` };
const jsonAuth = { ...auth, 'Content-Type': 'application/json' };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${ok ? '' : (detail ? ' — ' + detail : '')}`);
}

const sid = await mintSessionWithAuth();
console.log(`[key-create-list-revoke] sid=${sid}`);

// 1. baseline list
let baselineCount = 0;
{
  const r = await fetch(`${BASE}/auth/keys/list`, { headers: auth });
  check('GET /auth/keys/list (baseline) → 200', r.ok, `status ${r.status}`);
  if (r.ok) {
    const data = await r.json();
    baselineCount = Array.isArray(data.keys) ? data.keys.length : -1;
    check('baseline returns {keys: Array}', baselineCount >= 0);
  }
}

// 2. create
const probeName = 'lifecycle-' + Date.now();
let createdId = null;
let createdKey = null;
{
  const r = await fetch(`${BASE}/auth/keys/create`, {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ name: probeName }),
  });
  check('POST /auth/keys/create → 200', r.ok, `status ${r.status}`);
  if (r.ok) {
    const data = await r.json();
    createdId = data.keyId;
    createdKey = data.key;
    check('response has keyId', typeof createdId === 'string' && createdId.length > 0);
    check('response has plaintext key', typeof createdKey === 'string' && createdKey.startsWith('nimbus_'));
    check('key matches expected format nimbus_<32hex>', /^nimbus_[0-9a-f]{32}$/.test(createdKey || ''),
          `got ${createdKey}`);
  }
}

// 3. list again — new key appears
{
  const r = await fetch(`${BASE}/auth/keys/list`, { headers: auth });
  if (r.ok) {
    const data = await r.json();
    const found = (data.keys || []).find((k) => k.keyId === createdId);
    check('new key appears in list', !!found);
    check('list entry has name', found && found.name === probeName);
    check('list entry has no plaintext', found && !('key' in found) && !('hashedKey' in found));
  }
}

// 4. use it
{
  const r = await fetch(`${BASE}/s/${sid}/api/mkdir`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${createdKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'created-key-test' }),
  });
  check('created key authorizes /api/mkdir → 200', r.ok, `status ${r.status}`);
}

// 5. revoke
{
  const r = await fetch(`${BASE}/auth/keys/revoke`, {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ keyId: createdId }),
  });
  check('POST /auth/keys/revoke → 200', r.ok, `status ${r.status}`);
}

// 6. list shows revokedAt
{
  const r = await fetch(`${BASE}/auth/keys/list`, { headers: auth });
  if (r.ok) {
    const data = await r.json();
    const found = (data.keys || []).find((k) => k.keyId === createdId);
    check('revoked key still in list', !!found);
    check('revoked key has revokedAt set', found && typeof found.revokedAt === 'number' && found.revokedAt > 0);
  }
}

// 7. revoked key fails
{
  const r = await fetch(`${BASE}/s/${sid}/api/mkdir`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${createdKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'should-fail' }),
  });
  check('revoked key → 401 on /api/mkdir', r.status === 401, `got ${r.status}`);
}

const pass = results.filter((r) => r.ok).length;
const verdict = pass === results.length ? 'GREEN' : 'RED';
console.log(`\n[key-create-list-revoke] ${verdict} — ${pass}/${results.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
