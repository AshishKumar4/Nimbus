#!/usr/bin/env bun
// auth/new/hosted-demo-launch-oauth - the hosted demo launch flow uses the
// already-registered Nimbus OAuth callback and opens a login modal on the
// landing page.

import { readFileSync } from 'node:fs';
import { makeAsserter } from '../../_driver.mjs';
import { launchBrowser } from '../../_runtime-behavioral-template.mjs';

const a = makeAsserter('auth/new/hosted-demo-launch-oauth');
const {
  DEMO_OAUTH_CALLBACK_PATH,
  readDemoAuthConfig,
  sanitizeReturnTo,
} = await import('../../../../apps/hosted-demo/src/demo-oauth-config.ts');
const {
  loadNimbusAgentOAuthFromRequest,
} = await import('../../../../packages/worker/src/session/agent-oauth.ts');
const { createDemoAgentAuthCookie } = await import('../../../../apps/hosted-demo/src/demo-agent-auth.ts');

const origin = 'https://nimbus.example.com';
const config = readDemoAuthConfig({
  NIMBUS_CF_OAUTH_CLIENT_ID: 'cf-client',
  NIMBUS_CF_OAUTH_SCOPES: 'user-details.read account-settings.read ai.write aig.run',
  NIMBUS_AGENT_COOKIE_SECRET: '0123456789abcdef0123456789abcdef',
}, origin);

a.check('demo OAuth defaults to registered Nimbus callback',
  config.redirectUri === `${origin}/api/nimbus/oauth/callback`
  && DEMO_OAUTH_CALLBACK_PATH === '/api/nimbus/oauth/callback',
  config.redirectUri);
a.check('demo login includes agent OAuth scopes',
  config.scopes.includes('user-details.read')
  && config.scopes.includes('account-settings.read')
  && config.scopes.includes('ai.write')
  && config.scopes.includes('aig.run'),
  config.scopes.join(' '));

const mergedScopes = readDemoAuthConfig({
  NIMBUS_CF_OAUTH_CLIENT_ID: 'cf-client',
  NIMBUS_CF_OAUTH_SCOPES: 'account-settings.read ai.write',
  DEMO_CF_OAUTH_SCOPES: 'user-details.read',
  NIMBUS_AGENT_COOKIE_SECRET: '0123456789abcdef0123456789abcdef',
}, origin);
a.check('demo-specific scopes do not strip agent scopes',
  mergedScopes.scopes.join(' ') === 'user-details.read account-settings.read ai.write',
  mergedScopes.scopes.join(' '));

const envOverride = readDemoAuthConfig({
  NIMBUS_CF_OAUTH_CLIENT_ID: 'cf-client',
  NIMBUS_CF_OAUTH_REDIRECT_URI: 'https://nimbus.example.com/custom/callback',
  NIMBUS_AGENT_COOKIE_SECRET: '0123456789abcdef0123456789abcdef',
}, origin);
a.check('existing Nimbus OAuth redirect override is honored',
  envOverride.redirectUri === 'https://nimbus.example.com/custom/callback',
  envOverride.redirectUri);

const demoOverride = readDemoAuthConfig({
  DEMO_CF_OAUTH_CLIENT_ID: 'demo-client',
  DEMO_CF_OAUTH_REDIRECT_URI: 'https://nimbus.example.com/demo/callback',
  NIMBUS_AGENT_COOKIE_SECRET: '0123456789abcdef0123456789abcdef',
}, origin);
a.check('demo-specific OAuth redirect override wins',
  demoOverride.redirectUri === 'https://nimbus.example.com/demo/callback',
  demoOverride.redirectUri);

a.check('return_to keeps launch query',
  sanitizeReturnTo('/new?launch=1') === '/new?launch=1');
a.check('return_to rejects protocol-relative URLs',
  sanitizeReturnTo('//evil.example.com/new') === null);

const html = readFileSync(new URL('../../../../packages/worker/public/index.html', import.meta.url), 'utf8');
const browser = await launchBrowser({ webSecurity: true });
try {
  const page = await browser.newPage();
  let authStatus = 401;
  const requests = [];
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method() });
    if (url.origin !== origin) return request.abort();
    if (url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: html });
    if (url.pathname === '/api/demo/auth/me') return request.respond({ status: authStatus, contentType: 'application/json', body: '{}' });
    if (url.pathname === '/new') return request.respond({ status: 200, contentType: 'text/html', body: '<body>submitted launch</body>' });
    return request.respond({ status: 404, body: '' });
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.click('#hero-launch-form button');
  await page.waitForSelector('#launch-modal:not([hidden])');
  const login = await page.$eval('#launch-login', node => ({ href: node.href, text: node.textContent, focused: document.activeElement === node }));
  a.check('unauthenticated launch opens and focuses the login modal', login.focused && login.text.includes('Login / Register with Cloudflare'), JSON.stringify(login));
  a.check('modal login returns to the authenticated launch path', new URL(login.href).searchParams.get('return_to') === '/new?launch=1', login.href);
  a.check('unauthenticated launch does not submit the form', !requests.some(request => request.path === '/new'));
  await page.keyboard.press('Escape');
  a.check('Escape closes the login modal', await page.$eval('#launch-modal', node => node.hidden));
  for (const status of [200, 404]) {
    authStatus = status;
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#hero-launch-form button')]);
    a.check(status === 200 ? 'authenticated launch submits without modal' : 'generic embedder fallback submits the launch',
      new URL(page.url()).pathname === '/new' && await page.$eval('body', node => node.textContent) === 'submitted launch');
  }
  a.check('the actual form sends POST /new', requests.some(request => request.path === '/new' && request.method === 'POST'));
} finally {
  await browser.close();
}

const demoAuth = {
  v: 1,
  userId: 'cf_test-user',
  displayName: 'Test User',
  loginAt: 1_765_000_000_000,
  expiresAt: 1_765_086_400_000,
  cfAccessToken: 'cf-access-token',
  cfRefreshToken: 'cf-refresh-token',
  cfTokenType: 'Bearer',
  cfTokenExpiresAt: 1_765_003_600_000,
  cfAccountId: '0123456789abcdef0123456789abcdef',
};
const sessionId = 'single-login-123';
const agentCookie = await createDemoAgentAuthCookie({ NIMBUS_AGENT_COOKIE_SECRET: '0123456789abcdef0123456789abcdef' }, demoAuth, sessionId);
a.check('authenticated launch seeds session-scoped agent OAuth cookie',
  agentCookie
  && agentCookie.includes('nimbus_agent_oauth=')
  && agentCookie.includes('Path=/s/single-login-123')
  && agentCookie.includes('HttpOnly')
  && agentCookie.includes('Secure')
  && agentCookie.includes('SameSite=Lax'),
  String(agentCookie));

const parsedAgentAuth = await loadNimbusAgentOAuthFromRequest(new Request(`${origin}/s/${sessionId}/api/agent/status`, {
  headers: {
    Cookie: agentCookie.split(';')[0],
    'X-Nimbus-Base': `/s/${sessionId}`,
    'X-Nimbus-Tenant': `demo:${demoAuth.userId}`,
  },
}), '0123456789abcdef0123456789abcdef');
a.check('seeded cookie is accepted by the session agent parser',
  parsedAgentAuth?.accessToken === demoAuth.cfAccessToken
  && parsedAgentAuth?.refreshToken === demoAuth.cfRefreshToken
  && parsedAgentAuth?.accountId === demoAuth.cfAccountId
  && parsedAgentAuth?.tenantSegment === `demo:${demoAuth.userId}`,
  JSON.stringify(parsedAgentAuth));

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
