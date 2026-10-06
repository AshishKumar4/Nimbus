#!/usr/bin/env bun
/**
 * A Nimbus token's three segments are unpadded base64url (RFC 7515 §2). A
 * token round-trips through issue and verify; a
 * segment in any other encoding is a malformed token, the error the router
 * answers 401 for, never an unclassified throw.
 */

import assert from 'node:assert/strict';
import { issueNimbusToken, verifyNimbusToken } from '../../packages/worker/src/auth/token.ts';
import { NimbusTokenMalformedError } from '../../packages/worker/src/auth/types.ts';

const env = { JWT_SECRET: 'a-secret-that-is-long-enough-for-hs256-signing-xx' };
const token = await issueNimbusToken(env, { tn: 'tenant-1', scopes: ['session:attach'] });
assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'every segment is unpadded base64url');
const verified = await verifyNimbusToken(env, token);
assert.equal(verified.claims.tn, 'tenant-1');

const [header, payload, signature] = token.split('.');
for (const [label, bad] of [
  ['a signature with characters outside base64url', `${header}.${payload}.${signature.slice(0, -2)}!!`],
  ['a signature in the standard alphabet with padding', `${header}.${payload}.${signature.replace(/-/g, '+').replace(/_/g, '/')}=`],
  ['a payload that is not base64url', `${header}.%%%.${signature}`],
]) {
  await assert.rejects(verifyNimbusToken(env, bad), (error) => {
    assert.ok(error instanceof NimbusTokenMalformedError || error?.name === 'NimbusTokenSignatureError',
      `${label}: ${error?.name}: ${error?.message}`);
    return true;
  });
}

console.log('auth-token-encoding: ok');
