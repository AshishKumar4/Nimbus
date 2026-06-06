import { issueNimbusToken } from '@nimbus-sh/sdk/worker';
import type { DemoAuth } from './demo-auth.js';

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

export function demoTenantSegment(auth: DemoAuth): string {
  return `demo:${auth.userId}`;
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
