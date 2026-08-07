/**
 * demo-anon.ts — anonymous ephemeral sessions for the docs live terminal.
 *
 * `POST /api/demo/anon-session` creates a real session with NO login and
 * returns `{ wsUrl }` pointing at the session shell WebSocket
 * (`/s/<sid>/ws`), carrying a short-lived sid-pinned `session:attach`
 * token in the query string — the core router's token extraction honors
 * header → query → cookie on every `/s/<id>/*` route, WS upgrades
 * included, so the URL works for a bare browser `new WebSocket()` call.
 *
 * Abuse control, because this hands out free compute anonymously:
 *   - per-IP rate limit via the platform `ratelimits` binding
 *     (ANON_RATE_LIMITER — limit/period live in wrangler.jsonc);
 *   - a global cap on concurrently live anon sessions
 *     (DEMO_ANON_MAX_ACTIVE), enforced atomically inside the session
 *     INSERT;
 *   - fixed aggressive lifetime (DEMO_ANON_TTL_SECONDS, no idle
 *     extension), riding the same D1 rows + cron cleanup as logged-in
 *     demo sessions, tagged `user_id = 'anon'`.
 *
 * Rejections are structured JSON the docs terminal can show verbatim,
 * with proper status codes and Retry-After.
 */

import { createAnonDemoSession } from './demo-sessions.js';
import { issueAnonAttachToken } from './demo-nimbus.js';

interface AnonRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const RETRY_AFTER_SECONDS = 60;

export async function handleAnonSessionCreate(request: Request, env: any): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
    });
  }

  const limiter: AnonRateLimiter | undefined = env?.ANON_RATE_LIMITER;
  if (!limiter) {
    throw new Error('ANON_RATE_LIMITER ratelimit binding is required for anonymous demo sessions');
  }
  // Checked here rather than where the token is minted, which is after the
  // capacity-guarded INSERT: a deployment without the secret would otherwise
  // leave one live `demo_sessions` row per request, and DEMO_ANON_MAX_ACTIVE
  // slots would drain until their TTL expired.
  if (typeof env?.JWT_SECRET !== 'string' || env.JWT_SECRET.length === 0) {
    throw new Error('JWT_SECRET is required for anonymous demo sessions (set via `wrangler secret put JWT_SECRET`)');
  }
  const { success } = await limiter.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
  if (!success) {
    return anonRejection(429, 'E_ANON_RATE_LIMITED',
      'You are booting computers too quickly — try again in a minute.');
  }

  const session = await createAnonDemoSession(env);
  if (!session) {
    return anonRejection(503, 'E_ANON_AT_CAPACITY',
      'All free computers are busy right now — try again in a minute.');
  }

  const token = await issueAnonAttachToken(env, session);
  return Response.json({
    wsUrl: `/s/${encodeURIComponent(session.sessionId)}/ws?${new URLSearchParams({ nimbus_token: token })}`,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

function anonRejection(status: 429 | 503, code: string, error: string): Response {
  return Response.json({ error, code, retryAfterSeconds: RETRY_AFTER_SECONDS }, {
    status,
    headers: {
      'Retry-After': String(RETRY_AFTER_SECONDS),
      'Cache-Control': 'no-store',
    },
  });
}
