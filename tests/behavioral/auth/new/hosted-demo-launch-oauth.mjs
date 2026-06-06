#!/usr/bin/env bun
// auth/new/hosted-demo-launch-oauth - the hosted demo launch flow uses the
// already-registered Nimbus OAuth callback and opens a login modal on the
// landing page.

import { readFileSync } from 'node:fs';
import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('auth/new/hosted-demo-launch-oauth');
const {
  DEMO_OAUTH_CALLBACK_PATH,
  readDemoAuthConfig,
  sanitizeReturnTo,
} = await import('../../../../apps/hosted-demo/src/demo-oauth-config.ts');
const {
  createNimbusAgentOAuthCookie,
  loadNimbusAgentOAuthFromRequest,
} = await import('../../../../packages/worker/src/session/agent-oauth.ts');

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
const demoAgentAuthSource = readFileSync(new URL('../../../../apps/hosted-demo/src/demo-agent-auth.ts', import.meta.url), 'utf8');
a.check('landing launch form opens modal',
  html.includes('id="hero-launch-form"')
  && html.includes('id="launch-modal"')
  && html.includes('id="launch-login"'));
a.check('modal login points at authenticated launch return path',
  html.includes('href="/login?return_to=%2Fnew%3Flaunch%3D1"'));
a.check('modal exposes Cloudflare login copy',
  html.includes('Login / Register with Cloudflare'));
a.check('modal does not expose secondary launch/cancel actions',
  !html.includes('id="launch-direct"')
  && !html.includes('id="launch-cancel"')
  && !html.includes('Launch sandbox'));
a.check('launch script checks browser auth endpoint',
  html.includes("fetch('/api/demo/auth/me'"));
a.check('authenticated users submit launch form without modal path',
  html.includes("return 'authenticated'")
  && html.includes('form.submit()')
  && html.indexOf("return 'authenticated'") < html.indexOf('form.submit()'));
a.check('launch script falls back for generic embedders',
  html.includes('form.submit()'));

a.check('hosted demo seeds the shared agent OAuth cookie helper',
  demoAgentAuthSource.includes('createNimbusAgentOAuthCookie')
  && demoAgentAuthSource.includes('cfAccessToken')
  && demoAgentAuthSource.includes('demoTenantSegment'),
  demoAgentAuthSource);

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
const agentCookie = await createNimbusAgentOAuthCookie({
  mode: 'oauth',
  accessToken: demoAuth.cfAccessToken,
  refreshToken: demoAuth.cfRefreshToken,
  tokenType: demoAuth.cfTokenType,
  expiresAt: demoAuth.cfTokenExpiresAt,
  connectedAt: demoAuth.loginAt,
  accountId: demoAuth.cfAccountId,
  sessionId,
  tenantSegment: `demo:${demoAuth.userId}`,
}, '0123456789abcdef0123456789abcdef', `/s/${sessionId}`);
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
