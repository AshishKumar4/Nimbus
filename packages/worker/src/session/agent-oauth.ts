import {
  sealJson,
  unsealJson,
} from '@nimbus-sh/core/_shared/crypto.js';
import { BASE_PATH_HEADER, TENANT_HEADER } from '../_shared/session-router.js';
import { isValidSessionId } from '../_shared/session-id.js';
import { z } from 'zod/v4';
import { readNimbusCookie, serializeNimbusCookie, isNimbusCloudflareAccountId } from '@nimbus-sh/core/_shared/oauth.js';

export interface NimbusAgentOAuthCookie {
  mode: 'oauth';
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: number | null;
  connectedAt: number;
  accountId: string | null;
  sessionId: string;
  tenantSegment: string;
}

export const NIMBUS_AGENT_AUTH_COOKIE = 'nimbus_agent_oauth';
export const NIMBUS_AGENT_AUTH_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const NIMBUS_AGENT_AUTH_COOKIE_PURPOSE = 'nimbus-agent-oauth-auth';

const NimbusAgentOAuthCookieSchema: z.ZodType<NimbusAgentOAuthCookie> = z.object({
  mode: z.literal('oauth'),
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  tokenType: z.string(),
  expiresAt: z.number().finite().nullable(),
  connectedAt: z.number().finite(),
  accountId: z.string().refine(isNimbusCloudflareAccountId).nullable(),
  sessionId: z.string().refine(isValidSessionId),
  tenantSegment: z.string().refine(isNimbusTenantSegment),
});

export async function createNimbusAgentOAuthCookie(
  auth: NimbusAgentOAuthCookie,
  secret: string,
  basePathOrRequest: string | Request,
): Promise<string> {
  return serializeNimbusCookie(NIMBUS_AGENT_AUTH_COOKIE, await sealJson(auth, secret, {
    purpose: NIMBUS_AGENT_AUTH_COOKIE_PURPOSE,
  }), {
    path: nimbusAgentAuthCookiePath(basePathOrRequest),
    maxAge: NIMBUS_AGENT_AUTH_COOKIE_TTL_SECONDS,
  });
}

export async function loadNimbusAgentOAuthFromRequest(
  request: Request,
  secret: string,
): Promise<NimbusAgentOAuthCookie | null> {
  const value = readNimbusCookie(request, NIMBUS_AGENT_AUTH_COOKIE);
  if (!value) return null;
  const auth = await unsealJson<NimbusAgentOAuthCookie>(value, secret, {
    purpose: NIMBUS_AGENT_AUTH_COOKIE_PURPOSE,
  }).catch(() => null);
  if (!isNimbusAgentOAuthCookie(auth)) return null;
  const route = nimbusAgentRouteContext(request);
  if (
    auth.sessionId !== route.sessionId ||
    auth.tenantSegment !== route.tenantSegment
  ) {
    return null;
  }
  return auth;
}

export function clearNimbusAgentOAuthCookie(basePathOrRequest: string | Request): string {
  return serializeNimbusCookie(NIMBUS_AGENT_AUTH_COOKIE, '', {
    path: nimbusAgentAuthCookiePath(basePathOrRequest),
    maxAge: 0,
  });
}

export interface NimbusAgentOAuthConfig {
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScopes: string[];
  redirectUri: string;
}

/**
 * The Cloudflare OAuth client configuration for this deployment. Read here
 * rather than at each call site so the login dance and the credential-refresh
 * path can never disagree about which client they are talking to.
 */
export function readNimbusAgentOAuthConfig(
  env: Record<string, unknown>,
  origin: string,
): NimbusAgentOAuthConfig {
  return {
    oauthClientId: envString(env, 'NIMBUS_CF_OAUTH_CLIENT_ID'),
    oauthClientSecret: envString(env, 'NIMBUS_CF_OAUTH_CLIENT_SECRET'),
    oauthScopes: envString(env, 'NIMBUS_CF_OAUTH_SCOPES').split(/\s+/).filter(Boolean),
    redirectUri: envString(env, 'NIMBUS_CF_OAUTH_REDIRECT_URI')
      || (origin ? `${origin}/api/nimbus/oauth/callback` : ''),
  };
}

export function readNimbusAgentCookieSecret(env: Record<string, unknown>): string {
  const secret = envString(env, 'NIMBUS_AGENT_COOKIE_SECRET') || envString(env, 'JWT_SECRET');
  if (!secret || secret.length < 32) {
    throw new Error('Set NIMBUS_AGENT_COOKIE_SECRET or JWT_SECRET to a 32+ character value before enabling Cloudflare OAuth');
  }
  return secret;
}

export function nimbusAgentAuthCookiePath(basePathOrRequest: string | Request): string {
  const base = typeof basePathOrRequest === 'string'
    ? basePathOrRequest
    : basePathOrRequest.headers.get(BASE_PATH_HEADER) || '';
  return base.startsWith('/s/') ? base : '/s';
}

export function nimbusAgentRouteContext(request: Request): { sessionId: string; tenantSegment: string } {
  const base = request.headers.get(BASE_PATH_HEADER) || '';
  const sessionId = base.startsWith('/s/') ? base.slice(3).split('/')[0] : '';
  return {
    sessionId,
    tenantSegment: request.headers.get(TENANT_HEADER) || 'legacy:public:_',
  };
}

export function isNimbusTenantSegment(value: string): boolean {
  if (value.length < 3 || value.length > 256) return false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    const ok =
      (ch >= 48 && ch <= 57) ||
      (ch >= 65 && ch <= 90) ||
      (ch >= 97 && ch <= 122) ||
      ch === 45 || ch === 46 || ch === 58 || ch === 95;
    if (!ok) return false;
  }
  return true;
}

function isNimbusAgentOAuthCookie(value: unknown): value is NimbusAgentOAuthCookie {
  return NimbusAgentOAuthCookieSchema.safeParse(value).success;
}

/** A var of the Worker's env, trimmed; '' when it is unset or not a string. */
export function envString(env: Record<string, unknown>, key: string): string {
  const value = env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}
