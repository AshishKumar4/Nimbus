#!/usr/bin/env bun
// auth/new/jwt-rotation-previous-secret — tokens minted under the
// previous secret continue to verify during a rotation window.

import { makeAsserter } from '../../_driver.mjs';
const a = makeAsserter('auth/new/jwt-rotation-previous-secret');

const { issueNimbusToken, verifyNimbusToken } = await import('../../../../src/auth/token.ts');
const { NimbusTokenSignatureError } = await import('../../../../src/auth/types.ts');

const OLD = 'old-secret-' + Math.random().toString(36).slice(2);
const NEW = 'new-secret-' + Math.random().toString(36).slice(2);

// Token signed with OLD.
const tokenOld = await issueNimbusToken({ JWT_SECRET: OLD }, { tn: 'acme', sub: 'alice' });

// Rotation window: env has NEW as primary, OLD as previous.
const rotEnv = { JWT_SECRET: NEW, JWT_SECRET_PREVIOUS: OLD };
const v1 = await verifyNimbusToken(rotEnv, tokenOld);
a.check('old-secret token verifies during rotation window',
  v1.claims.tn === 'acme' && v1.claims.sub === 'alice');

// Token signed with NEW also verifies.
const tokenNew = await issueNimbusToken(rotEnv, { tn: 'acme', sub: 'bob' });
const v2 = await verifyNimbusToken(rotEnv, tokenNew);
a.check('new-secret token verifies in same window', v2.claims.sub === 'bob');

// Without rotation window (no JWT_SECRET_PREVIOUS), the old-secret token
// fails signature verification.
const postRotEnv = { JWT_SECRET: NEW };
try {
  await verifyNimbusToken(postRotEnv, tokenOld);
  a.check('post-rotation old token rejected', false, 'did not throw');
} catch (e) {
  a.check('post-rotation old token rejected', e instanceof NimbusTokenSignatureError,
    `got: ${e?.constructor?.name}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
