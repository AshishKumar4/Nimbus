#!/usr/bin/env bun
// hosted-demo-anon-session — both no-login entry points mint a real session
// carrying a sid-pinned `session:attach` token that expires exactly with the
// session: POST /api/demo/anon-session answers the docs terminal with a
// wsUrl, GET /try redirects a browser to the session shell. Per-IP rate
// limiting and the global live-session cap reject both — as structured JSON
// with Retry-After for the API, as a page with a way forward for the
// browser. Anon sessions register the aggressive DEMO_ANON_TTL_SECONDS
// lifetime in the same demo_sessions table, and once expired they ride the
// existing cleanup, destroyed under the disjoint DO name `anon:anon:<sid>`.
//
// D1 is faked over bun:sqlite running the REAL migration SQL (foreign
// keys ON), so schema constraints — including the demo_users FK — are
// exercised for real.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { handleAnonLaunch, handleAnonSessionCreate } from '../../apps/hosted-demo/src/demo-anon.ts';
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

function createTryRequest(headers = { 'CF-Connecting-IP': '203.0.113.7' }) {
  return new Request('https://nimbus.example.com/try', { headers });
}

async function expireSession(env, sessionId) {
  await env.DEMO_DB.prepare('UPDATE demo_sessions SET expires_at = ? WHERE session_id = ?')
    .bind(Date.now() - 1000, sessionId).run();
}

// [1] Happy path: wsUrl targets /s/<sid>/ws with a sid-pinned, session:attach
// token under the disjoint anon principal, expiring with the session; the
// session row registers the anon TTL.
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
  // The router's attach exchange derives the browser cookie's Max-Age from
  // this token's exp, so a token that expired before the session would sign
  // a visitor out of a sandbox that is still running.
  assert.ok(
    Math.abs(verified.claims.exp * 1000 - body.expiresAt) <= 2000,
    'attach token expires with the session it is pinned to, not before',
  );

  const row = await env.DEMO_DB.prepare('SELECT * FROM demo_sessions WHERE session_id = ?')
    .bind(body.sessionId).first();
  assert.equal(row.user_id, ANON_USER_ID);
  assert.equal(row.status, 'active');
  assert.equal(row.expires_at, body.expiresAt);
  assert.equal(row.expires_at - row.created_at, 600_000, 'anon TTL knob registered in D1');
  assert.ok(row.created_at >= before);
  console.log('  [1] happy path: sid-pinned session-length attach token + anon TTL registration');
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

// [8] GET /try — the landing page's no-sign-in path — lands the browser on
// the same session shell a logged-in launch reaches, carrying the attach
// token as the query credential the router's attach exchange consumes.
{
  const env = makeEnv();
  const res = await handleAnonLaunch(createTryRequest(), env);
  assert.equal(res.status, 303, 'a browser navigation gets a redirect, not JSON');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');

  const location = new URL(res.headers.get('Location'), 'https://nimbus.example.com');
  const token = location.searchParams.get('nimbus_token');
  assert.ok(token, 'the redirect carries the attach credential');

  const sessionId = location.pathname.replace(/^\/s\/|\/$/g, '');
  assert.equal(location.pathname, `/s/${sessionId}/`,
    'the target is the session shell root, where the attach exchange runs');

  const verified = await verifyNimbusToken(env, token);
  assert.equal(verified.claims.sid, sessionId, 'token is pinned to the created session');
  assert.deepEqual(verified.claims.scopes, ['session:attach']);
  assert.equal(verified.doInstanceName, 'anon:anon', 'anon principal, disjoint from real users');

  const row = await env.DEMO_DB.prepare('SELECT * FROM demo_sessions WHERE session_id = ?')
    .bind(sessionId).first();
  assert.equal(row.user_id, ANON_USER_ID);
  assert.equal(row.status, 'active');
  assert.ok(
    Math.abs(verified.claims.exp * 1000 - row.expires_at) <= 2000,
    'the cookie the exchange mints will outlast the session, not expire mid-use',
  );
  console.log('  [8] GET /try redirects to the shell with a session-length attach token');
}

