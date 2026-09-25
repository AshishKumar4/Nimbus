#!/usr/bin/env bun
// A routed request carries the supervisor's ACQUIRE (X-Nimbus-Vfs-Acquired)
// only to a process that takes it off before user code runs: a node-shims
// resident, whose __nimbusServeHttp strips it. Python, Ruby and spawnWorker
// processes hand the request to user code as it arrives, so they get none,
// and the supervisor computes none for them.

import assert from 'node:assert/strict';
import { DELIVERED_ACQUIRE_HEADER, PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';

const asked = [];
const registry = new PortRegistry(async (pid) => {
  asked.push(pid);
  return { args: { epoch: 'e', cursor: 7 }, answer: { kind: 'current' } };
});
const echo = { async handleHttpRequest(request) { return Response.json(Object.fromEntries(request.headers)); } };
registry.bindFacetStub(41, echo, { deliversAcquire: true });
registry.bindFacetStub(42, echo);
registry.register(3000, 41);
registry.register(3001, 42);

const route = async (port) => (await registry.routeRequest(port, new Request(`https://x.invalid/p/${port}/`, {
  headers: { [DELIVERED_ACQUIRE_HEADER]: 'forged by the client' },
}), '/')).json();

const node = await route(3000);
assert.deepEqual(JSON.parse(node['x-nimbus-vfs-acquired']), { args: { epoch: 'e', cursor: 7 }, answer: { kind: 'current' } },
  'a node-shims resident gets the supervisor\'s answer, not the client\'s');
const other = await route(3001);
assert.equal(other['x-nimbus-vfs-acquired'], undefined, 'a process that does not strip it must not receive it');
assert.deepEqual(asked, [41], 'an ACQUIRE is computed only for a process that takes it');

// A pid rebound without the capability (a new process on a recycled pid) loses it.
registry.unregisterByPid(41);
registry.bindFacetStub(41, echo);
registry.register(3000, 41);
assert.equal((await route(3000))['x-nimbus-vfs-acquired'], undefined);

console.log('port-registry-delivered-acquire: the ACQUIRE header reaches only processes that strip it');
