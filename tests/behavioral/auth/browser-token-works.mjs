#!/usr/bin/env node
// auth/browser-token-works — verifies that same-origin browser-style
// requests (with Sec-Fetch-Site: same-origin OR Origin matching Host)
// bypass the Bearer requirement.
//
// Tests (NO Authorization header):
//   1. Same-origin via Sec-Fetch-Site: same-origin → 200
//   2. Same-origin via Origin: https://<HOST> → 200
//   3. Cross-origin (Sec-Fetch-Site: cross-site) → 401
//   4. Origin mismatch (Origin: https://attacker.example) → 401

import { BASE, ADMIN_KEY, mintSessionWithAuth } from './_auth-helpers.mjs';

if (!ADMIN_KEY) {
  console.error('NIMBUS_ADMIN_KEY env var required');
  process.exit(2);
}

const sid = await mintSessionWithAuth();
const host = new URL(BASE).host;
const scheme = new URL(BASE).protocol; // 'https:' or 'http:'
const sameOrigin = `${scheme}//${host}`;
console.log(`[browser-token-works] sid=${sid} same-origin=${sameOrigin}`);

const results = [];

async function tryMkdir(headers, label, expectStatus) {
  const r = await fetch(`${BASE}/s/${sid}/api/mkdir`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'browser-test-' + Math.random().toString(36).slice(2, 8) }),
  });
  const ok = r.status === expectStatus;
  results.push({ name: label, ok, status: r.status });
}

// 1. Sec-Fetch-Site: same-origin (Chrome/Firefox auto-set)
await tryMkdir({ 'Sec-Fetch-Site': 'same-origin' }, 'Sec-Fetch-Site:same-origin → 200', 200);

// 2. Origin matching Host (legacy browsers + some WS upgrades)
await tryMkdir({ 'Origin': sameOrigin }, `Origin:${sameOrigin} → 200`, 200);

// 3. Sec-Fetch-Site: cross-site (browser sets this on third-party origin)
await tryMkdir({ 'Sec-Fetch-Site': 'cross-site' }, 'Sec-Fetch-Site:cross-site → 401', 401);

// 4. Origin pointing at a different host
await tryMkdir({ 'Origin': 'https://attacker.example' }, 'Origin:attacker.example → 401', 401);

let pass = 0;
for (const r of results) {
  console.log(`  ${r.ok ? '✓ PASS' : '✗ FAIL'}  ${r.name} (got ${r.status})`);
  if (r.ok) pass++;
}
const verdict = pass === results.length ? 'GREEN' : 'RED';
console.log(`\n[browser-token-works] ${verdict} — ${pass}/${results.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
