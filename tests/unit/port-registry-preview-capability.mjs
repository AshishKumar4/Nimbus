#!/usr/bin/env bun
// A port's preview capability: publish one guest server without publishing the
// session it runs in.
//
// The generic port route strips `Authorization`, because the credential it
// sees is Nimbus's own and untrusted guest code must never receive it. That
// also means a guest application can never authenticate its own users through
// a preview. The capability route is the other case: the embedder has already
// authenticated the token at its edge and removed its own credentials, so what
// remains belongs to the guest and has to survive the hop.
//
// The capability is per REGISTRATION, which is what stops a URL handed out for
// one process from reaching whatever binds the port next.

import assert from 'node:assert/strict';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';

function guestServer(seen) {
  return {
    async handleHttpRequest(request) {
      seen.push({
        authorization: request.headers.get('authorization'),
        cookie: request.headers.get('cookie'),
      });
      return new Response('served', { status: 200 });
    },
  };
}

// ── Minted per registration, unguessable, and distinct per port ─────────────
{
  const reg = new PortRegistry();
  reg.bindFacetStub(1, guestServer([]));
  reg.register(3000, 1);
  const first = reg.get(3000).capability;
  assert.match(first, /^[a-f0-9]{24}$/, 'a capability is 12 random bytes, hex');

  reg.register(3001, 1);
  assert.notEqual(reg.get(3001).capability, first, 'two ports do not share one token');

  // Re-registering the port is a NEW registration, so the old token dies with
  // the old occupant. This is the property the durable copy must not undo.
  reg.register(3000, 1);
  assert.notEqual(reg.get(3000).capability, first, 're-registering mints a new capability');
  assert.equal(reg.hasCapability(3000, first), false, 'the retired token no longer matches');
}

// ── A wrong or absent capability routes nowhere ─────────────────────────────
{
  const seen = [];
  const reg = new PortRegistry();
  reg.bindFacetStub(2, guestServer(seen));
  reg.register(3000, 2);
  const cap = reg.get(3000).capability;

  assert.equal(
    await reg.routeCapabilityRequest(3000, 'f'.repeat(24), new Request('https://x/'), '/'),
    null,
    'a wrong capability answers null, which callers report as not-found',
  );
  assert.equal(
    await reg.routeCapabilityRequest(3999, cap, new Request('https://x/'), '/'),
    null,
    'a capability does not authorise a port it was not minted for',
  );
  assert.deepEqual(seen, [], 'neither reached the guest server');
}

// ── The guest's Authorization survives the capability route, and only it ────
{
  const seen = [];
  const reg = new PortRegistry();
  reg.bindFacetStub(3, guestServer(seen));
  reg.register(3000, 3);
  const cap = reg.get(3000).capability;

  const headers = { authorization: 'Bearer guest-app-token', cookie: 'nimbus_token=secret' };

  const generic = await reg.routeRequest(3000, new Request('https://x/', { headers }), '/');
  assert.equal(generic.status, 200);
  assert.equal(seen.at(-1).authorization, null, 'the generic route still strips Authorization');

  const scoped = await reg.routeCapabilityRequest(
    3000,
    cap,
    new Request('https://x/', { headers }),
    '/',
  );
  assert.equal(scoped.status, 200);
  assert.equal(
    seen.at(-1).authorization,
    'Bearer guest-app-token',
    'the capability route preserves the guest application credential',
  );
  assert.equal(seen.at(-1).cookie, null, 'and strips Nimbus session cookies exactly as before');
}

// ── A durable capability can be re-adopted, but only a well-formed one ──────
//
// A rebuilt supervisor registers the same server under a token nobody holds.
// Re-adoption is what keeps a preview URL alive across an eviction; the shape
// check is what stops a corrupted or attacker-chosen storage row becoming one.
{
  const reg = new PortRegistry();
  reg.bindFacetStub(4, guestServer([]));
  reg.register(3000, 4);
  const inCirculation = 'a1b2c3d4e5f6a1b2c3d4e5f6';

  assert.equal(reg.restoreCapability(3000, inCirculation), true);
  assert.equal(reg.hasCapability(3000, inCirculation), true, 'the URL already handed out still works');

  assert.equal(reg.restoreCapability(3000, 'not-a-capability'), false, 'a malformed token is refused');
  assert.equal(reg.restoreCapability(3000, 'A1B2C3D4E5F6A1B2C3D4E5F6'), false, 'and so is the wrong alphabet');
  assert.equal(reg.hasCapability(3000, inCirculation), true, 'a refused restore changes nothing');
  assert.equal(reg.restoreCapability(9999, inCirculation), false, 'an unregistered port has nothing to restore');
}

console.log('port registry preview capability: ok');
