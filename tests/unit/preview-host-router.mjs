#!/usr/bin/env bun
// preview-host-router — the `<port>--<sid>.<suffix>` origin end to end.
//
// The invariant under test is that a preview host is NOT part of the Nimbus
// control plane. It serves untrusted user code at its root, so the router must
// answer there with the port forward and nothing else — no embedder route, no
// `/new`, no `/s/*`, no OAuth callback, no remote SDK API, no asset
// fallthrough — and the credential that opens it must be single-use and
// useless anywhere else.

import assert from 'node:assert/strict';
import { issueNimbusToken, verifyNimbusToken } from '../../packages/worker/src/auth/token.ts';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';

class FakeNamespace {
  names = [];
  requests = [];
  consumedJtis = new Set();

  idFromName(name) {
    this.names.push(name);
    return { name };
  }

  get() {
    return {
      fetch: async (request) => {
        this.requests.push(request);
        const url = new URL(request.url);
        return Response.json({
          pathname: url.pathname,
          search: url.search,
          base: request.headers.get('X-Nimbus-Base'),
          tenant: request.headers.get('X-Nimbus-Tenant'),
          upgrade: request.headers.get('Upgrade'),
        });
      },
      _rpcConsumeAttachBootstrap: async (jti) => {
        if (this.consumedJtis.has(jti)) return false;
        this.consumedJtis.add(jti);
        return true;
      },
    };
  }
}

class FakeAssets {
  requests = [];
  async fetch(request) {
    this.requests.push(request);
    return new Response('static asset', { status: 200 });
  }
}

const ctx = { waitUntil() {} };
const suffix = 'nimbus-os.dev';
const sid = 'nimble-otter-4271';

function enforcingEnv(extra = {}) {
  return {
    JWT_SECRET: 'preview-router-secret',
    NIMBUS_PREVIEW_HOST_SUFFIX: suffix,
    NIMBUS_SESSION: new FakeNamespace(),
    ...extra,
  };
}

