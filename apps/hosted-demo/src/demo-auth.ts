import {
  fetchNimbusCloudflareAccounts,
  fetchNimbusCloudflareUserInfo,
  pkceChallenge,
  randomBase64Url,
  requestNimbusCloudflareOAuthToken,
  sealJson,
  sha256Base64Url,
  unsealJson,
} from '@nimbus-sh/sdk/worker';
import { readDemoAuthConfig, sanitizeReturnTo } from './demo-oauth-config.js';
import { upsertDemoUser } from './demo-sessions.js';

export { demoAuthRequiredResponse } from './demo-http.js';

const DEMO_AUTH_COOKIE = '__Host-nimbus_demo_auth';
const DEMO_STATE_COOKIE = '__Host-nimbus_demo_state';
const DEMO_AUTH_COOKIE_PURPOSE = 'nimbus-demo-auth';
const DEMO_STATE_COOKIE_PURPOSE = 'nimbus-demo-oauth-state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const CF_OAUTH_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth';

export interface DemoAuth {
  v: 1;
  userId: string;
  displayName: string | null;
  loginAt: number;
  expiresAt: number;
  cfAccessToken: string;
  cfRefreshToken?: string;
  cfTokenType: string;
  cfTokenExpiresAt: number | null;
  cfAccountId: string | null;
}

interface DemoOAuthState {
  v: 1;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  returnTo: string;
  createdAt: number;
  expiresAt: number;
}

