#!/usr/bin/env bun
// hosted-demo-anon-session — POST /api/demo/anon-session mints a real
// session with no login and returns a wsUrl carrying a sid-pinned,
// short-TTL `session:attach` token; per-IP rate limiting and the global
// live-session cap reject with structured JSON + Retry-After; anon
// sessions register the aggressive DEMO_ANON_TTL_SECONDS lifetime in the
// same demo_sessions table; and once expired they ride the existing
// cleanup, destroyed under the disjoint DO name `anon:anon:<sid>`.
//
// D1 is faked over bun:sqlite running the REAL migration SQL (foreign
// keys ON), so schema constraints — including the demo_users FK — are
// exercised for real.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { handleAnonSessionCreate } from '../../apps/hosted-demo/src/demo-anon.ts';
import {
  ANON_USER_ID,
  createAnonDemoSession,
  listExpiredDemoSessions,
  loadDemoSession,
} from '../../apps/hosted-demo/src/demo-sessions.ts';
import { demoSandboxPrincipal } from '../../apps/hosted-demo/src/demo-nimbus.ts';
import { cleanupExpiredDemoSessions } from '../../apps/hosted-demo/src/demo-cleanup.ts';
import { verifyNimbusToken } from '../../packages/worker/src/auth/index.ts';

const MIGRATION_SQL = readFileSync(
  new URL('../../apps/hosted-demo/migrations/0001_demo_auth.sql', import.meta.url),
  'utf8',
);

function createFakeD1() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIGRATION_SQL);
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: info.changes } };
    },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      const results = [];
      db.exec('BEGIN');
      try {
        for (const s of statements) results.push(await s.run());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return results;
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    DEMO_DB: createFakeD1(),
    JWT_SECRET: 'unit-test-secret-0123456789abcdef0123456789abcdef',
    ANON_RATE_LIMITER: { limit: async () => ({ success: true }) },
    DEMO_ANON_TTL_SECONDS: '600',
    DEMO_ANON_MAX_ACTIVE: '10',
    ...overrides,
  };
}

function createRequest(headers = { 'CF-Connecting-IP': '203.0.113.7' }) {
  return new Request('https://nimbus.example.com/api/demo/anon-session', {
    method: 'POST',
    headers,
  });
}

async function expireSession(env, sessionId) {
  await env.DEMO_DB.prepare('UPDATE demo_sessions SET expires_at = ? WHERE session_id = ?')
    .bind(Date.now() - 1000, sessionId).run();
}

// [1] Happy path: wsUrl targets /s/<sid>/ws with a sid-pinned, session:attach,
// short-TTL token under the disjoint anon principal; the session row registers
// the anon TTL.
{
  const env = makeEnv();
  const before = Date.now();
  const res = await handleAnonSessionCreate(createRequest(), env);
  assert.equal(res.status, 200);
  const body = await res.json();

  const wsUrl = new URL(body.wsUrl, 'https://nimbus.example.com/api/demo/anon-session');
  assert.equal(wsUrl.pathname, `/s/${body.sessionId}/ws`);
  const token = wsUrl.searchParams.get('nimbus_token');
  assert.ok(token, 'wsUrl carries a nimbus_token query credential');

  const verified = await verifyNimbusToken(env, token);
  assert.equal(verified.claims.tn, 'anon');
  assert.equal(verified.claims.sub, ANON_USER_ID);
  assert.equal(verified.claims.sid, body.sessionId, 'token is pinned to the created session');
  assert.deepEqual(verified.claims.scopes, ['session:attach'], 'no session:create handed to the client');
  assert.equal(verified.doInstanceName, 'anon:anon');
  assert.ok(
    (verified.claims.exp - verified.claims.iat) * 1000 <= 120_000,
    'attach token is short-lived (<= 2 minutes)',
  );

  const row = await env.DEMO_DB.prepare('SELECT * FROM demo_sessions WHERE session_id = ?')
    .bind(body.sessionId).first();
  assert.equal(row.user_id, ANON_USER_ID);
  assert.equal(row.status, 'active');
  assert.equal(row.expires_at, body.expiresAt);
  assert.equal(row.expires_at - row.created_at, 600_000, 'anon TTL knob registered in D1');
  assert.ok(row.created_at >= before);
  console.log('  [1] happy path: sid-pinned short-TTL attach token + anon TTL registration');
}

// [2] Method discipline: only POST creates sessions.
{
  const env = makeEnv();
  const res = await handleAnonSessionCreate(
    new Request('https://nimbus.example.com/api/demo/anon-session'), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'POST');
  console.log('  [2] non-POST is rejected with 405');
}

// [3] Rate limit rejection: keyed by connecting IP, structured JSON, 429 +
// Retry-After, and no session row is created.
{
  const keys = [];
  const env = makeEnv({
    ANON_RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } },
  });
  const res = await handleAnonSessionCreate(createRequest({ 'CF-Connecting-IP': '198.51.100.9' }), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  const body = await res.json();
  assert.equal(body.code, 'E_ANON_RATE_LIMITED');
  assert.equal(typeof body.error, 'string');
  assert.equal(body.retryAfterSeconds, 60);
  assert.deepEqual(keys, ['198.51.100.9'], 'limiter is keyed by CF-Connecting-IP');
  const count = await env.DEMO_DB.prepare('SELECT COUNT(*) AS n FROM demo_sessions').first();
  assert.equal(count.n, 0, 'no session is created when rate-limited');
  console.log('  [3] per-IP rate limit rejects with 429 + Retry-After and creates nothing');
}

