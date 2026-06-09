import { base64Utf8, sealJson, unsealJson, } from '../_shared/crypto.js';
import { BASE_PATH_HEADER, TENANT_HEADER } from '../_shared/session-router.js';
import { isValidSessionId } from '../_shared/session-id.js';
import { z } from 'zod/v4';
export const NIMBUS_AGENT_AUTH_COOKIE = 'nimbus_agent_oauth';
export const NIMBUS_AGENT_AUTH_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const NIMBUS_AGENT_AUTH_COOKIE_PURPOSE = 'nimbus-agent-oauth-auth';
export const NIMBUS_CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
export const NIMBUS_CF_OAUTH_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth';
export const NIMBUS_CF_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
export const NIMBUS_CF_OAUTH_USERINFO_URL = 'https://dash.cloudflare.com/oauth2/userinfo';
const CloudflareErrorPayloadSchema = z.object({
    error: z.string().optional(),
    error_description: z.string().optional(),
    errors: z.array(z.object({
        message: z.string().optional(),
    }).passthrough()).optional(),
}).passthrough();
const CloudflareOAuthTokenResponseSchema = z.object({
    access_token: z.string().min(1),
    token_type: z.string().optional(),
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
}).passthrough();
const CloudflareAccountsResponseSchema = z.object({
    result: z.array(z.object({
        id: z.string(),
        name: z.string().optional(),
    }).passthrough()).default([]),
}).merge(CloudflareErrorPayloadSchema);
const NimbusAgentOAuthCookieSchema = z.object({
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
export async function requestNimbusCloudflareOAuthToken(config, fields) {
    if (!config.oauthClientId)
        throw new Error('OAuth client id is not configured');
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
    const payload = await responseJson(response);
    if (!response.ok) {
        const detail = cloudflareErrorDetail(payload, response.statusText);
        throw new Error(`Cloudflare token exchange failed: ${detail}`);
    }
    const parsed = CloudflareOAuthTokenResponseSchema.safeParse(payload);
    if (!parsed.success)
        throw new Error('Cloudflare token exchange returned an invalid OAuth token payload');
    return parsed.data;
}
export async function fetchNimbusCloudflareUserInfo(accessToken) {
    const response = await fetch(NIMBUS_CF_OAUTH_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const payload = await responseJson(response);
    if (!response.ok) {
        throw new Error(cloudflareErrorDetail(payload, 'userinfo request failed'));
    }
    return payload;
}
export async function fetchNimbusCloudflareAccounts(accessToken) {
    const response = await fetch(`${NIMBUS_CLOUDFLARE_API}/accounts`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const payload = await responseJson(response);
    const parsed = CloudflareAccountsResponseSchema.safeParse(payload);
    if (!response.ok)
        throw new Error(cloudflareErrorDetail(payload, 'accounts request failed'));
    const accounts = parsed.success ? parsed.data.result : [];
    return accounts
        .map((account) => ({ id: account.id, name: account.name || account.id }))
        .filter((account) => isNimbusCloudflareAccountId(account.id));
}
export async function createNimbusAgentOAuthCookie(auth, secret, basePathOrRequest) {
    return serializeNimbusCookie(NIMBUS_AGENT_AUTH_COOKIE, await sealJson(auth, secret, {
        purpose: NIMBUS_AGENT_AUTH_COOKIE_PURPOSE,
    }), {
        path: nimbusAgentAuthCookiePath(basePathOrRequest),
        maxAge: NIMBUS_AGENT_AUTH_COOKIE_TTL_SECONDS,
    });
}
export async function loadNimbusAgentOAuthFromRequest(request, secret) {
    const value = readNimbusCookie(request, NIMBUS_AGENT_AUTH_COOKIE);
    if (!value)
        return null;
    const auth = await unsealJson(value, secret, {
        purpose: NIMBUS_AGENT_AUTH_COOKIE_PURPOSE,
    }).catch(() => null);
    if (!isNimbusAgentOAuthCookie(auth))
        return null;
    const route = nimbusAgentRouteContext(request);
    if (auth.sessionId !== route.sessionId ||
        auth.tenantSegment !== route.tenantSegment) {
        return null;
    }
    return auth;
}
export function clearNimbusAgentOAuthCookie(basePathOrRequest) {
    return serializeNimbusCookie(NIMBUS_AGENT_AUTH_COOKIE, '', {
        path: nimbusAgentAuthCookiePath(basePathOrRequest),
        maxAge: 0,
    });
}
export function readNimbusAgentCookieSecret(env) {
    const secret = envString(env, 'NIMBUS_AGENT_COOKIE_SECRET') || envString(env, 'JWT_SECRET');
    if (!secret || secret.length < 32) {
        throw new Error('Set NIMBUS_AGENT_COOKIE_SECRET or JWT_SECRET to a 32+ character value before enabling Cloudflare OAuth');
    }
    return secret;
}
export function nimbusAgentAuthCookiePath(basePathOrRequest) {
    const base = typeof basePathOrRequest === 'string'
        ? basePathOrRequest
        : basePathOrRequest.headers.get(BASE_PATH_HEADER) || '';
    return base.startsWith('/s/') ? base : '/s';
}
export function nimbusAgentRouteContext(request) {
    const base = request.headers.get(BASE_PATH_HEADER) || '';
    const sessionId = base.startsWith('/s/') ? base.slice(3).split('/')[0] : '';
    return {
        sessionId,
        tenantSegment: request.headers.get(TENANT_HEADER) || 'legacy:public:_',
    };
}
export function serializeNimbusCookie(name, value, opts) {
    return [
        `${name}=${value}`,
        `Path=${opts.path}`,
        `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`,
        'HttpOnly',
        'Secure',
        'SameSite=Lax',
    ].join('; ');
}
export function readNimbusCookie(request, name) {
    const header = request.headers.get('Cookie') || request.headers.get('cookie') || '';
    const target = name + '=';
    for (const part of header.split(';')) {
        const item = part.trim();
        if (item.startsWith(target))
            return item.slice(target.length);
    }
    return null;
}
export function isNimbusCloudflareAccountId(value) {
    if (value.length < 16 || value.length > 64)
        return false;
    for (let i = 0; i < value.length; i++) {
        const ch = value.charCodeAt(i);
        const ok = (ch >= 48 && ch <= 57) ||
            (ch >= 65 && ch <= 70) ||
            (ch >= 97 && ch <= 102);
        if (!ok)
            return false;
    }
    return true;
}
export function isNimbusTenantSegment(value) {
    if (value.length < 3 || value.length > 256)
        return false;
    for (let i = 0; i < value.length; i++) {
        const ch = value.charCodeAt(i);
        const ok = (ch >= 48 && ch <= 57) ||
            (ch >= 65 && ch <= 90) ||
            (ch >= 97 && ch <= 122) ||
            ch === 45 || ch === 46 || ch === 58 || ch === 95;
        if (!ok)
            return false;
    }
    return true;
}
function isNimbusAgentOAuthCookie(value) {
    return NimbusAgentOAuthCookieSchema.safeParse(value).success;
}
function envString(env, key) {
    const value = env?.[key];
    return typeof value === 'string' ? value.trim() : '';
}
async function responseJson(response) {
    try {
        return await response.json();
    }
    catch {
        return null;
    }
}
function cloudflareErrorDetail(payload, fallback) {
    const parsed = CloudflareErrorPayloadSchema.safeParse(payload);
    if (!parsed.success)
        return fallback;
    return parsed.data.error_description ||
        parsed.data.error ||
        parsed.data.errors?.find((error) => error.message)?.message ||
        fallback;
}
