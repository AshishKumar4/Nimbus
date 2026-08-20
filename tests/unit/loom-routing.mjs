#!/usr/bin/env bun
// routeActorRequest / getActorByName are partyserver's router re-exported —
// wrapping it in a parallel implementation would be a drift channel. This
// suite proves the re-export IS the real router and pins the surface loom
// documents: URL → binding → named instance, prefix, onBeforeRequest /
// onBeforeConnect gates, CORS (headers appended, preflight answered), and
// null for URLs that are not the router's business.

import assert from 'node:assert/strict';
import { loadLoom } from './lib/loom-harness.mjs';

const { routeActorRequest, getActorByName } = await loadLoom();

function fakeNamespace() {
  const fetched = [];
  const namespace = {
    fetched,
    idFromName(name) { return { name }; },
    get(id) {
      return {
        fetch(request) {
          fetched.push(request);
          return new Response(`served ${id.name}`, { status: 200 });
        },
        setName(name) { return name; },
      };
    },
  };
  return namespace;
}

// ── 1. URL → binding → named instance, with headers set ────────────────────

{
  const env = { MyActor: fakeNamespace() };
  const response = await routeActorRequest(new Request('http://test/parties/my-actor/room-1/extra'), env);
  assert.equal(await response.text(), 'served room-1');
  const forwarded = env.MyActor.fetched[0];
  assert.equal(forwarded.headers.get('x-partykit-namespace'), 'my-actor');
}

// ── 2. Not the router's business: null, not a 404 ──────────────────────────

{
  const env = { MyActor: fakeNamespace() };
  assert.equal(await routeActorRequest(new Request('http://test/health'), env), null);
  assert.equal(await routeActorRequest(new Request('http://test/parties/my-actor'), env), null);
}

// ── 3. A custom prefix moves the convention ─────────────────────────────────

{
  const env = { MyActor: fakeNamespace() };
  const response = await routeActorRequest(
    new Request('http://test/actors/my-actor/room-9'),
    env,
    { prefix: 'actors' },
  );
  assert.equal(await response.text(), 'served room-9');
  assert.equal(await routeActorRequest(new Request('http://test/parties/my-actor/room-9'), env, { prefix: 'actors' }), null);
}

// ── 4. onBeforeRequest gates; CORS headers ride matched responses ──────────

{
  const env = { MyActor: fakeNamespace() };
  const gated = await routeActorRequest(
    new Request('http://test/parties/my-actor/private'),
    env,
    {
      cors: true,
      onBeforeRequest: (req, lobby) => {
        assert.equal(lobby.name, 'private');
        assert.equal(lobby.className, 'MyActor');
        return new Response('go away', { status: 403 });
      },
    },
  );
  assert.equal(gated.status, 403);
  assert.equal(gated.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(env.MyActor.fetched.length, 0);

  const preflight = await routeActorRequest(
    new Request('http://test/parties/my-actor/private', { method: 'OPTIONS' }),
    env,
    { cors: true },
  );
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
}

// ── 5. onBeforeConnect gates WebSocket upgrades ─────────────────────────────

{
  const env = { MyActor: fakeNamespace() };
  const refused = await routeActorRequest(
    new Request('http://test/parties/my-actor/ws-room', { headers: { Upgrade: 'websocket' } }),
    env,
    { onBeforeConnect: () => new Response('no sockets today', { status: 503 }) },
  );
  assert.equal(refused.status, 503);
  assert.equal(env.MyActor.fetched.length, 0);
}

// ── 6. getActorByName synchronizes onStart via the setName RPC ──────────────

{
  const setNames = [];
  const namespace = {
    idFromName(name) { return { name }; },
    get(id) {
      return {
        async setName(name) { setNames.push(name); },
        marker: `stub-for-${id.name}`,
      };
    },
  };
  const stub = await getActorByName(namespace, 'session-7');
  assert.deepEqual(setNames, ['session-7']);
  assert.equal(stub.marker, 'stub-for-session-7');
}

console.log('loom-routing: all assertions passed');
