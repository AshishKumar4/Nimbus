#!/usr/bin/env bun
// auth/new/sealed-json-crypto - sealed JSON uses WebCrypto-backed
// authenticated encryption, purpose binding, and random IVs.

import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('auth/new/sealed-json-crypto');
const {
  decodeJsonBase64Url,
  encodeJsonBase64Url,
  pkceChallenge,
  randomBase64Url,
  sealJson,
  sha256Base64Url,
  unsealJson,
} = await import('../../../../packages/core/src/_shared/crypto.ts');

const secret = '0123456789abcdef0123456789abcdef';
const payload = { userId: 'cf_user', ts: 123 };

const sealedA = await sealJson(payload, secret, { purpose: 'auth-cookie' });
const sealedB = await sealJson(payload, secret, { purpose: 'auth-cookie' });
a.check('sealJson emits v2 envelope', sealedA.startsWith('v2.'));
a.check('same payload seals differently', sealedA !== sealedB);

const opened = await unsealJson(sealedA, secret, { purpose: 'auth-cookie' });
a.check('unsealJson round-trips payload', opened?.userId === payload.userId && opened?.ts === payload.ts);

const wrongPurpose = await unsealJson(sealedA, secret, { purpose: 'state-cookie' }).catch(() => null);
a.check('purpose mismatch fails authentication', wrongPurpose === null);

const wrongSecret = await unsealJson(sealedA, 'abcdef0123456789abcdef0123456789', { purpose: 'auth-cookie' }).catch(() => null);
a.check('secret mismatch fails authentication', wrongSecret === null);

let shortSecretRejected = false;
try {
  await sealJson(payload, 'short', { purpose: 'auth-cookie' });
} catch {
  shortSecretRejected = true;
}
a.check('short cookie secret is rejected', shortSecretRejected);

const encoded = encodeJsonBase64Url(payload);
const decoded = decodeJsonBase64Url(encoded);
a.check('json base64url helper round-trips', decoded.userId === payload.userId && decoded.ts === payload.ts);

const nonce = randomBase64Url(32);
a.check('randomBase64Url emits URL-safe nonce',
  /^[A-Za-z0-9_-]+$/.test(nonce) && nonce.length >= 42,
  nonce);

const challenge = await pkceChallenge('verifier');
const hash = await sha256Base64Url('verifier');
a.check('PKCE challenge uses SHA-256 base64url', challenge === hash);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
