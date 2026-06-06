#!/usr/bin/env bun
// auth/new/router-session-scope-and-pin - createNimbusHandler enforces
// session:create on /new and session:attach + sid pinning on /s/<id> routes.

import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('auth/new/router-session-scope-and-pin');
const { createNimbusHandler } = await import('../../../../packages/worker/src/router/index.ts');
const { issueNimbusToken } = await import('../../../../packages/worker/src/auth/token.ts');

class FakeNamespace {
  constructor() {
    this.names = [];
    this.requests = [];
  }
  idFromName(name) {
    this.names.push(name);
    return { name };
  }
  get(_id) {
    return {
      fetch: async (request) => {
        this.requests.push(request);
        return Response.json({
          ok: true,
          innerPath: new URL(request.url).pathname,
          tenant: request.headers.get('X-Nimbus-Tenant'),
          base: request.headers.get('X-Nimbus-Base'),
        });
      },
    };
  }
}

const env = {
  JWT_SECRET: 'router-scope-secret',
  NIMBUS_SESSION: new FakeNamespace(),
};
const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
const ctx = { waitUntil() {} };

async function request(path, token, init = {}) {
  return handler.fetch(new Request(`https://nimbus.example.com${path}`, {
    method: init.method ?? 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'manual',
  }), env, ctx);
}

const newMissing = await request('/new', null, { method: 'POST' });
const newMissingJson = await newMissing.json();
a.check('/new rejects missing token in enforce mode',
  newMissing.status === 401 && newMissingJson.code === 'E_TOKEN_MALFORMED');

const createWrongScopeToken = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['session:attach'],
});
const newWrongScope = await request('/new', createWrongScopeToken, { method: 'POST' });
const newWrongScopeJson = await newWrongScope.json();
a.check('/new requires session:create scope',
  newWrongScope.status === 403 && newWrongScopeJson.code === 'E_SCOPE_MISSING');

const createToken = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['session:create'],
});
const created = await request('/new', createToken, { method: 'POST' });
a.check('/new redirects with session:create scope',
  created.status === 302 && /^\/s\/[^/]+\/$/.test(created.headers.get('Location') || ''),
  created.headers.get('Location') || '');

const attachWrongScopeToken = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['session:create'],
  sid: 'job-123',
});
const attachWrongScope = await request('/s/job-123/api/stats', attachWrongScopeToken);
const attachWrongScopeJson = await attachWrongScope.json();
a.check('/s routes require session:attach scope',
  attachWrongScope.status === 403 && attachWrongScopeJson.code === 'E_SCOPE_MISSING');

const attachWrongSidToken = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['session:attach'],
  sid: 'other-job',
});
const attachWrongSid = await request('/s/job-123/api/stats', attachWrongSidToken);
const attachWrongSidJson = await attachWrongSid.json();
a.check('/s routes enforce sid pinning',
  attachWrongSid.status === 403 && attachWrongSidJson.code === 'E_SESSION_PIN_MISMATCH');

const attachToken = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['session:attach'],
  sid: 'job-123',
});
const attached = await request('/s/job-123/api/stats', attachToken);
const attachedJson = await attached.json();
a.check('/s routes forward with valid attach token',
  attached.status === 200
  && attachedJson.innerPath === '/api/stats'
  && attachedJson.tenant === 'acme:alice'
  && attachedJson.base === '/s/job-123');
a.check('/s routes use token tenant for DO name',
  env.NIMBUS_SESSION.names.at(-1) === 'acme:alice:job-123',
  env.NIMBUS_SESSION.names.at(-1));

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
