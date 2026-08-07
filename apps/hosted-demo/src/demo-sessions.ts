// Imported via the narrow subpath (not `@nimbus-sh/sdk/worker`) so this
// module stays loadable outside workerd — the full worker barrel imports
// `cloudflare:*` builtins.
import { generateSessionId, isValidSessionId } from '@nimbus-sh/worker/session-id';
import type { DemoAuth } from './demo-auth.js';

/**
 * The single synthetic principal that owns every anonymous docs-terminal
 * session. Real users are always `cf_<hash>`, so it can never collide.
 */
export const ANON_USER_ID = 'anon';

export interface DemoSession {
  sessionId: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  status: 'active' | 'destroying' | 'destroyed' | 'failed';
  destroyedAt: number | null;
  destroyReason: string | null;
}

export interface DemoUserInput {
  userId: string;
  cfSubjectHash: string;
  displayName: string | null;
  now: number;
}

export async function upsertDemoUser(env: any, input: DemoUserInput): Promise<void> {
  const db = demoDb(env);
  await db.prepare(`
    INSERT INTO demo_users (user_id, cf_subject_hash, display_name, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      last_login_at = excluded.last_login_at
  `).bind(
    input.userId,
    input.cfSubjectHash,
    input.displayName,
    input.now,
    input.now,
  ).run();
}

export async function createDemoSession(env: any, auth: DemoAuth, requestedId?: string): Promise<DemoSession> {
  const now = Date.now();
  const expiresAt = now + idleTtlMs(env);
  const db = demoDb(env);
  const attempts = requestedId ? [requestedId] : Array.from({ length: 8 }, () => generateSessionId());

  for (const sessionId of attempts) {
    if (!isValidSessionId(sessionId)) continue;
    try {
      await db.prepare(`
        INSERT INTO demo_sessions (session_id, user_id, created_at, last_seen_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).bind(sessionId, auth.userId, now, now, expiresAt).run();
      return {
        sessionId,
        userId: auth.userId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        status: 'active',
        destroyedAt: null,
        destroyReason: null,
      };
    } catch (e) {
      if (requestedId) throw e;
    }
  }

  throw new Error('Could not allocate a unique Nimbus demo session id');
}

/**
 * Create an anonymous docs-terminal session: fixed lifetime (no idle
 * extension), owned by the synthetic {@link ANON_USER_ID} principal. The
 * global cap on concurrently live anon sessions is enforced atomically by
 * the guarded INSERT — returns null when the cap is reached.
 */
export async function createAnonDemoSession(env: any): Promise<DemoSession | null> {
  const now = Date.now();
  const expiresAt = now + anonTtlMs(env);
  const db = demoDb(env);

  for (let attempt = 0; attempt < 8; attempt++) {
    const sessionId = generateSessionId();
    try {
      const results = await db.batch([
        db.prepare(`
          INSERT OR IGNORE INTO demo_users (user_id, cf_subject_hash, display_name, created_at, last_login_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(ANON_USER_ID, ANON_USER_ID, 'Anonymous (docs terminal)', now, now),
        db.prepare(`
          INSERT INTO demo_sessions (session_id, user_id, created_at, last_seen_at, expires_at, status)
          SELECT ?, ?, ?, ?, ?, 'active'
          WHERE (
            SELECT COUNT(*) FROM demo_sessions
            WHERE user_id = ? AND status = 'active' AND expires_at > ?
          ) < ?
        `).bind(sessionId, ANON_USER_ID, now, now, expiresAt, ANON_USER_ID, now, anonMaxActive(env)),
      ]);
      if (Number(results[1]?.meta?.changes ?? 0) === 0) return null;
      return {
        sessionId,
        userId: ANON_USER_ID,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        status: 'active',
        destroyedAt: null,
        destroyReason: null,
      };
    } catch (e: any) {
      // Retry only on session-id collision; surface everything else.
      if (!/UNIQUE constraint failed/.test(String(e?.message ?? e))) throw e;
    }
  }

  throw new Error('Could not allocate a unique Nimbus demo session id');
}

export async function loadDemoSession(env: any, sessionId: string): Promise<DemoSession | null> {
  if (!isValidSessionId(sessionId)) return null;
  const row = await demoDb(env).prepare(`
    SELECT session_id, user_id, created_at, last_seen_at, expires_at, status, destroyed_at, destroy_reason
    FROM demo_sessions
    WHERE session_id = ?
    LIMIT 1
  `).bind(sessionId).first() as any;
  return row ? rowToDemoSession(row) : null;
}

export async function touchDemoSession(env: any, session: DemoSession): Promise<void> {
  const now = Date.now();
  if (now - session.lastSeenAt < touchDebounceMs(env)) return;
  await demoDb(env).prepare(`
    UPDATE demo_sessions
    SET last_seen_at = ?, expires_at = ?
    WHERE session_id = ? AND user_id = ? AND status = 'active'
  `).bind(now, now + idleTtlMs(env), session.sessionId, session.userId).run();
}

export async function listExpiredDemoSessions(
  env: any,
): Promise<Array<{ sessionId: string; userId: string }>> {
  const limit = cleanupBatchSize(env);
  const now = Date.now();
  const result = await demoDb(env).prepare(`
    SELECT session_id, user_id
    FROM demo_sessions
    WHERE status IN ('active', 'failed')
      AND expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT ?
  `).bind(now, limit).all() as any;
  const rows = Array.isArray(result?.results) ? result.results : [];
  return rows
    .map((row: any) => ({ sessionId: String(row.session_id || ''), userId: String(row.user_id || '') }))
    .filter((row: { sessionId: string; userId: string }) => isValidSessionId(row.sessionId) && !!row.userId);
}

