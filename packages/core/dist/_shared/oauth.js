import { z } from 'zod/v4';
import { base64Utf8, pkceChallenge, randomBase64Url, sealJson, unsealJson } from './crypto.js';
export const NIMBUS_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const NIMBUS_CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
export const NIMBUS_CF_OAUTH_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth';
export const NIMBUS_CF_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
export const NIMBUS_CF_OAUTH_USERINFO_URL = 'https://dash.cloudflare.com/oauth2/userinfo';
export async function beginNimbusCloudflareOAuth(config, ttlMs = NIMBUS_OAUTH_STATE_TTL_MS) {
    const createdAt = Date.now();
    const transaction = {
        v: 1, nonce: randomBase64Url(24), codeVerifier: randomBase64Url(48),
        redirectUri: config.redirectUri, createdAt, expiresAt: createdAt + ttlMs,
    };
    const authUrl = new URL(NIMBUS_CF_OAUTH_AUTH_URL);
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', transaction.redirectUri);
    authUrl.searchParams.set('state', transaction.nonce);
    authUrl.searchParams.set('code_challenge', await pkceChallenge(transaction.codeVerifier));
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (config.scopes.length)
        authUrl.searchParams.set('scope', config.scopes.join(' '));
    return { transaction, authUrl };
}
export async function exchangeNimbusCloudflareOAuthCode(config, transaction, code) {
    return normalizeNimbusOAuthToken(await requestNimbusCloudflareOAuthToken({
        oauthClientId: config.clientId, oauthClientSecret: config.clientSecret,
    }, { grant_type: 'authorization_code', code, redirect_uri: transaction.redirectUri, code_verifier: transaction.codeVerifier }));
}
export function normalizeNimbusOAuthToken(token, now = Date.now()) {
    return {
        accessToken: token.access_token,
        ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
        tokenType: token.token_type || 'Bearer',
        expiresAt: token.expires_in ? now + Math.max(0, token.expires_in - 30) * 1000 : null,
    };
}
export async function createNimbusOAuthStateCookie(value, cookie, ttlMs = NIMBUS_OAUTH_STATE_TTL_MS) {
    return serializeNimbusCookie(cookie.name, await sealJson(value, cookie.secret, { purpose: cookie.purpose }), {
        path: '/', maxAge: Math.ceil(ttlMs / 1000),
    });
}
export async function loadNimbusOAuthStateCookie(request, cookie) {
    const value = readNimbusCookie(request, cookie.name);
    return value ? unsealJson(value, cookie.secret, { purpose: cookie.purpose }).catch(() => null) : null;
}
const CloudflareErrorPayloadSchema = z.object({
    error: z.string().optional(), error_description: z.string().optional(),
    errors: z.array(z.object({ message: z.string().optional() }).passthrough()).optional(),
}).passthrough();
const CloudflareOAuthTokenResponseSchema = z.object({
    access_token: z.string().min(1), token_type: z.string().optional(),
    expires_in: z.number().optional(), refresh_token: z.string().optional(),
}).passthrough();
const CloudflareAccountsResponseSchema = z.object({
    result: z.array(z.object({ id: z.string(), name: z.string().optional() }).passthrough()).default([]),
}).merge(CloudflareErrorPayloadSchema);
export async function requestNimbusCloudflareOAuthToken(config, fields) {
    if (!config.oauthClientId)
        throw new Error('OAuth client id is not configured');
    const body = new URLSearchParams({ client_id: config.oauthClientId, ...fields });
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
    if (config.oauthClientSecret)
        headers.set('Authorization', 'Basic ' + base64Utf8(`${config.oauthClientId}:${config.oauthClientSecret}`));
    const response = await fetch(NIMBUS_CF_OAUTH_TOKEN_URL, { method: 'POST', headers, body });
    const payload = await responseJson(response);
    if (!response.ok)
        throw new Error(`Cloudflare token exchange failed: ${cloudflareErrorDetail(payload, response.statusText)}`);
    const parsed = CloudflareOAuthTokenResponseSchema.safeParse(payload);
    if (!parsed.success)
        throw new Error('Cloudflare token exchange returned an invalid OAuth token payload');
    return parsed.data;
}
export async function fetchNimbusCloudflareUserInfo(accessToken) {
    const response = await fetch(NIMBUS_CF_OAUTH_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    const payload = await responseJson(response);
    if (!response.ok)
        throw new Error(cloudflareErrorDetail(payload, 'userinfo request failed'));
    return payload;
}
export async function fetchNimbusCloudflareAccounts(accessToken) {
    const response = await fetch(`${NIMBUS_CLOUDFLARE_API}/accounts`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    const payload = await responseJson(response);
    const parsed = CloudflareAccountsResponseSchema.safeParse(payload);
    if (!response.ok)
        throw new Error(cloudflareErrorDetail(payload, 'accounts request failed'));
    return (parsed.success ? parsed.data.result : []).map((account) => ({ id: account.id, name: account.name || account.id }))
        .filter((account) => isNimbusCloudflareAccountId(account.id));
}
export function serializeNimbusCookie(name, value, opts) {
    return [`${name}=${value}`, `Path=${opts.path}`, `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`, 'HttpOnly', 'Secure', 'SameSite=Lax'].join('; ');
}
export function readNimbusCookie(request, name) {
    const target = name + '=';
    for (const part of (request.headers.get('Cookie') || '').split(';')) {
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
        if (!((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 70) || (ch >= 97 && ch <= 102)))
            return false;
    }
    return true;
}
async function responseJson(response) {
    return response.json().catch(() => null);
}
function cloudflareErrorDetail(payload, fallback) {
    const parsed = CloudflareErrorPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data.error_description || parsed.data.error || parsed.data.errors?.find((error) => error.message)?.message || fallback : fallback;
}