async function mintPreviewUrl(handler, env, attachToken, port = 3000) {
  const response = await handler.fetch(
    new Request(`https://nimbus-os.dev/s/${sid}/api/preview-url?port=${port}`, {
      headers: { Authorization: `Bearer ${attachToken}` },
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return new URL((await response.json()).url);
}

// ── the happy path: mint → exchange → forward ─────────────────────────────
{
  const env = enforcingEnv();
  const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
  const attachToken = await issueNimbusToken(env, {
    tn: 'acme',
    sub: 'alice',
    scopes: ['session:attach'],
    sid,
  });

  const previewUrl = await mintPreviewUrl(handler, env, attachToken);
  assert.equal(previewUrl.origin, `https://3000--${sid}.${suffix}`);
  assert.equal(previewUrl.pathname, '/');

  const minted = await verifyNimbusToken(env, previewUrl.searchParams.get('nimbus_token'));
  assert.equal(minted.claims.sid, sid);
  // Narrow scope: the preview URL is a link, so it must not double as a
  // session credential anywhere else.
  assert.deepEqual(minted.claims.scopes, ['session:preview']);
  // Single-use: a `jti` is consumed set-if-absent by the exchange.
  assert.equal(typeof minted.claims.jti, 'string');
  assert.ok(minted.claims.exp - minted.claims.iat <= 90);

  const exchanged = await handler.fetch(new Request(previewUrl, { redirect: 'manual' }), env, ctx);
  assert.equal(exchanged.status, 302);
  assert.equal(exchanged.headers.get('Location'), '/');
  const setCookie = exchanged.headers.get('Set-Cookie');
  // `__Host-` is what stops untrusted preview code from setting a shadowing
  // `nimbus_token` for the parent domain: the browser rejects the prefix with
  // a Domain attribute or a Path other than `/`.
  assert.match(setCookie, /^__Host-nimbus_token=/);
  assert.match(setCookie, /; Path=\/;/);
  assert.doesNotMatch(setCookie, /Domain=/i);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; HttpOnly/);

  const cookie = setCookie.split(';', 1)[0];
  const routed = await handler.fetch(
    new Request(`https://3000--${sid}.${suffix}/style.css?v=1`, {
      headers: { Cookie: cookie },
    }),
    env,
    ctx,
  );
  assert.deepEqual(await routed.json(), {
    pathname: '/port/3000/style.css',
    search: '?v=1',
    base: '',
    tenant: 'acme:alice',
    upgrade: null,
  });
  assert.equal(env.NIMBUS_SESSION.names.at(-1), `acme:alice:${sid}`);

  // The cookie token is a plain sid-pinned attach token — the presented
  // `session:preview` scope is never persisted browser-side.
  const cookieClaims = (await verifyNimbusToken(
    env,
    decodeURIComponent(cookie.slice('__Host-nimbus_token='.length)),
  )).claims;
  assert.deepEqual(cookieClaims.scopes, ['session:attach']);
  assert.equal(cookieClaims.jti, undefined);

  const wrongSidToken = await issueNimbusToken(env, {
    tn: 'acme',
    sub: 'alice',
    scopes: ['session:attach'],
    sid: 'other-session',
  });
  const wrongSid = await handler.fetch(
    new Request(`https://3000--${sid}.${suffix}/`, {
      headers: { Authorization: `Bearer ${wrongSidToken}` },
    }),
    env,
    ctx,
  );
  assert.equal(wrongSid.status, 403);
  assert.equal((await wrongSid.json()).code, 'E_SESSION_PIN_MISMATCH');
}

// ── the preview URL is single-use, and useless elsewhere ──────────────────
{
  const env = enforcingEnv();
  const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
  const attachToken = await issueNimbusToken(env, {
    tn: 'acme', sub: 'alice', scopes: ['session:attach'], sid,
  });
  const previewUrl = await mintPreviewUrl(handler, env, attachToken);
  const token = previewUrl.searchParams.get('nimbus_token');

  const first = await handler.fetch(new Request(previewUrl, { redirect: 'manual' }), env, ctx);
  assert.equal(first.status, 302);

  const replay = await handler.fetch(new Request(previewUrl, { redirect: 'manual' }), env, ctx);
  assert.equal(replay.status, 401, 'a replayed preview URL must not mint a second cookie');
  assert.equal((await replay.json()).code, 'E_BOOTSTRAP_CONSUMED');
  assert.equal(replay.headers.get('Set-Cookie'), null);

  // Replaying it against the session API (the original finding) fails on scope
  // alone — it never had `session:attach`.
  const stolen = await handler.fetch(
    new Request(`https://nimbus-os.dev/s/${sid}/api/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    ctx,
  );
  assert.equal(stolen.status, 403);
  assert.equal((await stolen.json()).code, 'E_SCOPE_MISSING');

  // ...and it cannot attach to the preview host as a bearer token either.
  const bearer = await handler.fetch(
    new Request(`https://3000--${sid}.${suffix}/assets/app.js`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    ctx,
  );
  assert.equal(bearer.status, 403);
}

// ── the exchange keeps the requested path; the app owns it ────────────────
{
  const env = enforcingEnv();
  const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
  const attachToken = await issueNimbusToken(env, {
    tn: 'acme', sub: 'alice', scopes: ['session:attach'], sid,
  });
  const previewUrl = await mintPreviewUrl(handler, env, attachToken);
  const deep = new URL(previewUrl);
  deep.pathname = '/deep/page';
  deep.searchParams.set('foo', '1');

  const exchanged = await handler.fetch(new Request(deep, { redirect: 'manual' }), env, ctx);
  assert.equal(exchanged.status, 302);
  const location = new URL(exchanged.headers.get('Location'), deep.origin);
  assert.equal(location.pathname, '/deep/page', 'the deep link must survive the exchange');
  assert.equal(location.searchParams.get('foo'), '1', 'app query params must survive');
  assert.equal(location.searchParams.get('nimbus_token'), null, 'the token must be stripped');
}

// ── reusable embedder tokens are rejected at the preview exchange ─────────
{
  const env = enforcingEnv();
  const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
  // A no-jti `session:attach` token is what `<NimbusTerminal>` puts on the
  // `/s/<id>/` shell URL. On a preview host it must not open an exchange —
  // only the single-use `session:preview` mint may.
  const reusable = await issueNimbusToken(env, {
    tn: 'acme', sub: 'alice', scopes: ['session:attach'], sid,
  });
  const response = await handler.fetch(
    new Request(`https://3000--${sid}.${suffix}/?nimbus_token=${encodeURIComponent(reusable)}`, {
      redirect: 'manual',
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'E_TOKEN_CLAIMS');
  assert.equal(response.headers.get('Set-Cookie'), null);

  // A `session:bootstrap` token — the `/s/` shell's own single-use kind —
  // is likewise not accepted here.
  const bootstrap = await issueNimbusToken(env, {
    tn: 'acme', sub: 'alice', scopes: ['session:bootstrap'], sid, jti: crypto.randomUUID(),
  });
  const crossKind = await handler.fetch(
    new Request(`https://3000--${sid}.${suffix}/?nimbus_token=${encodeURIComponent(bootstrap)}`, {
      redirect: 'manual',
    }),
    env,
    ctx,
  );
  assert.equal(crossKind.status, 403);
  assert.equal((await crossKind.json()).code, 'E_SCOPE_MISSING');
}

// ── a preview host reaches NOTHING but the port forward ───────────────────
{
  const controlPlanePaths = [
    '/login',                        // embedder route (hosted-demo)
    '/logout',
    '/new',
    '/api/demo/auth/me',
    '/api/sdk-smoke',
    `/s/${sid}/api/stats`,
    `/s/${sid}/`,
    '/api/nimbus/oauth/callback',
    '/api/nimbus/v1/sandboxes',
    '/index.html',
    '/favicon.ico',
  ];
  const env = {
    NIMBUS_PREVIEW_HOST_SUFFIX: suffix,
    NIMBUS_SESSION: new FakeNamespace(),
    ASSETS: new FakeAssets(),
  };
  let embedderRouteHits = 0;
  const handler = createNimbusHandler({
    auth: { mode: 'legacy' },
    sdk: { remote: true },
    routes: async () => {
      embedderRouteHits += 1;
      return new Response('embedder route', { status: 200 });
    },
  });

  for (const pathname of controlPlanePaths) {
    const response = await handler.fetch(
      new Request(`https://3000--${sid}.${suffix}${pathname}`),
      env,
      ctx,
    );
    const body = await response.json();
    assert.equal(
      body.pathname,
      `/port/3000${pathname}`,
      `${pathname} on a preview host must forward to the port, got ${JSON.stringify(body)}`,
    );
  }
  assert.equal(embedderRouteHits, 0, 'embedder routes must not run on a preview host');
  assert.equal(env.ASSETS.requests.length, 0, 'assets must not be served on a preview host');
}

// ── WebSocket upgrades forward untouched, exchange or not ─────────────────
{
  const env = enforcingEnv();
  const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
  const attachToken = await issueNimbusToken(env, {
    tn: 'acme', sub: 'alice', scopes: ['session:attach'], sid,
  });
  const previewUrl = await mintPreviewUrl(handler, env, attachToken);

  // The real shape: the page load exchanges the preview token for the cookie,
  // then the app's own WebSocket rides that cookie.
  const exchanged = await handler.fetch(new Request(previewUrl, { redirect: 'manual' }), env, ctx);
  const cookie = exchanged.headers.get('Set-Cookie').split(';', 1)[0];
  const viaCookie = await handler.fetch(
    new Request(`https://3000--${sid}.${suffix}/hmr`, {
      headers: { Cookie: cookie, Upgrade: 'websocket' },
    }),
    env,
    ctx,
  );
  assert.equal(viaCookie.status, 200);
  assert.deepEqual(await viaCookie.json(), {
    pathname: '/port/3000/hmr',
    search: '',
    base: '',
    tenant: 'acme:alice',
    upgrade: 'websocket',
  });

  // An upgrade carrying `?nimbus_token=` must NOT be diverted into a 302
  // cookie exchange — that would break the handshake. It authenticates
  // directly, and the credential is stripped before the DO sees the URL.
  const viaQuery = await handler.fetch(
    new Request(
      `https://3000--${sid}.${suffix}/hmr?nimbus_token=${encodeURIComponent(attachToken)}&hot=1`,
      { headers: { Upgrade: 'websocket' } },
    ),
    env,
    ctx,
  );
  assert.equal(viaQuery.status, 200, 'a WS upgrade must reach the session, not a redirect');
  const body = await viaQuery.json();
  assert.equal(body.pathname, '/port/3000/hmr');
  assert.equal(body.upgrade, 'websocket');
  assert.equal(body.search, '?hot=1', 'the token must be stripped before the DO sees it');
  assert.equal(
    env.NIMBUS_SESSION.consumedJtis.size,
    1,
    'only the page-load exchange may burn a single-use jti',
  );
}

// ── /api/preview-url input validation ─────────────────────────────────────
{
  const env = enforcingEnv();
  const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
  const attachToken = await issueNimbusToken(env, {
    tn: 'acme', sub: 'alice', scopes: ['session:attach'], sid,
  });
  const badPorts = ['', '?port=', '?port=abc', '?port=-1', '?port=0', '?port=65536', '?port=3000.5', '?port=+3000', '?port=1e3'];
  for (const query of badPorts) {
    const response = await handler.fetch(
      new Request(`https://nimbus-os.dev/s/${sid}/api/preview-url${query}`, {
        headers: { Authorization: `Bearer ${attachToken}` },
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 400, `preview-url${query || ' (no port)'} must be rejected`);
    assert.equal((await response.json()).error, 'Invalid port');
  }

  // A sid that cannot be a DNS label has no preview host; the endpoint says so
  // rather than handing back an unreachable URL.
  const unsafeSidToken = await issueNimbusToken(env, {
    tn: 'acme', sub: 'alice', scopes: ['session:attach'], sid: 'sdk.sandbox',
  });
  const unavailable = await handler.fetch(
    new Request('https://nimbus-os.dev/s/sdk.sandbox/api/preview-url?port=3000', {
      headers: { Authorization: `Bearer ${unsafeSidToken}` },
    }),
    env,
    ctx,
  );
  assert.deepEqual(await unavailable.json(), { url: null, reason: 'unavailable' });

  // Same when the deployment has no preview host suffix at all.
  const noSuffixEnv = { JWT_SECRET: env.JWT_SECRET, NIMBUS_SESSION: new FakeNamespace() };
  const noSuffix = await handler.fetch(
    new Request(`https://nimbus-os.dev/s/${sid}/api/preview-url?port=3000`, {
      headers: { Authorization: `Bearer ${attachToken}` },
    }),
    noSuffixEnv,
    ctx,
  );
  assert.deepEqual(await noSuffix.json(), { url: null, reason: 'unavailable' });
}

// ── legacy (unauthenticated) mode still forwards ──────────────────────────
{
  const env = {
    NIMBUS_PREVIEW_HOST_SUFFIX: suffix,
    NIMBUS_SESSION: new FakeNamespace(),
  };
  const handler = createNimbusHandler({ auth: { mode: 'legacy' } });
  const response = await handler.fetch(
    new Request(`https://4173--${sid}.${suffix}/api/health?ready=1`),
    env,
    ctx,
  );
  assert.deepEqual(await response.json(), {
    pathname: '/port/4173/api/health',
    search: '?ready=1',
    base: '',
    tenant: 'legacy:public:_',
    upgrade: null,
  });
}

// ── suffix unset → the host is not a preview host ─────────────────────────
{
  const env = { NIMBUS_SESSION: new FakeNamespace() };
  const handler = createNimbusHandler({ auth: { mode: 'legacy' } });
  const response = await handler.fetch(
    new Request(`https://3000--${sid}.${suffix}/`),
    env,
    ctx,
  );
  assert.equal(response.status, 404);
}

// ── a non-string suffix binding must not take the Worker down ─────────────
// `run_worker_first` makes this handler the entry point for the whole public
// site, so a misconfigured binding degrading to "previews off" is the only
// acceptable behavior — a throw would 500 every request, including `/`.
{
  for (const bad of [1234, true, {}, [], () => {}, '']) {
    const env = {
      JWT_SECRET: 'preview-router-secret',
      NIMBUS_PREVIEW_HOST_SUFFIX: bad,
      NIMBUS_SESSION: new FakeNamespace(),
      ASSETS: new FakeAssets(),
    };
    const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
    for (const host of [`https://3000--${sid}.${suffix}/`, 'https://nimbus-os.dev/']) {
      const response = await handler.fetch(new Request(host), env, ctx);
      assert.equal(response.status, 200, `${host} with suffix=${String(bad)} must not fail`);
      assert.equal(await response.text(), 'static asset');
    }
  }
}

// ── unclaimed paths fall through to env.ASSETS ────────────────────────────
// This is the default path for ALL static traffic under `run_worker_first`:
// the landing page, /docs, every image and stylesheet.
{
  const env = enforcingEnv({ ASSETS: new FakeAssets() });
  const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
  const staticPaths = ['/', '/docs/', '/docs/guides/index.html', '/favicon.ico', '/_assets/app.css'];
  for (const pathname of staticPaths) {
    const response = await handler.fetch(new Request(`https://nimbus-os.dev${pathname}`), env, ctx);
    assert.equal(response.status, 200, `${pathname} must be served from assets`);
    assert.equal(await response.text(), 'static asset');
  }
  assert.deepEqual(
    env.ASSETS.requests.map((r) => new URL(r.url).pathname),
    staticPaths,
    'the original request must reach the assets binding unmodified',
  );
  assert.equal(env.NIMBUS_SESSION.requests.length, 0, 'static traffic must not reach a session');

  // Non-preview subdomains caught by the wildcard route land here too, rather
  // than 404ing or being misparsed as a preview.
  const wildcardHosts = [
    'https://www.nimbus-os.dev/',
    'https://1a2b3c4d-nimbus.nimbus-os.dev/',
    `https://sid.extra.${suffix}/`,
    `https://03000--${sid}.${suffix}/`,      // leading-zero port: not a preview host
    `https://0000003000--${sid}.${suffix}/`,
    `https://3000--sdk.sandbox.${suffix}/`,  // sid that is not a DNS label
  ];
  for (const host of wildcardHosts) {
    const response = await handler.fetch(new Request(host), env, ctx);
    assert.equal(response.status, 200, `${host} must fall through to assets`);
    assert.equal(await response.text(), 'static asset');
  }
  assert.equal(env.NIMBUS_SESSION.requests.length, 0, 'no non-preview host may reach a session');
}

// ── the canonical host and its trailing-dot FQDN are one origin ───────────
// A trailing dot is a distinct browser origin with its own cookie jar; if it
// missed the suffix match it would serve the Nimbus landing page there.
{
  const env = {
    NIMBUS_PREVIEW_HOST_SUFFIX: suffix,
    NIMBUS_SESSION: new FakeNamespace(),
    ASSETS: new FakeAssets(),
  };
  const handler = createNimbusHandler({ auth: { mode: 'legacy' } });
  const response = await handler.fetch(new Request(`https://3000--${sid}.${suffix}./app.js`), env, ctx);
  assert.deepEqual(await response.json(), {
    pathname: '/port/3000/app.js',
    search: '',
    base: '',
    tenant: 'legacy:public:_',
    upgrade: null,
  });
  assert.equal(env.ASSETS.requests.length, 0, 'the trailing-dot FQDN must not serve Nimbus assets');
}

// ── non-preview hosts fall through cleanly, never 500 ─────────────────────
// With the suffix configured the wildcard route catches every subdomain, so
// any host that is NOT a `<port>--<sid>` preview must reach normal handling.
{
  const nonPreviewHosts = [
    `https://${suffix}/`,                       // apex
    'https://www.nimbus-os.dev/',               // bare non-preview subdomain
    'https://nimbus.ashishkumarsingh.com/',     // legacy custom domain (other zone)
    'https://1a2b3c4d-nimbus-os.dev/',          // versioned preview_urls host (ends `-suffix`, not `.suffix`)
    'https://1a2b3c4d-nimbus.nimbus-os.dev/',   // versioned subdomain (label has no `\d+--`)
    `https://sid.extra.${suffix}/`,             // multi-label under suffix
  ];
  for (const mode of ['enforce', 'legacy']) {
    const env = enforcingEnv();
    const handler = createNimbusHandler({ auth: { mode } });
    for (const host of nonPreviewHosts) {
      const response = await handler.fetch(new Request(host), env, ctx);
      assert.notEqual(response.status, 500, `${host} (${mode}) must not 500`);
      assert.equal(response.status, 404, `${host} (${mode}) must fall through to 404`);
    }
    assert.equal(
      env.NIMBUS_SESSION.requests.length,
      0,
      `non-preview hosts (${mode}) must not be forwarded to a session`,
    );
  }
}

// ── an internal throw becomes a 500 response, never a dead Worker ─────────
{
  const env = enforcingEnv({
    NIMBUS_SESSION: {
      idFromName() { throw new Error('DO namespace exploded'); },
      get() { throw new Error('DO namespace exploded'); },
    },
  });
  const handler = createNimbusHandler({ auth: { mode: 'legacy' } });
  const response = await handler.fetch(new Request(`https://3000--${sid}.${suffix}/`), env, ctx);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Internal error');
}

console.log('preview-host-router: ok');
