import {
  createNimbusAgentOAuthCookie,
} from '@nimbus-sh/sdk/worker';
import type { DemoAuth } from './demo-auth.js';
import { demoTenantSegment } from './demo-nimbus.js';
import { readDemoAuthConfig } from './demo-oauth-config.js';

export async function createDemoAgentAuthCookie(
  env: any,
  auth: DemoAuth,
  sessionId: string,
): Promise<string | null> {
  if (!auth.cfAccessToken) return null;
  const config = readDemoAuthConfig(env, '');
  return createNimbusAgentOAuthCookie({
    mode: 'oauth',
    accessToken: auth.cfAccessToken,
    refreshToken: auth.cfRefreshToken,
    tokenType: auth.cfTokenType || 'Bearer',
    expiresAt: auth.cfTokenExpiresAt ?? null,
    connectedAt: auth.loginAt,
    accountId: auth.cfAccountId ?? null,
    sessionId,
    tenantSegment: demoTenantSegment(auth),
  }, config.cookieSecret, `/s/${sessionId}`);
}
