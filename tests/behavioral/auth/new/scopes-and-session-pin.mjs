#!/usr/bin/env bun
// auth/new/scopes-and-session-pin — requireScopes + requireSessionPin
// gate enforcement.

import { makeAsserter } from '../../_driver.mjs';
const a = makeAsserter('auth/new/scopes-and-session-pin');

const { issueNimbusToken, verifyNimbusToken } = await import('../../../../packages/worker/src/auth/token.ts');
const { requireScopes, requireSessionPin } = await import('../../../../packages/worker/src/auth/middleware.ts');
const { NimbusScopeError, NimbusSessionPinError } = await import('../../../../packages/worker/src/auth/types.ts');

const env = { JWT_SECRET: 'rot' };

/** A gate that lets the token through: the check fails with what it threw. */
function passes(name, gate) {
  try {
    gate();
    a.check(name, true);
  } catch (e) {
    a.check(name, false, `threw ${e?.constructor?.name}: ${e?.message}`);
  }
}

// Token with explicit scopes ⊆ required → ok.
{
  const t = await issueNimbusToken(env, { tn: 'a', scopes: ['session:create', 'session:attach'] });
  const v = await verifyNimbusToken(env, t);
  passes('explicit scope present → no throw', () => {
    requireScopes(v, ['session:create']);
    requireScopes(v, ['session:attach']);
  });
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
  passes('undefined scopes → all permitted (legacy)', () => requireScopes(v, ['session:admin', 'session:nuclear-launch']));
}

// sid pin enforcement.
{
  const t = await issueNimbusToken(env, { tn: 'a', sid: 'pretty-otter-42' });
  const v = await verifyNimbusToken(env, t);
  passes('sid pin match → pin check pass', () => requireSessionPin(v, 'pretty-otter-42'));
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
  passes('no sid in token → pin check pass', () => requireSessionPin(v, 'any-session-id'));
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
