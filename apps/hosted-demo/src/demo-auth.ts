import {
  fetchNimbusCloudflareAccounts,
  fetchNimbusCloudflareUserInfo,
  readNimbusCookie,
  beginNimbusCloudflareOAuth,
  exchangeNimbusCloudflareOAuthCode,
  createNimbusOAuthStateCookie,
  loadNimbusOAuthStateCookie,
  type NimbusOAuthTransaction,
  sealJson,
  serializeNimbusCookie,
  sha256Base64Url,
  unsealJson,
} from '@nimbus-sh/sdk/oauth';
import { renderOAuthFailure } from './demo-http.js';
import { readDemoAuthConfig, sanitizeReturnTo } from './demo-oauth-config.js';
import { upsertDemoUser } from './demo-sessions.js';

export { demoAuthRequiredResponse } from './demo-http.js';

const DEMO_AUTH_COOKIE = '__Host-nimbus_demo_auth';
const DEMO_STATE_COOKIE = '__Host-nimbus_demo_state';
const DEMO_AUTH_COOKIE_PURPOSE = 'nimbus-demo-auth';
const DEMO_STATE_COOKIE_PURPOSE = 'nimbus-demo-oauth-state';

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

interface DemoOAuthState extends NimbusOAuthTransaction {
  returnTo: string;
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
  const { transaction, authUrl } = await beginNimbusCloudflareOAuth(config);
  const state: DemoOAuthState = { ...transaction, returnTo };

  const headers = new Headers({
    Location: authUrl.toString(),
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', await createNimbusOAuthStateCookie(state, {
    name: DEMO_STATE_COOKIE, purpose: DEMO_STATE_COOKIE_PURPOSE, secret: config.cookieSecret,
  }));
  return new Response(null, { status: 302, headers });
}

export async function completeDemoLogin(request: Request, env: any): Promise<Response> {
  const url = new URL(request.url);
  const config = readDemoAuthConfig(env, url.origin);
  const clearState = clearCookie(DEMO_STATE_COOKIE);
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearState);
  // Every exit below that is not a successful login renders the same page,
  // and each must still retire the state cookie it consumed.
  const failed = (message: string) => renderOAuthFailure(message, [clearState]);

  const error = url.searchParams.get('error');
  if (error) return failed(`Cloudflare authorization failed: ${error}`);

  const code = url.searchParams.get('code');
  const nonce = url.searchParams.get('state');
  const stored = await loadDemoState(request, config.cookieSecret);
  if (!code || !nonce || !stored) return failed('OAuth callback is missing or expired.');
  if (stored.expiresAt < Date.now() || stored.nonce !== nonce) {
    return failed('OAuth state did not match this login attempt.');
  }

  try {
    const token = await exchangeNimbusCloudflareOAuthCode(config, stored, code);
    const accessToken = token.accessToken;
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
      cfRefreshToken: token.refreshToken,
      cfTokenType: token.tokenType,
      cfTokenExpiresAt: token.expiresAt,
      cfAccountId: accounts[0]?.id ?? null,
    };
    await upsertDemoUser(env, {
      userId: auth.userId,
      cfSubjectHash: subjectHash,
      displayName: auth.displayName,
      now,
    });
    headers.append('Set-Cookie', serializeNimbusCookie(DEMO_AUTH_COOKIE, await sealJson(auth, config.cookieSecret, {
      purpose: DEMO_AUTH_COOKIE_PURPOSE,
    }), {
      path: '/',
      maxAge: Math.ceil(config.authCookieTtlMs / 1000),
    }));
    headers.set('Location', sanitizeReturnTo(stored.returnTo) || '/new');
    return new Response(null, { status: 302, headers });
  } catch (e: any) {
    return failed(e?.message || String(e));
  }
}

export async function logoutDemo(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers({
    Location: '/',
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', clearCookie(DEMO_AUTH_COOKIE));
  headers.append('Set-Cookie', clearCookie(DEMO_STATE_COOKIE));
  if (url.searchParams.get('return_to')) {
    headers.set('Location', sanitizeReturnTo(url.searchParams.get('return_to')) || '/');
  }
  return new Response(null, { status: 302, headers });
}

export async function loadDemoAuth(request: Request, env: any): Promise<DemoAuth | null> {
  const value = readNimbusCookie(request, DEMO_AUTH_COOKIE);
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
  const state = await loadNimbusOAuthStateCookie<DemoOAuthState>(request, {
    name: DEMO_STATE_COOKIE, purpose: DEMO_STATE_COOKIE_PURPOSE, secret: cookieSecret,
  });
  if (!state || state.v !== 1 || !state.nonce || !state.codeVerifier || !state.redirectUri) return null;
  return state;
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

function clearCookie(name: string): string {
  return serializeNimbusCookie(name, '', { path: '/', maxAge: 0 });
}

