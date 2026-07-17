// `@nimbus-sh/sdk/token` is the narrow, workerd-independent token surface;
// keep this module loadable in unit tests (the `/worker` barrel is not).
import { issueNimbusToken } from '@nimbus-sh/sdk/token';
import type { DemoAuth } from './demo-auth.js';
import { ANON_USER_ID } from './demo-sessions.js';

export async function withInternalNimbusAuth(
  request: Request,
  env: any,
  auth: DemoAuth,
  sessionId: string,
  scopes: string[] = ['session:attach', 'sandbox:use'],
): Promise<Request> {
  const token = await issueNimbusToken(
    env,
    {
      tn: 'demo',
      sub: auth.userId,
      sid: sessionId,
      scopes,
    },
    { ttlMs: nimbusJwtTtlMs(env) },
  );
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return new Request(request, { headers });
}

/**
 * Map a `demo_sessions.user_id` to the sandbox principal — the tenant +
 * subject components of the DO instance name. Single source of truth for
 * session creation, request forwarding, destroy, and cron cleanup. Anon
 * docs-terminal sessions live under `anon:anon:<sid>`, disjoint from real
 * users' `demo:cf_<hash>:<sid>`.
 */
export function demoSandboxPrincipal(userId: string): { tenant: string; subject: string } {
  return userId === ANON_USER_ID
    ? { tenant: 'anon', subject: ANON_USER_ID }
    : { tenant: 'demo', subject: userId };
}

export function demoTenantSegment(auth: DemoAuth): string {
  const { tenant, subject } = demoSandboxPrincipal(auth.userId);
  return `${tenant}:${subject}`;
}

/**
 * Attach window for the wsUrl handed to the docs terminal: long enough for
 * the browser to open the WebSocket right after the create POST, short
 * enough that a leaked URL goes stale in minutes. The session's own
 * lifetime is governed separately by DEMO_ANON_TTL_SECONDS.
 */
const ANON_ATTACH_TOKEN_TTL_MS = 120_000;

export async function issueAnonAttachToken(env: any, sessionId: string): Promise<string> {
  const { tenant, subject } = demoSandboxPrincipal(ANON_USER_ID);
  return issueNimbusToken(
    env,
    {
      tn: tenant,
      sub: subject,
      sid: sessionId,
      scopes: ['session:attach'],
    },
    { ttlMs: ANON_ATTACH_TOKEN_TTL_MS },
  );
}

export async function issueDemoSandboxToken(
  env: any,
  auth: DemoAuth,
  sessionId: string,
  scopes: string[] = ['sandbox:use'],
): Promise<string> {
  return issueNimbusToken(
    env,
    {
      tn: 'demo',
      sub: auth.userId,
      sid: sessionId,
      scopes,
    },
    { ttlMs: nimbusJwtTtlMs(env) },
  );
}

function nimbusJwtTtlMs(env: any): number {
  const seconds = Number(env?.DEMO_NIMBUS_JWT_TTL_SECONDS);
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 900;
  return Math.min(safeSeconds, 3600) * 1000;
}