export async function claimDemoSessionForDestroy(
  env: any,
  sessionId: string,
  userId: string,
  reason: string,
): Promise<boolean> {
  const result = await demoDb(env).prepare(`
    UPDATE demo_sessions
    SET status = 'destroying', destroy_reason = ?, destroyed_at = NULL
    WHERE session_id = ?
      AND user_id = ?
      AND status IN ('active', 'failed')
      AND expires_at <= ?
  `).bind(reason, sessionId, userId, Date.now()).run() as any;
  return Number(result?.meta?.changes ?? 0) > 0;
}

export async function markDemoSessionDestroyed(
  env: any,
  sessionId: string,
  reason: string,
): Promise<void> {
  await demoDb(env).prepare(`
    UPDATE demo_sessions
    SET status = 'destroyed', destroyed_at = ?, destroy_reason = ?
    WHERE session_id = ?
  `).bind(Date.now(), reason, sessionId).run();
}

export async function markDemoSessionDestroyFailed(
  env: any,
  sessionId: string,
  reason: string,
): Promise<void> {
  await demoDb(env).prepare(`
    UPDATE demo_sessions
    SET status = 'failed', destroy_reason = ?
    WHERE session_id = ?
  `).bind(reason.slice(0, 500), sessionId).run();
}

export function sessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/s\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return isValidSessionId(id) ? id : null;
  } catch {
    return null;
  }
}

export function renderLaunchPage(auth: DemoAuth | null, env: any): Response {
  if (auth) {
    return demoPage(200, `
      <main>
        <h1>Nimbus</h1>
        <p>Your sandboxes are private to you and last for days.</p>
        <form action="/new" method="POST"><button>Launch a sandbox</button></form>
        <a href="/logout">Sign out</a>
      </main>
    `);
  }
  return demoPage(200, `
    <main>
      <h1>Nimbus</h1>
      <p>A real computer inside a Cloudflare Worker. Start one now — no account, no sign-in.</p>
      <a href="/try">Try it now</a>
      <p class="note">A free sandbox is ephemeral: it runs for about ${anonTtlMinutes(env)} minutes and is not saved. Sign in with Cloudflare to keep sandboxes for days and to run the AI agent on your own account.</p>
      <a href="/login?return_to=/new">Sign in with Cloudflare</a>
    </main>
  `);
}

export function renderExpiredSession(
  sessionId: string,
  options: { anonymous?: boolean } = {},
): Response {
  // An anonymous visitor has no login to return to, so the logged-in
  // "launch another" (POST /new) would bounce them into Cloudflare OAuth —
  // the exact wall the free path exists to avoid.
  const again = options.anonymous
    ? `<a href="/try">Start another</a>
       <p class="note">Free sandboxes are ephemeral by design. Sign in with Cloudflare to keep yours for days.</p>
       <a href="/login?return_to=/new">Sign in with Cloudflare</a>`
    : `<form action="/new" method="POST"><button>Launch a new sandbox</button></form>`;
  return demoPage(410, `
    <main>
      <h1>Session expired</h1>
      <p>This Nimbus sandbox passed its retention window and has been destroyed.</p>
      ${again}
    </main>
  `, { 'X-Nimbus-Expired-Session': sessionId });
}

export function renderForbiddenSession(): Response {
  return demoPage(404, `
    <main>
      <h1>Session not found</h1>
      <p>This sandbox is unavailable for the signed-in user.</p>
    </main>
  `);
}

function rowToDemoSession(row: any): DemoSession {
  return {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    expiresAt: Number(row.expires_at),
    status: String(row.status) as DemoSession['status'],
    destroyedAt: row.destroyed_at == null ? null : Number(row.destroyed_at),
    destroyReason: row.destroy_reason == null ? null : String(row.destroy_reason),
  };
}

function demoDb(env: any): any {
  if (!env?.DEMO_DB) {
    throw new Error('DEMO_DB D1 binding is required for the hosted demo auth pilot');
  }
  return env.DEMO_DB;
}

function idleTtlMs(env: any): number {
  return Math.max(1, envNumber(env, 'DEMO_SESSION_IDLE_TTL_DAYS', 3)) * 24 * 60 * 60 * 1000;
}

function anonTtlMs(env: any): number {
  return Math.max(60, envNumber(env, 'DEMO_ANON_TTL_SECONDS', 600)) * 1000;
}

function anonMaxActive(env: any): number {
  return Math.max(1, Math.floor(envNumber(env, 'DEMO_ANON_MAX_ACTIVE', 10)));
}

/** The ephemeral lifetime, in whole minutes, as told to the visitor. */
function anonTtlMinutes(env: any): number {
  return Math.max(1, Math.round(anonTtlMs(env) / 60_000));
}

function touchDebounceMs(env: any): number {
  return Math.max(0, envNumber(env, 'DEMO_TOUCH_DEBOUNCE_SECONDS', 600)) * 1000;
}

function cleanupBatchSize(env: any): number {
  return Math.max(1, Math.min(500, Math.floor(envNumber(env, 'DEMO_CLEANUP_BATCH_SIZE', 100))));
}

function envNumber(env: Record<string, unknown>, key: string, fallback: number): number {
  const n = Number(env?.[key]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The demo's shared page chrome, used by every server-rendered page here. */
export function demoPage(
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nimbus</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b0b;color:#d8e3dd;font:14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{width:min(420px,calc(100vw - 48px));display:grid;gap:14px}
  h1{margin:0;font-size:22px}
  p{margin:0;color:#91a39a;line-height:1.5}
  p.note{font-size:13px;color:#6f827a}
  form{margin:0}
  button,a{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 14px;border:1px solid #2d3a35;border-radius:6px;background:#111816;color:#9eeac6;text-decoration:none;font:inherit}
  button{cursor:pointer}
</style>
${body}`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
