#!/usr/bin/env bun
// auth/new/jwt-rejects-bad-shape — verifyNimbusToken refuses every
// shape of bad input with the right typed error subclass + code.

import { makeAsserter } from '../../_driver.mjs';
const a = makeAsserter('auth/new/jwt-rejects-bad-shape');

const { issueNimbusToken, verifyNimbusToken } = await import('../../../../packages/worker/src/auth/token.ts');
const {
  NimbusAuthConfigError,
  NimbusTokenMalformedError,
  NimbusTokenSignatureError,
  NimbusTokenClaimsError,
  NimbusTokenExpiredError,
  NimbusTokenTtlError,
} = await import('../../../../packages/worker/src/auth/types.ts');

const SECRET = 'test-secret';
const env = { JWT_SECRET: SECRET };

async function assertThrows(label, fn, ErrClass, expectedCode) {
  try {
    await fn();
    a.check(label, false, 'did not throw');
  } catch (e) {
    a.check(`${label} — instanceof ${ErrClass.name}`, e instanceof ErrClass,
      `got: ${e?.constructor?.name}: ${e?.message}`);
    if (expectedCode) {
      a.check(`${label} — code=${expectedCode}`, e.code === expectedCode,
        `actual code: ${e.code}`);
    }
  }
}

// 1. Missing JWT_SECRET → NimbusAuthConfigError.
await assertThrows('missing JWT_SECRET on issue',
  () => issueNimbusToken({ JWT_SECRET: '' }, { tn: 'a' }),
  NimbusAuthConfigError, 'E_AUTH_CONFIG_MISSING');
await assertThrows('missing JWT_SECRET on verify',
  () => verifyNimbusToken({ JWT_SECRET: '' }, 'x.y.z'),
  NimbusAuthConfigError, 'E_AUTH_CONFIG_MISSING');

// 2. Bad tn shape → NimbusTokenClaimsError.
await assertThrows('tn with colon (collides w/ separator)',
  () => issueNimbusToken(env, { tn: 'has:colon' }),
  NimbusTokenClaimsError, 'E_TOKEN_CLAIMS');
await assertThrows('tn too long (>128)',
  () => issueNimbusToken(env, { tn: 'a'.repeat(129) }),
  NimbusTokenClaimsError, 'E_TOKEN_CLAIMS');
await assertThrows('tn empty',
  () => issueNimbusToken(env, { tn: '' }),
  NimbusTokenClaimsError, 'E_TOKEN_CLAIMS');

// 3. Bad sub shape → NimbusTokenClaimsError.
await assertThrows('sub with space',
  () => issueNimbusToken(env, { tn: 'a', sub: 'has space' }),
  NimbusTokenClaimsError, 'E_TOKEN_CLAIMS');

// 4. TTL too large → NimbusTokenTtlError.
await assertThrows('ttlMs > 30 days',
  () => issueNimbusToken(env, { tn: 'a' }, { ttlMs: 31 * 24 * 60 * 60 * 1000 }),
  NimbusTokenTtlError, 'E_TOKEN_TTL_TOO_LARGE');
await assertThrows('ttlMs <= 0',
  () => issueNimbusToken(env, { tn: 'a' }, { ttlMs: 0 }),
  NimbusTokenTtlError, 'E_TOKEN_TTL_TOO_LARGE');

// 5. Malformed token (not 3 parts) → NimbusTokenMalformedError.
await assertThrows('verify "" empty',
  () => verifyNimbusToken(env, ''),
  NimbusTokenMalformedError, 'E_TOKEN_MALFORMED');
await assertThrows('verify "abc" — no dots',
  () => verifyNimbusToken(env, 'abc'),
  NimbusTokenMalformedError, 'E_TOKEN_MALFORMED');
await assertThrows('verify 4 parts',
  () => verifyNimbusToken(env, 'a.b.c.d'),
  NimbusTokenMalformedError, 'E_TOKEN_MALFORMED');

// 6. Bad signature → NimbusTokenSignatureError.
const t = await issueNimbusToken(env, { tn: 'acme' });
const tampered = t.slice(0, -2) + 'XX';
await assertThrows('signature tampered',
  () => verifyNimbusToken(env, tampered),
  NimbusTokenSignatureError, 'E_TOKEN_SIGNATURE');
await assertThrows('signed with different secret',
  () => verifyNimbusToken({ JWT_SECRET: 'other-secret' }, t),
  NimbusTokenSignatureError, 'E_TOKEN_SIGNATURE');

// 7. Bad scope discriminator → NimbusTokenClaimsError.
// Forge a token whose payload has scope:"vfs" but is signed by our secret.
// We have to mint via the same helpers since payload-rewrite is what we test.
// Easiest: construct manually with the same crypto.
async function forgeWithClaims(claims) {
  const enc = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = enc('{"alg":"HS256","typ":"JWT"}');
  const payload = enc(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  let binSig = '';
  for (let i = 0; i < sig.length; i++) binSig += String.fromCharCode(sig[i]);
  const sigB64 = btoa(binSig).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${data}.${sigB64}`;
}

const nowSec = Math.floor(Date.now() / 1000);
const vfsToken = await forgeWithClaims({ scope: 'vfs', tn: 'acme', iat: nowSec, exp: nowSec + 3600 });
await assertThrows('scope:"vfs" rejected (cross-product)',
  () => verifyNimbusToken(env, vfsToken),
  NimbusTokenClaimsError, 'E_TOKEN_CLAIMS');

// 8. Expired token → NimbusTokenExpiredError.
const expiredToken = await forgeWithClaims({ scope: 'nimbus', tn: 'a', iat: nowSec - 7200, exp: nowSec - 3600 });
await assertThrows('expired (exp in the past)',
  () => verifyNimbusToken(env, expiredToken),
  NimbusTokenExpiredError, 'E_TOKEN_EXPIRED');

// 9. Missing required claim → NimbusTokenClaimsError.
const noTn = await forgeWithClaims({ scope: 'nimbus', iat: nowSec, exp: nowSec + 3600 });
await assertThrows('missing tn',
  () => verifyNimbusToken(env, noTn),
  NimbusTokenClaimsError, 'E_TOKEN_CLAIMS');

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
