#!/usr/bin/env bun
// Loopback routing for the session AI gateway
// (packages/worker/src/session/loopback.ts).
//
// One router now serves both loopback entrypoints — kernel.routeLoopback in
// session/init.ts (shell curl, in-DO node) and _rpcRouteLoopback in
// session/rpc.ts (a facet's patched global fetch). What is pinned:
//
//   1. The AI gateway port is answered by the supervisor, ahead of the registry.
//   2. Every other port still reaches its registered facet, unchanged.
//   3. An unlistened port is still a connection refusal.
//   4. SECURITY: the AI port is NOT a PortRegistry entry, so the external
//      surfaces that share that registry — /port/<n>, /preview/?port=N and the
//      shareable <port>--<sid> preview hostname — cannot reach it. Only
//      in-session callers can.

import assert from 'node:assert/strict';
import { routeSessionLoopback } from '../../packages/worker/src/session/loopback.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { NIMBUS_AI_GATEWAY_PORT } from '../../packages/core/src/constants.ts';

function makeHost(portRegistry) {
  const store = new Map();
  return {
    env: {},
    portRegistry,
    ctx: {
      storage: {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); },
      },
    },
  };
}

const registry = new PortRegistry();
registry.bindFacetStub(42, {
  async handleHttpRequest() {
    return new Response('vite dev server', { status: 200 });
  },
});
registry.register(5173, 42);
const host = makeHost(registry);

// 1. The AI gateway answers on its own port. This session has no credential,
//    so the actionable 503 is proof the request reached the gateway rather
//    than falling through to "nothing is listening".
{
  const response = await routeSessionLoopback(
    host,
    NIMBUS_AI_GATEWAY_PORT,
    new Request(`http://127.0.0.1:${NIMBUS_AI_GATEWAY_PORT}/v1/models`),
  );
  assert.ok(response, 'AI gateway port must be served');
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'E_AI_NOT_CONNECTED');
}

// 2. Ordinary ports are untouched by the new branch.
{
  const response = await routeSessionLoopback(host, 5173, new Request('http://127.0.0.1:5173/index.html'));
  assert.ok(response);
  assert.equal(await response.text(), 'vite dev server');
}

// 3. Nothing listening is still nothing listening.
{
  const response = await routeSessionLoopback(host, 9999, new Request('http://127.0.0.1:9999/'));
  assert.equal(response, null);
}

// 4. The security property: the AI port is invisible to the port registry, so
//    every externally reachable route built on it answers "no such port".
{
  assert.equal(registry.has(NIMBUS_AI_GATEWAY_PORT), false);
  assert.equal(registry.get(NIMBUS_AI_GATEWAY_PORT), undefined);
  assert.ok(!registry.getAll().some((entry) => entry.port === NIMBUS_AI_GATEWAY_PORT));

  // This is exactly what session/routes.ts does for `/port/<n>` and for a
  // `<port>--<sid>` preview host; a null result is rendered as a 502.
  const external = await registry.routeRequest(
    NIMBUS_AI_GATEWAY_PORT,
    new Request(`https://${NIMBUS_AI_GATEWAY_PORT}--sid.example.dev/v1/models`),
    '/v1/models',
  );
  assert.equal(external, null, 'AI gateway must not be reachable from outside the session');
}

console.log('session-ai-loopback: all assertions passed');
