#!/usr/bin/env bun
// auth/new/scopes-and-session-pin — requireScopes + requireSessionPin
// gate enforcement.

import { makeAsserter } from '../../_driver.mjs';
const a = makeAsserter('auth/new/scopes-and-session-pin');

const { issueNimbusToken, verifyNimbusToken } = await import('../../../../src/auth/token.ts');
const { requireScopes, requireSessionPin } = await import('../../../../src/auth/middleware.ts');
const { NimbusScopeError, NimbusSessionPinError } = await import('../../../../src/auth/types.ts');

const env = { JWT_SECRET: 'rot' };

// Token with explicit scopes ⊆ required → ok.
{
  const t = await issueNimbusToken(env, { tn: 'a', scopes: ['session:create', 'session:attach'] });
  const v = await verifyNimbusToken(env, t);
  requireScopes(v, ['session:create']);     // pass
  requireScopes(v, ['session:attach']);     // pass
  a.check('explicit scope present → no throw', true);
}

// Token missing required scope → NimbusScopeError.
{
  const t = await issueNimbusToken(env, { tn: 'a', scopes: ['session:create'] });
  const v = await verifyNimbusToken(env, t);
  let threw = false;
  try { requireScopes(v, ['session:admin']); } catch (e) {
    threw = e instanceof NimbusScopeError && e.requiredScope === 'session:admin';
  }
  a.check('missing scope → NimbusScopeError', threw);
}

// Legacy token (scopes undefined) → all scopes permitted.
{
  const t = await issueNimbusToken(env, { tn: 'a' });
  const v = await verifyNimbusToken(env, t);
  requireScopes(v, ['session:admin', 'session:nuclear-launch']);
  a.check('undefined scopes → all permitted (legacy)', true);
}

// sid pin enforcement.
{
  const t = await issueNimbusToken(env, { tn: 'a', sid: 'pretty-otter-42' });
  const v = await verifyNimbusToken(env, t);
  requireSessionPin(v, 'pretty-otter-42'); // pass
  let threw = false;
  try { requireSessionPin(v, 'other-session'); } catch (e) {
    threw = e instanceof NimbusSessionPinError
         && e.pinnedTo === 'pretty-otter-42'
         && e.attempted === 'other-session';
  }
  a.check('sid pin mismatch → NimbusSessionPinError', threw);
}

// No sid in token → no pin → any session ok.
{
  const t = await issueNimbusToken(env, { tn: 'a' });
  const v = await verifyNimbusToken(env, t);
  requireSessionPin(v, 'any-session-id');
  a.check('no sid in token → pin check pass', true);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
