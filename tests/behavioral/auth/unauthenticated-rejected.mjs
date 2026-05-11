#!/usr/bin/env node
// auth/unauthenticated-rejected — verifies that protected /api/* endpoints
// return 401 when called without Authorization, Origin, or Sec-Fetch-Site
// headers (i.e., from a plain curl or SDK without credentials).
//
// Tests:
//   1. POST /api/write-file with no auth → 401
//   2. POST /api/mkdir with no auth → 401
//   3. POST /api/start-vite with no auth → 401
//   4. POST /api/kill/1 with no auth → 401
//   5. POST /api/restart/1 with no auth → 401
//   6. GET /api/processes with no auth → 401
//   7. GET /api/stats with no auth → 401
//
// The session ID used is an arbitrary 12-hex-char placeholder; we don't
// need a real session because auth runs at the Worker entry BEFORE any
// session forwarding. The DO is never reached on 401.

import { BASE, mintSessionWithAuth } from './_auth-helpers.mjs';

// Use an arbitrary syntactically-valid session ID. Auth runs BEFORE
// session DO routing, so we don't need a real session.
const fakeSid = 'aaaaaaaaaaaa';

const probes = [
  { name: 'POST /api/write-file no-auth → 401', method: 'POST', path: '/api/write-file',
    body: JSON.stringify({ path: 'evil.txt', content: 'pwned' }) },
  { name: 'POST /api/mkdir no-auth → 401', method: 'POST', path: '/api/mkdir',
    body: JSON.stringify({ path: 'evildir' }) },
  { name: 'POST /api/start-vite no-auth → 401', method: 'POST', path: '/api/start-vite',
    body: JSON.stringify({}) },
  { name: 'POST /api/kill/1 no-auth → 401', method: 'POST', path: '/api/kill/1', body: '' },
  { name: 'POST /api/restart/1 no-auth → 401', method: 'POST', path: '/api/restart/1', body: '' },
  { name: 'GET /api/processes no-auth → 401', method: 'GET', path: '/api/processes' },
  { name: 'GET /api/stats no-auth → 401', method: 'GET', path: '/api/stats' },
];

const results = [];
for (const p of probes) {
  const url = `${BASE}/s/${fakeSid}${p.path}`;
  const init = { method: p.method, redirect: 'manual' };
  if (p.body !== undefined) {
    init.body = p.body;
    init.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(url, init);
  const got = r.status;
  const ok = got === 401;
  results.push({ name: p.name, status: got, ok });
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${p.name} (got ${got})`);
}

const pass = results.filter((r) => r.ok).length;
const verdict = pass === results.length ? 'GREEN' : 'RED';
console.log(`\n[unauthenticated-rejected] ${verdict} — ${pass}/${results.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