export async function startDemoLogin(request: Request, env: any): Promise<Response> {
  const config = readDemoAuthConfig(env, new URL(request.url).origin);
  if (!config.clientId) {
    return Response.json({
      error: 'Cloudflare OAuth is not configured for the hosted demo',
      code: 'E_DEMO_OAUTH_NOT_CONFIGURED',
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get('return_to')) || '/new';
  const nonce = randomBase64Url(24);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await pkceChallenge(codeVerifier);
  const now = Date.now();
  const state: DemoOAuthState = {
    v: 1,
    nonce,
    codeVerifier,
    redirectUri: config.redirectUri,
    returnTo,
    createdAt: now,
    expiresAt: now + OAUTH_STATE_TTL_MS,
  };

  const authUrl = new URL(CF_OAUTH_AUTH_URL);
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', config.redirectUri);
  authUrl.searchParams.set('state', nonce);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (config.scopes.length > 0) authUrl.searchParams.set('scope', config.scopes.join(' '));

  const headers = new Headers({
    Location: authUrl.toString(),
    'Cache-Control': 'no-store',
  });
  appendCookie(headers, serializeCookie(DEMO_STATE_COOKIE, await sealJson(state, config.cookieSecret, {
    purpose: DEMO_STATE_COOKIE_PURPOSE,
  }), {
    maxAge: Math.ceil(OAUTH_STATE_TTL_MS / 1000),
  }));
  return new Response(null, { status: 302, headers });
}

export async function completeDemoLogin(request: Request, env: any): Promise<Response> {
  const url = new URL(request.url);
  const config = readDemoAuthConfig(env, url.origin);
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  appendCookie(headers, clearCookie(DEMO_STATE_COOKIE));

  const error = url.searchParams.get('error');
  if (error) return oauthFailure(`Cloudflare authorization failed: ${error}`, headers);

  const code = url.searchParams.get('code');
  const nonce = url.searchParams.get('state');
  const stored = await loadDemoState(request, config.cookieSecret);
  if (!code || !nonce || !stored) return oauthFailure('OAuth callback is missing or expired.', headers);
  if (stored.expiresAt < Date.now() || stored.nonce !== nonce) {
    return oauthFailure('OAuth state did not match this login attempt.', headers);
  }

  try {
    const token = await exchangeCode(config, code, stored.codeVerifier, stored.redirectUri);
    const accessToken = String(token?.access_token || '');
    if (!accessToken) throw new Error('Cloudflare did not return an access token');
    const userInfo = await fetchNimbusCloudflareUserInfo(accessToken);
    const accounts = await fetchNimbusCloudflareAccounts(accessToken).catch(() => []);
    const stableSubject = stableUserSubject(userInfo);
    const subjectHash = await sha256Base64Url(stableSubject);
    const now = Date.now();
    const auth: DemoAuth = {
      v: 1,
      userId: `cf_${subjectHash}`,
      displayName: displayName(userInfo),
      loginAt: now,
      expiresAt: now + config.authCookieTtlMs,
      cfAccessToken: accessToken,
      cfRefreshToken: token.refresh_token ? String(token.refresh_token) : undefined,
      cfTokenType: token.token_type ? String(token.token_type) : 'Bearer',
      cfTokenExpiresAt: token.expires_in ? now + Math.max(0, Number(token.expires_in) - 30) * 1000 : null,
      cfAccountId: accounts[0]?.id ?? null,
    };
    await upsertDemoUser(env, {
      userId: auth.userId,
      cfSubjectHash: subjectHash,
      displayName: auth.displayName,
      now,
    });
    appendCookie(headers, serializeCookie(DEMO_AUTH_COOKIE, await sealJson(auth, config.cookieSecret, {
      purpose: DEMO_AUTH_COOKIE_PURPOSE,
    }), {
      maxAge: Math.ceil(config.authCookieTtlMs / 1000),
    }));
    headers.set('Location', sanitizeReturnTo(stored.returnTo) || '/new');
    return new Response(null, { status: 302, headers });
  } catch (e: any) {
    return oauthFailure(e?.message || String(e), headers);
  }
}

export async function logoutDemo(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers({
    Location: '/',
    'Cache-Control': 'no-store',
  });
  appendCookie(headers, clearCookie(DEMO_AUTH_COOKIE));
  appendCookie(headers, clearCookie(DEMO_STATE_COOKIE));
  if (url.searchParams.get('return_to')) {
    headers.set('Location', sanitizeReturnTo(url.searchParams.get('return_to')) || '/');
  }
  return new Response(null, { status: 302, headers });
}

export async function loadDemoAuth(request: Request, env: any): Promise<DemoAuth | null> {
  const value = readCookie(request, DEMO_AUTH_COOKIE);
  if (!value) return null;
  const config = readDemoAuthConfig(env, new URL(request.url).origin);
  const auth = await unsealJson<DemoAuth>(value, config.cookieSecret, {
    purpose: DEMO_AUTH_COOKIE_PURPOSE,
  }).catch(() => null);
  if (!auth || auth.v !== 1 || !auth.userId || auth.expiresAt < Date.now()) return null;
  if (!auth.cfAccessToken || !auth.cfTokenType) return null;
  return auth;
}

export async function shouldHandleDemoOAuthCallback(request: Request, env: any): Promise<boolean> {
  const url = new URL(request.url);
  const nonce = url.searchParams.get('state');
  if (!nonce) return false;
  const config = readDemoAuthConfig(env, url.origin);
  const stored = await loadDemoState(request, config.cookieSecret).catch(() => null);
  return !!stored && stored.expiresAt >= Date.now() && stored.nonce === nonce;
}

async function loadDemoState(request: Request, cookieSecret: string): Promise<DemoOAuthState | null> {
  const value = readCookie(request, DEMO_STATE_COOKIE);
  if (!value) return null;
  const state = await unsealJson<DemoOAuthState>(value, cookieSecret, {
    purpose: DEMO_STATE_COOKIE_PURPOSE,
  }).catch(() => null);
  if (!state || state.v !== 1 || !state.nonce || !state.codeVerifier || !state.redirectUri) return null;
  return state;
}

async function exchangeCode(
  config: ReturnType<typeof readDemoAuthConfig>,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<any> {
  return requestNimbusCloudflareOAuthToken({
    oauthClientId: config.clientId,
    oauthClientSecret: config.clientSecret,
  }, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

function stableUserSubject(userInfo: any): string {
  const candidates = [
    userInfo?.sub,
    userInfo?.id,
    userInfo?.user_id,
    userInfo?.email,
  ];
  const subject = candidates.find((value) => typeof value === 'string' && value.trim());
  if (!subject) throw new Error('Cloudflare userinfo did not include a stable user id');
  return subject.trim();
}

function displayName(userInfo: any): string | null {
  const value = userInfo?.name || userInfo?.email || userInfo?.preferred_username || userInfo?.id || null;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
}

function oauthFailure(message: string, headers: Headers): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Nimbus Login</title><body style="font:14px system-ui;background:#080b0b;color:#d8e3dd;padding:32px"><h1>Login failed</h1><p>${escapeHtml(message)}</p><p><a style="color:#8be0bd" href="/login">Try again</a></p></body>`,
    { status: 400, headers: withHtml(headers) },
  );
}

function withHtml(headers: Headers): Headers {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return headers;
}

function serializeCookie(name: string, value: string, opts: { maxAge: number }): string {
  return [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

function clearCookie(name: string): string {
  return serializeCookie(name, '', { maxAge: 0 });
}

function appendCookie(headers: Headers, cookie: string): void {
  headers.append('Set-Cookie', cookie);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') || request.headers.get('cookie') || '';
  const target = name + '=';
  for (const part of header.split(';')) {
    const item = part.trim();
    if (item.startsWith(target)) return item.slice(target.length);
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
