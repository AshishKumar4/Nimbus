import {
  base64Utf8,
  sealJson,
  unsealJson,
} from '../_shared/crypto.js';
import { BASE_PATH_HEADER, TENANT_HEADER } from '../_shared/session-router.js';
import { isValidSessionId } from '../_shared/session-id.js';

export interface NimbusCloudflareAccount {
  id: string;
  name: string;
}

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

export interface NimbusAgentAuthCookieResult {
  auth: NimbusAgentOAuthCookie | null;
  setCookie?: string;
  clearCookie?: string;
}

export const NIMBUS_AGENT_AUTH_COOKIE = 'nimbus_agent_oauth';
export const NIMBUS_AGENT_AUTH_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const NIMBUS_AGENT_AUTH_COOKIE_PURPOSE = 'nimbus-agent-oauth-auth';
export const NIMBUS_CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
export const NIMBUS_CF_OAUTH_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth';
export const NIMBUS_CF_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
export const NIMBUS_CF_OAUTH_USERINFO_URL = 'https://dash.cloudflare.com/oauth2/userinfo';

export async function requestNimbusCloudflareOAuthToken(
  config: { oauthClientId: string; oauthClientSecret?: string },
  fields: Record<string, string>,
): Promise<any> {
  if (!config.oauthClientId) throw new Error('OAuth client id is not configured');
  const body = new URLSearchParams({
    client_id: config.oauthClientId,
    ...fields,
  });
  const headers = new Headers({
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  });
  if (config.oauthClientSecret) {
    headers.set('Authorization', 'Basic ' + base64Utf8(`${config.oauthClientId}:${config.oauthClientSecret}`));
  }
  const response = await fetch(NIMBUS_CF_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers,
    body,
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const detail = payload?.error_description || payload?.error || response.statusText;
    throw new Error(`Cloudflare token exchange failed: ${detail}`);
  }
  return payload;
}

export async function fetchNimbusCloudflareUserInfo(accessToken: string): Promise<unknown> {
  const response = await fetch(NIMBUS_CF_OAUTH_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = (payload as any)?.error_description || (payload as any)?.error || 'userinfo request failed';
    throw new Error(detail);
  }
  return payload;
}

export async function fetchNimbusCloudflareAccounts(accessToken: string): Promise<NimbusCloudflareAccount[]> {
  const response = await fetch(`${NIMBUS_CLOUDFLARE_API}/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(payload?.errors?.[0]?.message || payload?.error || 'accounts request failed');
  const accounts = Array.isArray(payload?.result) ? payload.result : [];
  return accounts
    .map((account: any) => ({ id: String(account.id || ''), name: String(account.name || account.id || '') }))
    .filter((account: NimbusCloudflareAccount) => isNimbusCloudflareAccountId(account.id));
}

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

export function serializeNimbusCookie(
  name: string,
  value: string,
  opts: { path: string; maxAge: number },
): string {
  return [
    `${name}=${value}`,
    `Path=${opts.path}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export function readNimbusCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') || request.headers.get('cookie') || '';
  const target = name + '=';
  for (const part of header.split(';')) {
    const item = part.trim();
    if (item.startsWith(target)) return item.slice(target.length);
  }
  return null;
}

export function isNimbusCloudflareAccountId(value: string): boolean {
  if (value.length < 16 || value.length > 64) return false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    const ok =
      (ch >= 48 && ch <= 57) ||
      (ch >= 65 && ch <= 70) ||
      (ch >= 97 && ch <= 102);
    if (!ok) return false;
  }
  return true;
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
  const auth = value as NimbusAgentOAuthCookie | null;
  return !!auth
    && auth.mode === 'oauth'
    && typeof auth.accessToken === 'string'
    && auth.accessToken.length > 0
    && typeof auth.tokenType === 'string'
    && Number.isFinite(auth.connectedAt)
    && (auth.expiresAt == null || Number.isFinite(auth.expiresAt))
    && (auth.accountId == null || isNimbusCloudflareAccountId(auth.accountId))
    && isValidSessionId(auth.sessionId)
    && isNimbusTenantSegment(auth.tenantSegment);
}

function envString(env: Record<string, unknown>, key: string): string {
  const value = env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}
