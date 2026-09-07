#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { rpcExposePort, rpcRouteCapabilityPort, rpcUnexposePort } from '../../packages/worker/src/session/programmatic.ts';
import { restorePortCapability } from '../../packages/worker/src/session/port-capability.ts';

// The port API is called on an already-booted host. Only its durable KV storage
// crosses activations; each activation has a fresh, real PortRegistry.
const stored = new Map();
const storage = {
  get: async (key) => stored.get(key),
  put: async (key, value) => { stored.set(key, value); },
  delete: async (key) => stored.delete(key),
};
function activate(owner, body) {
  const portRegistry = new PortRegistry();
  portRegistry.bindFacetStub(1, { handleHttpRequest: async () => new Response(body) });
  portRegistry.register(20000, 1);
  return {
    ctx: { storage }, portRegistry, portCapabilityOwner: () => owner,
    shell: {}, ensureSqliteFs: () => null, ensureFacetManager: () => null,
  };
}
const request = () => new Request('https://preview.example/');
const first = activate('workspace/app-a/caller-a', 'A');
const exposed = await rpcExposePort(first, 20000);
assert.ok(exposed.capability);
assert.equal(await (await rpcRouteCapabilityPort(first, 20000, exposed.capability, request(), '/')).text(), 'A');

// Same logical server, new PID incarnation: keep the URL already issued.
const rebuilt = activate('workspace/app-a/caller-a', 'A rebuilt');
assert.equal(await restorePortCapability(rebuilt, 20000), exposed.capability);
assert.equal(await (await rpcRouteCapabilityPort(rebuilt, 20000, exposed.capability, request(), '/')).text(), 'A rebuilt');

// No exposure of B: its first invocation must not adopt A's durable token.
const other = activate('workspace/app-a/caller-b', 'B private');
assert.equal(await restorePortCapability(other, 20000), null);
assert.equal((await rpcRouteCapabilityPort(other, 20000, exposed.capability, request(), '/')).status, 404);
const unrelated = activate('workspace/app-b/caller-a', 'different app');
assert.equal((await rpcRouteCapabilityPort(unrelated, 20000, exposed.capability, request(), '/')).status, 404);
const ordinary = activate(null, 'ordinary');
assert.equal((await rpcRouteCapabilityPort(ordinary, 20000, exposed.capability, request(), '/')).status, 404);

// Default, port-scoped exposure remains available to ordinary workspace hosts.
const explicit = await rpcExposePort(ordinary, 20000);
const ordinaryRebuilt = activate(null, 'ordinary rebuilt');
delete ordinaryRebuilt.portCapabilityOwner;
assert.equal(await (await rpcRouteCapabilityPort(ordinaryRebuilt, 20000, explicit.capability, request(), '/')).text(), 'ordinary rebuilt');
await rpcUnexposePort(ordinaryRebuilt, 20000);
assert.equal(stored.size, 0);
assert.equal((await rpcRouteCapabilityPort(activate(null, 'after close'), 20000, explicit.capability, request(), '/')).status, 404);
console.log('port capability owner: same-owner restore, owner-change denial, default-port restore and explicit revocation passed');
