/**
 * demo-anon.ts — anonymous ephemeral sessions: a real sandbox with NO login.
 *
 * Two entry points, one mechanism, differing only in how the result is
 * rendered for the caller that asked:
 *   - `POST /api/demo/anon-session` answers JSON `{ wsUrl }` pointing at the
 *     session shell WebSocket (`/s/<sid>/ws`) with the attach token in the
 *     query string, for the docs live terminal's bare `new WebSocket()`.
 *   - `GET /try` redirects a browser to `/s/<sid>/?nimbus_token=…`, where
 *     the router's existing attach exchange swaps the query token for the
 *     `__Host-nimbus_token` cookie and lands on the clean shell URL. This is
 *     the landing page's "try it without signing in" path.
 *
 * The core router's token extraction honors header → query → cookie on every
 * `/s/<id>/*` route, WS upgrades included, so both shapes authenticate
 * against the same sid-pinned `session:attach` token.
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
 */

import { createAnonDemoSession, demoPage, type DemoSession } from './demo-sessions.js';
import { issueAnonAttachToken } from './demo-nimbus.js';

interface AnonRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const RETRY_AFTER_SECONDS = 60;

interface AnonRejection {
  status: 429 | 503;
  code: 'E_ANON_RATE_LIMITED' | 'E_ANON_AT_CAPACITY';
  error: string;
}

type AnonLaunch =
  | { ok: true; session: DemoSession; token: string }
  | { ok: false; rejection: AnonRejection };

/**
 * Preconditions, per-IP rate limit, capacity-guarded create, attach token.
 * Everything both entry points share; only the rendering differs.
 */
async function launchAnonSession(request: Request, env: any): Promise<AnonLaunch> {
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
    return { ok: false, rejection: {
      status: 429,
      code: 'E_ANON_RATE_LIMITED',
      error: 'You are booting computers too quickly — try again in a minute.',
    } };
  }

  const session = await createAnonDemoSession(env);
  if (!session) {
    return { ok: false, rejection: {
      status: 503,
      code: 'E_ANON_AT_CAPACITY',
      error: 'All free computers are busy right now — try again in a minute.',
    } };
  }

  return { ok: true, session, token: await issueAnonAttachToken(env, session) };
}

export async function handleAnonSessionCreate(request: Request, env: any): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
    });
  }

  const launch = await launchAnonSession(request, env);
  if (!launch.ok) {
    return Response.json({ ...launch.rejection, retryAfterSeconds: RETRY_AFTER_SECONDS }, {
      status: launch.rejection.status,
      headers: { 'Retry-After': String(RETRY_AFTER_SECONDS), 'Cache-Control': 'no-store' },
    });
  }

  return Response.json({
    wsUrl: `/s/${encodeURIComponent(launch.session.sessionId)}/ws?${new URLSearchParams({ nimbus_token: launch.token })}`,
    sessionId: launch.session.sessionId,
    expiresAt: launch.session.expiresAt,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * `GET /try` — the no-sign-in path off the landing page. Ends at the same
 * session shell a logged-in launch reaches, so there is one terminal UI.
 */
export async function handleAnonLaunch(request: Request, env: any): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET', 'Cache-Control': 'no-store' },
    });
  }

  const launch = await launchAnonSession(request, env);
  if (!launch.ok) return renderAnonUnavailable(launch.rejection);

  const attach = new URL(`/s/${encodeURIComponent(launch.session.sessionId)}/`, request.url);
  attach.searchParams.set('nimbus_token', launch.token);
  return new Response(null, {
    status: 303,
    headers: { Location: attach.pathname + attach.search, 'Cache-Control': 'no-store' },
  });
}

/**
 * The browser form of the same two rejections the JSON endpoint returns as
 * codes. A visitor who clicked "Try it now" gets a page with a way forward;
 * a bare 503 would be a dead end.
 */
function renderAnonUnavailable(rejection: AnonRejection): Response {
  const atCapacity = rejection.code === 'E_ANON_AT_CAPACITY';
  return demoPage(rejection.status, `
    <main>
      <h1>${atCapacity ? 'All free sandboxes are busy' : 'Slow down a moment'}</h1>
      <p>${atCapacity
        ? 'Every free sandbox is in use right now. They are short-lived, so one usually frees up within a few minutes.'
        : 'You have started several sandboxes in the last minute. Give it a minute and try again.'}</p>
      <a href="/try">Try again</a>
      <p class="note">Signing in with Cloudflare gets you a sandbox that is not shared with anyone, lasts for days, and can run the AI agent on your own account.</p>
      <a href="/login?return_to=/new">Sign in with Cloudflare</a>
    </main>
  `, { 'Retry-After': String(RETRY_AFTER_SECONDS) });
}
