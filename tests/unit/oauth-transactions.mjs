import assert from 'node:assert/strict';
import { startDemoLogin, completeDemoLogin, loadDemoAuth } from '../../apps/hosted-demo/src/demo-auth.ts';
import { handleAgentRequest, parseAgentOAuthStateParam } from '../../packages/worker/src/session/agent.ts';
import { SESSION_AI_CREDENTIAL_KEY } from '../../packages/worker/src/session/ai.ts';
import { pkceChallenge, loadNimbusOAuthStateCookie } from '../../packages/sdk/src/oauth.ts';
import { memoryStorage } from './lib/do-storage.mjs';

const now = 1_800_000_000_000;
const realNow = Date.now;
const realFetch = globalThis.fetch;
const secret = 'transaction-cookie-secret-at-least-32-characters';
const origin = 'https://nimbus.example.test';
const accountId = 'a'.repeat(32);
const tokenCalls = [];
const users = [];
const env = {
  NIMBUS_CF_OAUTH_CLIENT_ID: 'public-client', NIMBUS_CF_OAUTH_CLIENT_SECRET: 'confidential-secret',
  NIMBUS_CF_OAUTH_SCOPES: 'user-details.read ai.write', JWT_SECRET: secret,
  DEMO_DB: { prepare: () => ({ bind: (...values) => ({ async run() { users.push(values); } }) }) },
};
const host = { env, ctx: { storage: memoryStorage() } };
const cookie = (response) => response.headers.get('Set-Cookie').split(';', 1)[0];
const request = (path, headers = {}, method = 'GET') => new Request(origin + path, { method, headers });
const agent = (req) => handleAgentRequest(host, req, new URL(req.url));
const response = { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer' };

try {
  Date.now = () => now;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/oauth2/token') {
      tokenCalls.push({ fields: Object.fromEntries(new URLSearchParams(init.body)), headers: new Headers(init.headers) });
      return Response.json(response);
    }
    if (url.pathname === '/oauth2/userinfo') return Response.json({ sub: 'cloudflare-user', name: 'Test user' });
    if (url.pathname === '/client/v4/accounts') return Response.json({ result: [{ id: accountId, name: 'Account' }] });
    throw new Error('unexpected OAuth provider request');
  };

  const demoStart = await startDemoLogin(request('/login?return_to=%2Fnew%3Flaunch%3D1'), env);
  assert.equal(demoStart.status, 302);
  const demoUrl = new URL(demoStart.headers.get('Location'));
  const demoCookie = cookie(demoStart);
  const demoState = await loadNimbusOAuthStateCookie(request('/', { Cookie: demoCookie }), {
    name: '__Host-nimbus_demo_state', purpose: 'nimbus-demo-oauth-state', secret,
  });
  assert.equal(demoUrl.searchParams.get('state'), demoState.nonce);
  assert.equal(demoUrl.searchParams.get('code_challenge'), await pkceChallenge(demoState.codeVerifier));
  assert.equal(demoState.returnTo, '/new?launch=1');
  const rejectedDemo = await completeDemoLogin(request('/api/nimbus/oauth/callback?code=c&state=wrong', { Cookie: demoCookie }), env);
  assert.equal(rejectedDemo.status, 400);
  assert.equal(tokenCalls.length, 0, 'nonce rejection happens before provider exchange');
  const demoDone = await completeDemoLogin(request('/api/nimbus/oauth/callback?code=demo-code&state=' + demoState.nonce, { Cookie: demoCookie }), env);
  assert.equal(demoDone.status, 302);
  assert.equal(demoDone.headers.get('Location'), '/new?launch=1');
  const authCookie = demoDone.headers.getSetCookie().find((value) => value.startsWith('__Host-nimbus_demo_auth=')).split(';', 1)[0];
  const auth = await loadDemoAuth(request('/', { Cookie: authCookie }), env);
  assert.equal(auth.cfTokenExpiresAt, now + (3600 - 30) * 1000);
  assert.equal(users.length, 1);
  assert.equal(tokenCalls[0].fields.code_verifier, demoState.codeVerifier);
  assert.equal(tokenCalls[0].headers.get('Authorization'), 'Basic ' + btoa('public-client:confidential-secret'));

  const routeHeaders = { 'X-Nimbus-Base': '/s/job_123', 'X-Nimbus-Tenant': 'tenant:user' };
  const agentStart = await agent(request('/api/agent/oauth/start', routeHeaders, 'POST'));
  assert.equal(agentStart.status, 200);
  const started = await agentStart.json();
  const agentUrl = new URL(started.authUrl);
  const signed = agentUrl.searchParams.get('state');
  const routed = await parseAgentOAuthStateParam(signed, env);
  assert.equal(routed.sessionId, 'job_123');
  assert.equal(routed.tenantSegment, 'tenant:user');
  const agentCookie = cookie(agentStart);
  const state = await loadNimbusOAuthStateCookie(request('/', { Cookie: agentCookie }), {
    name: '__Host-nimbus_agent_oauth_state', purpose: 'nimbus-agent-oauth-state', secret,
  });
  assert.equal(agentUrl.searchParams.get('code_challenge'), await pkceChallenge(state.codeVerifier));
  assert.equal(await loadNimbusOAuthStateCookie(request('/', { Cookie: agentCookie.replace('__Host-nimbus_agent_oauth_state=', '__Host-nimbus_demo_state=') }), {
    name: '__Host-nimbus_demo_state', purpose: 'nimbus-demo-oauth-state', secret,
  }), null, 'demo and agent state purposes remain cryptographically separate');
  const wrongCookie = agentCookie.replace(/.$/, (last) => last === 'a' ? 'b' : 'a');
  await agent(request('/api/agent/oauth/callback?code=agent-code&state=' + encodeURIComponent(signed), { Cookie: wrongCookie }));
  assert.equal(tokenCalls.length, 1, 'invalid session state does not reach the provider');
  const agentDone = await agent(request('/api/agent/oauth/callback?code=agent-code&state=' + encodeURIComponent(signed), { Cookie: agentCookie }));
  assert.equal(agentDone.status, 200);
  assert.match(await agentDone.text(), /Cloudflare connected/);
  assert.equal(tokenCalls[1].fields.code_verifier, state.codeVerifier);
  assert.deepEqual(await host.ctx.storage.get(SESSION_AI_CREDENTIAL_KEY), {
    accessToken: 'access', refreshToken: 'refresh', accountId, expiresAt: auth.cfTokenExpiresAt,
  });
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
}
console.log('oauth-transactions: ok');
