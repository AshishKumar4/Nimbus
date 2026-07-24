#!/usr/bin/env bun
// wrangler-inner-env-isolation.mjs
//
// CROSS-TENANT REGRESSION. `nimbus wrangler dev` runs a user's Worker inside
// their session. The inner Worker's env must be synthesized ENTIRELY from the
// user's own config plus Nimbus emulators — no binding from the supervisor DO's
// real env may ever cross into it.
//
// The bug: `services[].binding` was used as a KEY into the outer env
// (`env[name] = loaderEnv[name]`), and that name comes from the user's own
// wrangler.jsonc inside their sandbox. Declaring
// `services: [{ binding: 'NIMBUS_SESSION' }]` handed the inner Worker the
// Durable Object namespace — `.get(idFromName(<any sid>))` reaches ANY other
// tenant's session with no token — and `JWT_SECRET` handed over the signing
// key for forging tokens for any session.
import assert from 'node:assert/strict';
import { NimbusWrangler } from '../../packages/worker/dist/wrangler/nimbus-wrangler.js';

// A stand-in for the supervisor DO's real env.
const OUTER_ENV = {
  JWT_SECRET: 'platform-signing-key',
  NIMBUS_SESSION: { idFromName: () => 'id', get: () => ({ fetch: async () => new Response('other tenant') }) },
  LOADER: { load: () => ({}) },
  DEMO_DB: { prepare: () => {} },
  NPM_TARBALL_CACHE: { get: async () => null },
  NIMBUS_CF_OAUTH_CLIENT_ID: 'client-id',
};

function innerEnvFor(config) {
  const w = new NimbusWrangler({
    vfs: {}, vfsEvents: { on: () => {} }, esbuild: {},
    env: OUTER_ENV, ctx: {}, root: '/home/user/app',
    onLog: () => {},
  });
  w.config = config;
  // buildInnerEnv is the single place the inner env is assembled.
  return w.buildInnerEnv();
}

// ── the exploit: name any outer binding as a service binding ──────────────
{
  const inner = innerEnvFor({
    services: [
      { binding: 'JWT_SECRET', service: 'anything' },
      { binding: 'NIMBUS_SESSION', service: 'anything' },
      { binding: 'LOADER', service: 'anything' },
      { binding: 'DEMO_DB', service: 'anything' },
      { binding: 'NPM_TARBALL_CACHE', service: 'anything' },
      { binding: 'NIMBUS_CF_OAUTH_CLIENT_ID', service: 'anything' },
    ],
  });
  for (const name of Object.keys(OUTER_ENV)) {
    assert.equal(
      inner[name],
      undefined,
      `outer binding ${name} must never reach the inner Worker (cross-tenant escape)`,
    );
  }
}

// ── the general invariant: no outer value, under ANY key ──────────────────
{
  const inner = innerEnvFor({
    vars: { MY_VAR: 'user-value' },
    services: [{ binding: 'JWT_SECRET' }],
  });
  const outerValues = new Set(Object.values(OUTER_ENV));
  for (const [k, v] of Object.entries(inner)) {
    assert.equal(outerValues.has(v), false, `inner env key ${k} carries an outer binding value`);
  }
  // the user's own vars still work
  assert.equal(inner.MY_VAR, 'user-value');
}

// ── a service binding that collides with a user var must not clobber it ───
{
  const inner = innerEnvFor({
    vars: { JWT_SECRET: 'the-users-own-string' },
    services: [{ binding: 'JWT_SECRET' }],
  });
  assert.equal(inner.JWT_SECRET, 'the-users-own-string', "the user's own var is their business");
  assert.notEqual(inner.JWT_SECRET, OUTER_ENV.JWT_SECRET, 'but never the platform secret');
}

console.log('wrangler-inner-env-isolation: ok');
