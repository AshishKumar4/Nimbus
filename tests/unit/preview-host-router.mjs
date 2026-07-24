#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { issueNimbusToken, verifyNimbusToken } from '../../packages/worker/src/auth/token.ts';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';

class FakeNamespace {
  names = [];
  requests = [];

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
        });
      },
    };
  }
}

const ctx = { waitUntil() {} };
const suffix = 'nimbus-os.dev';
const sid = 'nimble-otter-4271';

{
  const env = {
    JWT_SECRET: 'preview-router-secret',
    NIMBUS_PREVIEW_HOST_SUFFIX: suffix,
    NIMBUS_SESSION: new FakeNamespace(),
  };
  const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
  const attachToken = await issueNimbusToken(env, {
    tn: 'acme',
    sub: 'alice',
    scopes: ['session:attach'],
    sid,
  });

  const previewUrlResponse = await handler.fetch(
    new Request(`https://nimbus-os.dev/s/${sid}/api/preview-url?port=3000`, {
      headers: { Authorization: `Bearer ${attachToken}` },
    }),
    env,
    ctx,
  );
  assert.equal(previewUrlResponse.status, 200);
  assert.equal(previewUrlResponse.headers.get('Cache-Control'), 'no-store');
  const previewUrl = new URL((await previewUrlResponse.json()).url);
  assert.equal(previewUrl.origin, `https://3000--${sid}.${suffix}`);
  assert.equal(previewUrl.pathname, '/');

  const bootstrap = await verifyNimbusToken(
    env,
    previewUrl.searchParams.get('nimbus_token'),
  );
  assert.equal(bootstrap.claims.sid, sid);
  assert.deepEqual(bootstrap.claims.scopes, ['session:attach']);
  assert.ok(bootstrap.claims.exp - bootstrap.claims.iat <= 90);

  const exchanged = await handler.fetch(
    new Request(previewUrl, { redirect: 'manual' }),
    env,
    ctx,
  );
  assert.equal(exchanged.status, 302);
  assert.equal(exchanged.headers.get('Location'), '/');
  const setCookie = exchanged.headers.get('Set-Cookie');
  assert.match(setCookie, /^nimbus_token=/);
  assert.match(setCookie, /; Path=\/;/);
  assert.doesNotMatch(setCookie, /Domain=/i);

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
  });
  assert.equal(env.NIMBUS_SESSION.names.at(-1), `acme:alice:${sid}`);

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

  const invalidPort = await handler.fetch(
    new Request(`https://nimbus-os.dev/s/${sid}/api/preview-url?port=65536`, {
      headers: { Authorization: `Bearer ${attachToken}` },
    }),
    env,
    ctx,
  );
  assert.equal(invalidPort.status, 400);

  const unsafeSidToken = await issueNimbusToken(env, {
    tn: 'acme',
    sub: 'alice',
    scopes: ['session:attach'],
    sid: 'sdk.sandbox',
  });
  const unavailable = await handler.fetch(
    new Request('https://nimbus-os.dev/s/sdk.sandbox/api/preview-url?port=3000', {
      headers: { Authorization: `Bearer ${unsafeSidToken}` },
    }),
    env,
    ctx,
  );
  assert.deepEqual(await unavailable.json(), { url: null, reason: 'unavailable' });
}

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
  });
}

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

console.log('preview-host-router: ok');
