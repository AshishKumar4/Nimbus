#!/usr/bin/env bun
// auth/new/jwt-mint-verify-roundtrip — issueNimbusToken + verifyNimbusToken
// roundtrip via the actual auth module (not via the Worker). Unit-like:
// runs in the bun host, imports the TS modules directly. This catches
// the WebCrypto subtle wire format + claim-shape roundtrip on every
// probe pass.

import { makeAsserter } from '../../_driver.mjs';
const a = makeAsserter('auth/new/jwt-mint-verify-roundtrip');

const { issueNimbusToken, verifyNimbusToken } = await import('../../../../packages/worker/src/auth/token.ts');

const SECRET = 'test-secret-' + Math.random().toString(36).slice(2);
const env = { JWT_SECRET: SECRET };

// Mint a basic token.
const token = await issueNimbusToken(env, { tn: 'acme', sub: 'alice' });
a.check('issueNimbusToken returns a string', typeof token === 'string');
a.check('JWT has 3 dot-separated parts', token.split('.').length === 3,
  `actual parts: ${token.split('.').length}`);

// Verify the token.
const verified = await verifyNimbusToken(env, token);
a.check('verify returns claims object', verified !== null && typeof verified === 'object');
a.check('verify.claims.scope === "nimbus"', verified.claims.scope === 'nimbus');
a.check('verify.claims.tn === "acme"', verified.claims.tn === 'acme');
a.check('verify.claims.sub === "alice"', verified.claims.sub === 'alice');
a.check('verify.doInstanceName === "acme:alice"', verified.doInstanceName === 'acme:alice');
a.check('claims.iat is a number', typeof verified.claims.iat === 'number');
a.check('claims.exp is a number', typeof verified.claims.exp === 'number');
a.check('claims.exp > claims.iat', verified.claims.exp > verified.claims.iat);

// Sub-less token → doInstanceName uses "_".
const t2 = await issueNimbusToken(env, { tn: 'acme' });
const v2 = await verifyNimbusToken(env, t2);
a.check('sub absent → doInstanceName uses "_"', v2.doInstanceName === 'acme:_');
a.check('sub absent → claims.sub undefined', v2.claims.sub === undefined);

// Scopes preserved.
const t3 = await issueNimbusToken(env, { tn: 'acme', sub: 'ops', scopes: ['session:admin', 'session:create'] });
const v3 = await verifyNimbusToken(env, t3);
a.check('scopes roundtrip preserved',
  Array.isArray(v3.claims.scopes) && v3.claims.scopes.length === 2
  && v3.claims.scopes.includes('session:admin')
  && v3.claims.scopes.includes('session:create'));

// sid pin preserved.
const t4 = await issueNimbusToken(env, { tn: 'acme', sub: 'alice', sid: 'pretty-otter-42' });
const v4 = await verifyNimbusToken(env, t4);
a.check('sid pin preserved', v4.claims.sid === 'pretty-otter-42');

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