// [4] Capacity: the cap counts only live anon sessions and is enforced
// atomically in the insert; expired sessions free their slot.
{
  const env = makeEnv({ DEMO_ANON_MAX_ACTIVE: '2' });
  const first = await (await handleAnonSessionCreate(createRequest(), env)).json();
  const second = await handleAnonSessionCreate(createRequest(), env);
  assert.equal(second.status, 200);

  const rejected = await handleAnonSessionCreate(createRequest(), env);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get('Retry-After'), '60');
  const body = await rejected.json();
  assert.equal(body.code, 'E_ANON_AT_CAPACITY');
  assert.equal(body.retryAfterSeconds, 60);
  assert.match(body.error, /busy/);

  await expireSession(env, first.sessionId);
  const afterExpiry = await handleAnonSessionCreate(createRequest(), env);
  assert.equal(afterExpiry.status, 200, 'expired anon sessions do not count toward the cap');
  console.log('  [4] global cap rejects with 503 + Retry-After; expired sessions free slots');
}

// [5] Cleanup: expired anon sessions are picked up by the existing sweep and
// destroyed under the anon:anon:<sid> DO name with reason anon-ttl —
// alongside (not instead of) expired logged-in sessions under demo:<user>.
{
  const env = makeEnv();
  const anon = await createAnonDemoSession(env);
  assert.ok(anon, 'creation succeeds under default knobs');
  const now = Date.now();
  await env.DEMO_DB.prepare(`
    INSERT INTO demo_users (user_id, cf_subject_hash, display_name, created_at, last_login_at)
    VALUES ('cf_test', 'hash_test', 'Real User', ?, ?)
  `).bind(now, now).run();
  await env.DEMO_DB.prepare(`
    INSERT INTO demo_sessions (session_id, user_id, created_at, last_seen_at, expires_at, status)
    VALUES ('owned-session-1234', 'cf_test', ?, ?, ?, 'active')
  `).bind(now, now, now - 1000).run();
  await expireSession(env, anon.sessionId);

  const expired = await listExpiredDemoSessions(env);
  assert.deepEqual(
    new Set(expired.map((r) => `${r.userId}/${r.sessionId}`)),
    new Set([`${ANON_USER_ID}/${anon.sessionId}`, 'cf_test/owned-session-1234']),
    'the one cleanup query picks up expired anon AND owned sessions',
  );

  const destroys = [];
  env.NIMBUS_SESSION = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      _rpcDestroy: async (options) => {
        destroys.push({ doName: id.name, reason: options?.reason });
        return { ok: true, killed: 0, destroyedAt: Date.now(), reason: options?.reason ?? null };
      },
    }),
  };
  const result = await cleanupExpiredDemoSessions(env, { sandboxes: { default: { root: '/home/user' } } });
  assert.deepEqual(result, { scanned: 2, claimed: 2, destroyed: 2, failed: 0 });
  assert.deepEqual(
    new Set(destroys.map((d) => `${d.doName} (${d.reason})`)),
    new Set([
      `anon:anon:${anon.sessionId} (anon-ttl)`,
      'demo:cf_test:owned-session-1234 (demo-idle-ttl)',
    ]),
    'destroy targets the per-class DO names with per-class reasons',
  );

  const anonRow = await loadDemoSession(env, anon.sessionId);
  assert.equal(anonRow.status, 'destroyed');
  assert.equal(anonRow.destroyReason, 'anon-ttl');
  console.log('  [5] expired anon sessions ride the existing cleanup under anon:anon:<sid>');
}

// [6] Principal mapping stays disjoint between anon and real users.
{
  assert.deepEqual(demoSandboxPrincipal(ANON_USER_ID), { tenant: 'anon', subject: 'anon' });
  assert.deepEqual(demoSandboxPrincipal('cf_abc123'), { tenant: 'demo', subject: 'cf_abc123' });
  console.log('  [6] sandbox principals: anon:anon vs demo:<user> never collide');
}

// [7] A deployment without JWT_SECRET fails loudly and consumes no capacity.
// The token mint runs after the capacity-guarded INSERT, so a secret checked
// only at mint time would burn a live slot on every request until its TTL.
{
  const env = makeEnv({ JWT_SECRET: undefined });
  await assert.rejects(
    () => handleAnonSessionCreate(createRequest(), env),
    /JWT_SECRET/,
    'the missing secret surfaces as a thrown configuration error',
  );
  const count = await env.DEMO_DB.prepare('SELECT COUNT(*) AS n FROM demo_sessions').first();
  assert.equal(count.n, 0, 'no anon slot is consumed when the secret is missing');
  console.log('  [7] missing JWT_SECRET throws before any session row is created');
}

console.log('hosted-demo-anon-session: all tests passed');
