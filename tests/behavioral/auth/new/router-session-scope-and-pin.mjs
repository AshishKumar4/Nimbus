#!/usr/bin/env bun
// auth/new/router-session-scope-and-pin - createNimbusHandler enforces
// session:create on /new and session:attach + sid pinning on /s/<id> routes,
// and runs the attach exchange: /new mints a short-lived single-use bootstrap
// attach URL; visiting it sets the session cookie (set-if-absent jti consume
// in the session DO) and redirects to the clean /s/<id>/ URL.

import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('auth/new/router-session-scope-and-pin');
const { createNimbusHandler } = await import('../../../../packages/worker/src/router/index.ts');
const { issueNimbusToken, verifyNimbusToken } = await import('../../../../packages/worker/src/auth/token.ts');

class FakeNamespace {
  constructor() {
    this.names = [];
    this.requests = [];
    this.consumedByName = new Map();
  }
  idFromName(name) {
    this.names.push(name);
    return { name };
  }
  get(id) {
    const namespace = this;
    return {
      async _rpcConsumeAttachBootstrap(jti) {
        let consumed = namespace.consumedByName.get(id.name);
        if (!consumed) {
          consumed = new Set();
          namespace.consumedByName.set(id.name, consumed);
        }
        if (consumed.has(jti)) return false;
        consumed.add(jti);
        return true;
      },
      fetch: async (request) => {
        namespace.requests.push(request);
        return Response.json({
          ok: true,
          innerPath: new URL(request.url).pathname,
          search: new URL(request.url).search,
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
  const headers = new Headers(init.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return handler.fetch(new Request(`https://nimbus.example.com${path}`, {
    method: init.method ?? 'GET',
    headers,
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

// ── /new with Bearer → bootstrap attach URL ──────────────────────────────
const createToken = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['session:create'],
});
const created = await request('/new', createToken, { method: 'POST' });
const createdLocation = created.headers.get('Location') || '';
const locationMatch = createdLocation.match(/^\/s\/([^/]+)\/\?nimbus_token=([^&]+)$/);
a.check('/new redirects to a bootstrap attach URL',
  created.status === 302 && !!locationMatch,
  `status=${created.status} location=${createdLocation}`);
a.check('/new never puts the caller token in the attach URL',
  !createdLocation.includes(createToken), createdLocation);

const createdSid = locationMatch[1];
const bootstrapToken = decodeURIComponent(locationMatch[2]);
const bootstrap = await verifyNimbusToken(env, bootstrapToken);
a.check('bootstrap token is single-use, sid-pinned, bootstrap-scoped, and short-lived',
  bootstrap.claims.tn === 'acme'
  && bootstrap.claims.sub === 'alice'
  && bootstrap.claims.sid === createdSid
  && typeof bootstrap.claims.jti === 'string'
  && Array.isArray(bootstrap.claims.scopes)
  && bootstrap.claims.scopes.length === 1
  && bootstrap.claims.scopes[0] === 'session:bootstrap'
  && (bootstrap.claims.exp - bootstrap.claims.iat) <= 120,
  JSON.stringify(bootstrap.claims));

// ── Attach exchange: cookie + clean redirect ─────────────────────────────
const exchanged = await request(createdLocation, null);
const exchangedLocation = exchanged.headers.get('Location') || '';
const exchangedCookie = exchanged.headers.get('Set-Cookie') || '';
a.check('attach exchange redirects to the clean session URL',
  exchanged.status === 302
  && exchangedLocation === `/s/${createdSid}/`
  && !exchangedLocation.includes('nimbus_token'),
  `status=${exchanged.status} location=${exchangedLocation}`);
a.check('attach exchange sets a hardened session cookie',
  exchangedCookie.startsWith('__Host-nimbus_token=')
  && exchangedCookie.includes('Path=/')
  && exchangedCookie.includes('SameSite=None')
  && exchangedCookie.includes('HttpOnly')
  && exchangedCookie.includes('Secure')
  && exchangedCookie.includes('Partitioned'),
  exchangedCookie);

const cookiePair = exchangedCookie.split(';', 1)[0];
const cookieClaims = (await verifyNimbusToken(env, decodeURIComponent(cookiePair.slice('__Host-nimbus_token='.length)))).claims;
a.check('session cookie holds a fresh sid-pinned attach-only token (not the bootstrap)',
  cookieClaims.sid === createdSid
  && cookieClaims.jti === undefined
  && Array.isArray(cookieClaims.scopes)
  && cookieClaims.scopes.length === 1
  && cookieClaims.scopes[0] === 'session:attach',
  JSON.stringify(cookieClaims));

const cookieOnlyAttach = await request(`/s/${createdSid}/api/stats`, null, {
  headers: { Cookie: cookiePair },
});
const cookieOnlyAttachJson = await cookieOnlyAttach.json();
a.check('session routes attach with only the session cookie',
  cookieOnlyAttach.status === 200
  && cookieOnlyAttachJson.innerPath === '/api/stats'
  && cookieOnlyAttachJson.tenant === 'acme:alice',
  JSON.stringify(cookieOnlyAttachJson));

// ── Single-use: replaying the attach URL fails ───────────────────────────
const replayed = await request(createdLocation, null);
const replayedJson = await replayed.json();
a.check('replayed bootstrap attach URL is rejected',
  replayed.status === 401
  && replayedJson.code === 'E_BOOTSTRAP_CONSUMED'
  && !(replayed.headers.get('Set-Cookie') || '').includes('__Host-nimbus_token='),
  `status=${replayed.status} body=${JSON.stringify(replayedJson)}`);

// ── Bootstrap tokens open nothing except the exchange ────────────────────
const strayBootstrap = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['session:bootstrap'],
  sid: createdSid,
  jti: 'stray-bootstrap-jti',
});
const bootstrapOnApi = await request(`/s/${createdSid}/api/stats`, strayBootstrap);
const bootstrapOnApiJson = await bootstrapOnApi.json();
a.check('bootstrap token cannot call session APIs even before consumption',
  bootstrapOnApi.status === 403 && bootstrapOnApiJson.code === 'E_SCOPE_MISSING',
  `status=${bootstrapOnApi.status} body=${JSON.stringify(bootstrapOnApiJson)}`);

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

// ── Embedder iframe tokens go through the same exchange ──────────────────
const iframeToken = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'query-user',
  scopes: ['session:attach'],
  sid: 'query-job',
});
const iframeExchange = await request(`/s/query-job/?embed=1&nimbus_token=${encodeURIComponent(iframeToken)}`, null);
const iframeLocation = iframeExchange.headers.get('Location') || '';
const iframeCookie = iframeExchange.headers.get('Set-Cookie') || '';
a.check('embedder query token on the shell URL exchanges into a cookie and clean redirect',
  iframeExchange.status === 302
  && iframeLocation === '/s/query-job/?embed=1'
  && iframeCookie.startsWith('__Host-nimbus_token=')
  && iframeCookie.includes('HttpOnly'),
  `status=${iframeExchange.status} location=${iframeLocation} cookie=${iframeCookie}`);
const iframeCookieClaims = (await verifyNimbusToken(
  env,
  decodeURIComponent(iframeCookie.split(';', 1)[0].slice('__Host-nimbus_token='.length)),
)).claims;
a.check('embedder exchange narrows the cookie token to sid-pinned attach with the same lifetime',
  iframeCookieClaims.sid === 'query-job'
  && iframeCookieClaims.scopes.length === 1
  && iframeCookieClaims.scopes[0] === 'session:attach'
  && Math.abs(iframeCookieClaims.exp - (await verifyNimbusToken(env, iframeToken)).claims.exp) <= 2,
  JSON.stringify(iframeCookieClaims));

// ── Non-shell query tokens authenticate but never produce cookies ────────
const attachedWithQuery = await request(`/s/query-job/api/stats?x=1&nimbus_token=${encodeURIComponent(iframeToken)}`, null);
const attachedWithQueryJson = await attachedWithQuery.json();
a.check('/s API query token authenticates, is stripped before DO forwarding, and sets no cookie',
  attachedWithQuery.status === 200
  && attachedWithQueryJson.search === '?x=1'
  && attachedWithQueryJson.tenant === 'acme:query-user'
  && attachedWithQuery.headers.get('Set-Cookie') === null,
  `status=${attachedWithQuery.status} json=${JSON.stringify(attachedWithQueryJson)} cookie=${attachedWithQuery.headers.get('Set-Cookie')}`);

// ── Single-use under concurrency: exactly one racing exchange wins ───────
// Durable Object input gates hold across the whole _rpcConsumeAttachBootstrap
// body, so the check and the put are atomic per session DO. This fake
// emulates that gate (one RPC at a time, body runs to completion) while the
// body itself yields — so a regression that splits the consume into separate
// check/set RPCs, or mints the cookie before consuming, fails here.
class GatedNamespace extends FakeNamespace {
  constructor() {
    super();
    this.gate = Promise.resolve();
  }
  get(id) {
    const inner = super.get(id);
    const namespace = this;
    return {
      ...inner,
      _rpcConsumeAttachBootstrap: (jti) => {
        const run = namespace.gate.then(async () => {
          let consumed = namespace.consumedByName.get(id.name);
          if (!consumed) {
            consumed = new Set();
            namespace.consumedByName.set(id.name, consumed);
          }
          const present = consumed.has(jti);
          await Promise.resolve();
          if (present) return false;
          consumed.add(jti);
          return true;
        });
        namespace.gate = run.then(() => {}, () => {});
        return run;
      },
    };
  }
}

{
  const racingEnv = { JWT_SECRET: 'router-scope-secret', NIMBUS_SESSION: new GatedNamespace() };
  const raceCreate = await handler.fetch(new Request('https://nimbus.example.com/new', {
    method: 'POST',
    headers: { Authorization: `Bearer ${createToken}` },
    redirect: 'manual',
  }), racingEnv, ctx);
  const raceLocation = raceCreate.headers.get('Location');
  const attach = () => handler.fetch(
    new Request(`https://nimbus.example.com${raceLocation}`, { redirect: 'manual' }),
    racingEnv,
    ctx,
  );
  const [r1, r2] = await Promise.all([attach(), attach()]);
  const statuses = [r1.status, r2.status].sort();
  const cookies = [r1, r2].filter((r) => (r.headers.get('Set-Cookie') || '').includes('__Host-nimbus_token='));
  const rejected = [r1, r2].find((r) => r.status === 401);
  const rejectedJson = rejected ? await rejected.json() : null;
  a.check('exactly one of two concurrent bootstrap exchanges wins',
    statuses[0] === 302 && statuses[1] === 401
    && cookies.length === 1
    && rejectedJson?.code === 'E_BOOTSTRAP_CONSUMED',
    `statuses=${JSON.stringify(statuses)} cookies=${cookies.length} rejected=${JSON.stringify(rejectedJson)}`);
}

// ── Bootstrap tokens must be sid-pinned ──────────────────────────────────
const unpinnedBootstrap = await issueNimbusToken(env, {
  tn: 'acme',
  sub: 'alice',
  scopes: ['session:bootstrap'],
  jti: 'unpinned-jti-1',
});
const unpinnedExchange = await request(`/s/${createdSid}/?nimbus_token=${encodeURIComponent(unpinnedBootstrap)}`, null);
const unpinnedJson = await unpinnedExchange.json();
a.check('a jti-bearing bootstrap token without sid is rejected and sets no cookie',
  unpinnedExchange.status === 401
  && unpinnedJson.code === 'E_TOKEN_CLAIMS'
  && unpinnedExchange.headers.get('Set-Cookie') === null,
  `status=${unpinnedExchange.status} body=${JSON.stringify(unpinnedJson)}`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
