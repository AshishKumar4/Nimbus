#!/usr/bin/env bun
// Ticket regressions through the real router: replacement at the name limit,
// destroy-expiry freeing exactly one slot, and migration on local answers.
import assert from 'node:assert/strict';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';

const context = { waitUntil() {} };
const cookieName = (sid) => `__Host-nimbus_token-${sid}`;
const setup = () => {
  const env = {
    JWT_SECRET: 'cookie-tickets-unit-signing-key',
    NIMBUS_SESSION: {
      idFromName(name) { return { name }; },
      get() {
        return {
          fetch: async (request) => Response.json({ path: new URL(request.url).pathname }),
          _rpcConsumeAttachBootstrap: async () => true,
          _rpcDestroy: async () => ({ ok: true, killed: 1, destroyedAt: Date.now(), reason: null }),
        };
      },
    },
  };
  return { env, router: createNimbusHandler({ auth: { mode: 'enforce' }, sdk: { remote: true } }) };
};
const attach = (env, sid, extra = {}) =>
  issueNimbusToken(env, { tn: 'tenant', sub: 'user', sid, scopes: ['session:attach'], ...extra });

const failures = [];
const cases = [
  ['replacement at 24 names is allowed', async () => {
    const { env, router } = setup();
    const jar = new Map();
    for (let i = 0; i < 24; i++) {
      const sid = `held-${i}`;
      const res = await router.fetch(new Request(
        `https://tickets.test/s/${sid}/?nimbus_token=${await attach(env, sid)}`), env, context);
      assert.equal(res.status, 302);
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(';', 1)[0];
        jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
      }
    }
    assert.equal([...jar.keys()].filter((k) => k.startsWith('__Host-nimbus_token-')).length, 24);
    const header = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    // Re-attaching a held session replaces its cookie: no new name, must fit.
    const again = await router.fetch(new Request(
      `https://tickets.test/s/held-0/?nimbus_token=${await attach(env, 'held-0')}`,
      { headers: { Cookie: header } }), env, context);
    assert.equal(again.status, 302, 'a replacement issues, it does not grow the jar');
    // A 25th distinct session is still refused without burning its bootstrap.
    const fresh = await attach(env, 'held-24', { scopes: ['session:bootstrap'], jti: 'ticket-jti-25' });
    const refused = await router.fetch(new Request(
      `https://tickets.test/s/held-24/?nimbus_token=${fresh}`, { headers: { Cookie: header } }), env, context);
    assert.notEqual(refused.status, 302);
    const retry = await router.fetch(new Request(
      `https://tickets.test/s/held-24/?nimbus_token=${fresh}`), env, context);
    assert.equal(retry.status, 302, 'the refused single-use URL stays usable');
  }],
  ['destroy frees exactly its own slot', async () => {
    const { env, router } = setup();
    const jar = new Map();
    for (const sid of ['doomed', 'spared']) {
      const res = await router.fetch(new Request(
        `https://tickets.test/s/${sid}/?nimbus_token=${await attach(env, sid)}`), env, context);
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(';', 1)[0];
        jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
      }
    }
    const killer = await issueNimbusToken(env,
      { tn: 'tenant', sub: 'user', sid: 'doomed', scopes: ['sandbox:use', 'session:destroy'] });
    const header = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const gone = await router.fetch(new Request('https://tickets.test/s/doomed/', {
      method: 'DELETE', headers: { Authorization: `Bearer ${killer}`, Cookie: header },
    }), env, context);
    assert.equal(gone.status, 200);
    const expired = gone.headers.getSetCookie();
    assert.equal(expired.length, 1, 'exactly one cookie is expired');
    assert.ok(expired[0].startsWith(`${cookieName('doomed')}=;`) && /Max-Age=0/.test(expired[0]));
    // The spared session still authenticates with its untouched cookie.
    const spared = await router.fetch(new Request('https://tickets.test/s/spared/api/stats', {
      headers: { Cookie: header },
    }), env, context);
    assert.equal(spared.status, 200);
    // A refused DELETE (wrong session pin) expires nothing.
    const denied = await router.fetch(new Request('https://tickets.test/s/spared/', {
      method: 'DELETE', headers: { Authorization: `Bearer ${killer}`, Cookie: header },
    }), env, context);
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.headers.getSetCookie(), []);
  }],
  ['local answers migrate the legacy cookie', async () => {
    const { env, router } = setup();
    const legacy = await attach(env, 'local-sid');
    const legacyOnly = `__Host-nimbus_token=${legacy}`;
    for (const path of ['/', '/api/preview-url?port=3000']) {
      const res = await router.fetch(new Request(`https://tickets.test/s/local-sid${path}`, {
        headers: { Cookie: legacyOnly },
      }), env, context);
      assert.equal(res.status, 200, `${path} answers`);
      const set = res.headers.getSetCookie();
      assert.ok(set.some((v) => v.startsWith(`${cookieName('local-sid')}=`)), `${path} sets the route name`);
      assert.ok(set.some((v) => v.startsWith('__Host-nimbus_token=;') && /Max-Age=0/.test(v)), `${path} expires legacy`);
    }
  }],
];
for (const [label, run] of cases) {
  try { await run(); console.log(`PASS ${label}`); }
  catch (error) { failures.push(label); console.error(`FAIL ${label}: ${error.message}`); }
}
assert.deepEqual(failures, [], 'every ticket regression is closed');