// [9] Both rejections render a page with a way forward. A visitor who
// clicked "Try it now" must not get a bare 503 dead end.
{
  const atCapacity = makeEnv({ DEMO_ANON_MAX_ACTIVE: '1' });
  await handleAnonLaunch(createTryRequest(), atCapacity);
  const full = await handleAnonLaunch(createTryRequest(), atCapacity);
  assert.equal(full.status, 503);
  assert.equal(full.headers.get('Retry-After'), '60');
  assert.match(full.headers.get('Content-Type'), /text\/html/);
  const fullBody = await full.text();
  assert.match(fullBody, /href="\/try"/, 'offers a retry');
  assert.match(fullBody, /href="\/login\?return_to=\/new"/, 'offers the durable alternative');

  const limited = makeEnv({ ANON_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  const res = await handleAnonLaunch(createTryRequest(), limited);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  const count = await limited.DEMO_DB.prepare('SELECT COUNT(*) AS n FROM demo_sessions').first();
  assert.equal(count.n, 0, 'no session is created when rate-limited');
  console.log('  [9] /try rejections are HTML pages with a retry and a sign-in route');
}

// [10] Method discipline on the browser entry point.
{
  const env = makeEnv();
  const res = await handleAnonLaunch(
    new Request('https://nimbus.example.com/try', { method: 'POST' }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET');
  console.log('  [10] non-GET /try is rejected with 405');
}

// [11] The landing page OFFERS the anonymous path.
//
// This is the assertion whose absence let `/try` ship and stay
// unreachable: the backend worked the whole time, and the only probe
// that reads the landing page had no opinion about an anonymous action
// existing. It lives in the unit suite deliberately — the behavioral
// probe that follows the whole chain
// (`tests/behavioral/auth/new/hosted-demo-anon-launch.mjs`) needs a
// hosted-demo target and is skipped at `apps/probe`, and a capability
// guarded only by a skippable check is how this hid the first time.
{
  const landing = readFileSync(
    new URL('../../packages/worker/public/index.html', import.meta.url),
    'utf8',
  );
  const dialog = landing.match(/<div class="launch-dialog"[\s\S]*?<\/div>\s*<\/div>/)?.[0];
  assert.ok(dialog, 'landing page has a launch dialog');

  const actions = dialog.match(/<div class="launch-actions">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const anchors = [...actions.matchAll(/<a\b([^>]*)>/g)].map((m) => m[1]);
  const login = anchors.find((attrs) => attrs.includes('id="launch-login"'));
  const anon = anchors.find((attrs) => /href="\/try"/.test(attrs));

  assert.ok(login, 'the modal still offers Cloudflare sign-in');
  assert.match(login, /btn-primary/, 'sign-in is still the primary action');
  assert.ok(anon, 'the modal offers the anonymous /try path');
  assert.doesNotMatch(anon, /btn-primary/, 'the anonymous path reads as secondary');
  assert.match(anon, /btn-ghost/, 'the anonymous path uses the existing secondary button style');

  // Honest about what a free sandbox is, in the wording demo-sessions.ts
  // already uses for exactly this.
  assert.match(dialog, /A free sandbox is ephemeral/,
    'the modal says a free sandbox is ephemeral');
  assert.match(dialog, /is not saved/, 'the modal says it is not saved');
  assert.match(dialog, /Sign in with Cloudflare to keep sandboxes for days/,
    'the modal says what signing in buys');

  // The affordance must not have cost the dialog its accessibility.
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /aria-labelledby="launch-title"/);
  assert.match(dialog, /aria-describedby="[^"]*launch-copy/);
  assert.match(dialog, /id="launch-close"/, 'the close button survives');
  assert.match(dialog, /id="launch-status"[^>]*aria-live="polite"/, 'the live region survives');
  console.log('  [11] the landing modal offers the anonymous path as a secondary action');
}

console.log('hosted-demo-anon-session: all tests passed');
