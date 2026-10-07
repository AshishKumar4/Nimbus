#!/usr/bin/env bun
// The OAuth callback is routed by the session and tenant segment its `state`
// names, before any session sees it. An unsigned state let any client wake or
// create a Durable Object under any tenant segment (the DO then refused it
// for want of its nonce cookie, but it had been woken). The state is signed
// with the agent cookie secret, and the router refuses one this deployment
// did not sign, or whose payload was altered, without touching a DO. The
// state's expiry is signed with it, and an expired state is refused the same
// way (the clock is fixed here).

import assert from 'node:assert/strict';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import { signAgentOAuthState } from '../../packages/worker/src/session/agent.ts';
import { encodeJsonBase64Url } from '../../packages/core/src/_shared/crypto.ts';

class FakeNamespace {
  names = [];
  idFromName(name) { this.names.push(name); return { name }; }
  get() {
    return {
      fetch: async (request) => Response.json({ pathname: new URL(request.url).pathname, tenant: request.headers.get('X-Nimbus-Tenant') }),
    };
  }
}

const secret = 'a-cookie-secret-of-at-least-32-characters';
const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const payload = { v: 1, nonce: 'n'.repeat(32), sessionId: 'nimble-otter-4271', tenantSegment: 'acme:alice', exp: NOW + 60_000 };
const callback = (state) => `https://nimbus.example/api/nimbus/oauth/callback?code=c&state=${encodeURIComponent(state)}`;
const handler = createNimbusHandler({ auth: { mode: 'legacy' } });
const call = async (state, env) => {
  const namespace = new FakeNamespace();
  const response = await handler.fetch(new Request(callback(state)), { NIMBUS_SESSION: namespace, JWT_SECRET: secret, ...env }, { waitUntil() {} });
  return { status: response.status, names: namespace.names, body: response.status === 200 ? await response.json() : await response.text() };
};

// A state this deployment signed reaches its session's DO.
const signed = await signAgentOAuthState(payload, { JWT_SECRET: secret });
const routed = await call(signed);
assert.equal(routed.status, 200);
assert.deepEqual(routed.names, ['acme:alice:nimble-otter-4271']);
assert.equal(routed.body.pathname, '/api/agent/oauth/callback');

// An SDK sandbox's session id (its own stable id, as isValidSessionId
// admits it) is routed the same way.
const sdkState = await signAgentOAuthState({ ...payload, sessionId: 'Build_7.a' }, { JWT_SECRET: secret });
const sdkRouted = await call(sdkState);
assert.equal(sdkRouted.status, 200);
assert.deepEqual(sdkRouted.names, ['acme:alice:Build_7.a']);

// Anything else never names a DO.
const unsigned = encodeJsonBase64Url({ ...payload, tenantSegment: 'victim:bob' });
const [body, signature] = signed.split('.');
const forged = [
  ['an unsigned payload', unsigned],
  ['another payload under a real signature', `${unsigned}.${signature}`],
  ['a signature from another secret', await signAgentOAuthState({ ...payload, tenantSegment: 'victim:bob' }, { JWT_SECRET: 'x'.repeat(40) })],
  ['a truncated signature', `${body}.${signature.slice(0, -4)}`],
  ['two dots', `${body}.${signature}.x`],
  ['an expired state', await signAgentOAuthState({ ...payload, exp: NOW - 1 }, { JWT_SECRET: secret })],
  ['a state expiring now', await signAgentOAuthState({ ...payload, exp: NOW }, { JWT_SECRET: secret })],
  ['a state with no expiry', await signAgentOAuthState({ v: 1, nonce: payload.nonce, sessionId: payload.sessionId, tenantSegment: payload.tenantSegment }, { JWT_SECRET: secret })],
  ['a later expiry under the first signature', `${encodeJsonBase64Url({ ...payload, exp: NOW + 3_600_000 })}.${signature}`],
];
for (const [label, state] of forged) {
  const refused = await call(state);
  assert.equal(refused.status, 400, label);
  assert.deepEqual(refused.names, [], `${label}: no Durable Object was named`);
}
// A deployment with no cookie secret signed nothing, so it accepts nothing.
const unconfigured = await call(signed, { JWT_SECRET: undefined });
assert.equal(unconfigured.status, 400);
assert.deepEqual(unconfigured.names, []);
// The same signed state, once the clock passes its expiry.
Date.now = () => payload.exp;
const late = await call(signed);
assert.equal(late.status, 400);
assert.deepEqual(late.names, []);

console.log('agent-oauth-state-signed: the router routes only a state this deployment signed');
