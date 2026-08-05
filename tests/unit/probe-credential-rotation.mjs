#!/usr/bin/env bun
// probe-credential-rotation — a shared target's signing secret is never
// replaced by accident, and a token that no longer matches one says so.
//
// Measured 2026-08-05: four worktrees on this machine held three
// different `nimbus-probe-staging` secrets. Each `staging:deploy` read a
// state file scoped to its own checkout, found none, minted a fresh
// secret and pushed it — and every other checkout's tokens died on the
// spot. A 379-probe suite finished in 35.6 seconds with every online
// probe failing on `POST /new returned no Location (status 401)`; the
// only 19 that passed were exactly the offline ones. The cause was
// invisible in that message, which is the second half of the damage.

import assert from 'node:assert/strict';
import { MACHINE_STATE_DIR, ROOT, assertCredentialHeld } from '../behavioral/_deploy-target.mjs';

// [1] The environment's record is machine state. Two checkouts of this
// repo on one machine must resolve the same file, or each one deploys
// believing it is the first.
{
  assert.ok(
    !MACHINE_STATE_DIR.startsWith(ROOT),
    `staging state must live outside the checkout, got ${MACHINE_STATE_DIR}`,
  );
  console.log('  [1] shared-environment state is machine state, not per-checkout state');
}

// [2] A redeploy that holds the secret reuses it — the ordinary case,
// and the one that keeps other clients' tokens valid across a deploy.
{
  assertCredentialHeld({ name: 'nimbus-probe-staging', hasSecret: true, provisioned: true, rotate: false });
  console.log('  [2] a redeploy that holds the secret is allowed to proceed');
}

// [3] First provision: nothing is deployed, so there is nobody to break.
{
  assertCredentialHeld({ name: 'nimbus-probe-staging', hasSecret: false, provisioned: false, rotate: false });
  console.log('  [3] first provision mints freely');
}

// [4] The hazard itself: the Worker exists, this machine lost its
// secret, and nobody asked for a rotation. Deploying would push a new
// secret and 401 every in-flight client. It has to stop, and say why.
{
  assert.throws(
    () => assertCredentialHeld({
      name: 'nimbus-probe-staging',
      hasSecret: false,
      provisioned: true,
      rotate: false,
    }),
    (e) => {
      assert.match(e.message, /nimbus-probe-staging is already deployed/);
      assert.match(e.message, /invalidates every token/);
      assert.match(e.message, /--rotate-secrets/);
      return true;
    },
    'a provisioned target whose secret is lost must not be silently rotated',
  );
  console.log('  [4] a lost secret stops the deploy instead of rotating the environment');
}

// [5] Rotation stays available — it is a deliberate operation, not an
// accident.
{
  assertCredentialHeld({ name: 'nimbus-probe-staging', hasSecret: false, provisioned: true, rotate: true });
  console.log('  [5] --rotate-secrets still rotates');
}

// The driver half: when a stale credential does reach a probe, the
// error names the credential rather than presenting as a probe failure.

async function mintSessionFailure({ status, body = '', token }) {
  process.env.BASE = 'https://nimbus-probe-staging.example.workers.dev';
  process.env.NIMBUS_PROBE_TOKEN = token ?? '';
  process.env.NIMBUS_PROBE_COOKIE = '';
  process.env.NIMBUS_AUTH_COOKIE = '';
  globalThis.fetch = async () => new Response(body, { status });
  // A fresh module instance per case: the driver reads its credentials
  // from the environment once, at import, exactly as a probe does.
  const driver = await import(`../behavioral/_driver.mjs?case=${status}-${token ? 'token' : 'none'}`);
  return driver.mintSession().then(
    () => { throw new Error('mintSession resolved on a failed POST /new'); },
    (e) => e.message,
  );
}

// [6] 401 while presenting a bearer token is the rotation signature.
{
  const message = await mintSessionFailure({ status: 401, body: 'unauthorized', token: 'stale.jwt.here' });
  assert.match(message, /401/);
  assert.match(message, /rejected this probe's bearer token/);
  assert.match(message, /JWT_SECRET/);
  assert.match(message, /staging-target\.mjs token/, 'the message says how to re-mint');
  console.log('  [6] a rejected token is diagnosed as a rotated secret, with the way out');
}

// [7] 401 with no credential at all is a different mistake and gets a
// different answer.
{
  const message = await mintSessionFailure({ status: 401 });
  assert.match(message, /no probe credential was sent/);
  assert.match(message, /NIMBUS_PROBE_TOKEN/);
  assert.doesNotMatch(message, /rotated|JWT_SECRET/, 'do not blame rotation when nothing was sent');
  console.log('  [7] a missing credential is diagnosed as a missing credential');
}

// [8] Anything else keeps reporting the target's own answer — the
// diagnosis must not swallow a real failure.
{
  const message = await mintSessionFailure({ status: 503, body: 'no capacity for new sessions', token: 'good.jwt' });
  assert.match(message, /503/);
  assert.match(message, /no capacity for new sessions/);
  assert.doesNotMatch(message, /bearer token/);
  console.log('  [8] a non-auth failure still reports what the target said');
}

console.log('probe-credential-rotation: all tests passed');
