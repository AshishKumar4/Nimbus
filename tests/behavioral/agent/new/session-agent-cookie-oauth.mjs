#!/usr/bin/env bun
// agent/new/session-agent-cookie-oauth — Cloudflare OAuth state is held in
// encrypted browser cookies, not Durable Object storage.

import { readFileSync } from 'node:fs';
import { makeAsserter } from '../../_driver.mjs';
import { handleAgentRequest } from '../../../../packages/worker/src/session/agent.ts';

const a = makeAsserter('agent/new/session-agent-cookie-oauth');

function host(env = {}) {
  const writes = [];
  const deletes = [];
  return {
    self: {
      env: {
        NIMBUS_CF_OAUTH_CLIENT_ID: 'oauth-client-id',
        NIMBUS_CF_OAUTH_SCOPES: 'com.cloudflare.api.account.ai_gateway.read com.cloudflare.api.account.ai_gateway.edit',
        NIMBUS_AGENT_COOKIE_SECRET: '0123456789abcdef0123456789abcdef',
        ...env,
      },
      ctx: {
        storage: {
          async get() { return undefined; },
          async put(key, value) { writes.push({ key, value }); },
          async delete(key) { deletes.push(key); },
        },
      },
    },
    writes,
    deletes,
  };
}

function request(path, init = {}) {
  return new Request(`https://nimbus.example.com${path}`, {
    ...init,
    headers: {
      'X-Nimbus-Base': '/s/oauth-test-123',
      'X-Nimbus-Tenant': 'legacy:public:_',
      ...(init.headers || {}),
    },
  });
}

{
  const h = host();
  const req = request('/api/agent/oauth/start', { method: 'POST' });
  const res = await handleAgentRequest(h.self, req, new URL(req.url));
  const body = await res.json();
  const setCookie = res.headers.get('Set-Cookie') || '';
  const authUrl = new URL(body.authUrl);

  a.check('OAuth start succeeds with cookie secret',
    res.status === 200 && body.ok === true,
    `status=${res.status} body=${JSON.stringify(body)}`);
  a.check('OAuth start uses Cloudflare authorization code + PKCE',
    authUrl.origin === 'https://dash.cloudflare.com'
    && authUrl.pathname === '/oauth2/auth'
    && authUrl.searchParams.get('response_type') === 'code'
    && authUrl.searchParams.get('code_challenge_method') === 'S256'
    && !!authUrl.searchParams.get('code_challenge')
    && !!authUrl.searchParams.get('state'),
    authUrl.toString());
  a.check('OAuth state is returned as a secure HttpOnly cookie',
    setCookie.includes('__Host-nimbus_agent_oauth_state=')
    && setCookie.includes('Path=/')
    && setCookie.includes('Max-Age=600')
    && setCookie.includes('HttpOnly')
    && setCookie.includes('Secure')
    && setCookie.includes('SameSite=Lax'),
    setCookie);
  a.check('OAuth start does not write auth or state to DO storage',
    h.writes.length === 0 && h.deletes.length === 0,
    `writes=${JSON.stringify(h.writes)} deletes=${JSON.stringify(h.deletes)}`);
}

{
  const h = host({ NIMBUS_AGENT_COOKIE_SECRET: '', JWT_SECRET: '' });
  const req = request('/api/agent/oauth/start', { method: 'POST' });
  const res = await handleAgentRequest(h.self, req, new URL(req.url));
  const body = await res.json();
  a.check('OAuth start fails closed without a cookie encryption secret',
    res.status === 409 && body.code === 'E_AGENT_COOKIE_SECRET',
    `status=${res.status} body=${JSON.stringify(body)}`);
}

{
  const source = readFileSync(new URL('../../../../packages/worker/src/session/agent.ts', import.meta.url), 'utf8');
  a.check('OAuth auth token storage key is absent from source',
    !source.includes('nimbus:agent:auth'),
    'source still contains nimbus:agent:auth');
  a.check('OAuth state storage key is absent from source',
    !source.includes('oauth-state'),
    'source still contains oauth-state');
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
