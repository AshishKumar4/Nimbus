#!/usr/bin/env bun
// Port-registry routeable-stub association.
//
// A shell-launched server — `node server.js` doing
// http.createServer().listen(5000) — is promoted to the keyed long-running
// facet (spawnNode). spawnNode binds that facet's re-resolvable
// NimbusLoadedEntrypoint as the pid's route stub (PortRegistry.bindFacetStub)
// BEFORE the script runs; when user code calls listen(), the http shim calls
// SUPERVISOR.registerPort which lands as register(port, pid, null), resolving to
// the pid-bound stub. This test pins that association contract:
//
//   1. bindFacetStub(pid) THEN register(port, pid, null) → routeRequest reaches
//      the bound stub (external /port/<n> AND in-session loopback curl).
//   2. a null-stub reservation with NO bound stub (a one-shot exec facet whose
//      unkeyed stub is never bound) → routeRequest returns an honest 501, never
//      a route to a non-existent handler.
//   3. an explicit routeable stub (the vite/makeLongRunningPortStub path) routes.
//   4. unregisterByPid (facet teardown) drops the route so a disposed facet
//      never lingers as a routeable target.

import assert from 'node:assert/strict';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';

// A stub shaped like the one-shot exec entrypoint: exposes `fetch` (the shape
// routeableFacetTarget binds first). routeRequest invokes it as the handler.
function makeFetchStub(bodyText) {
  const seen = [];
  return {
    seen,
    async fetch(request) {
      seen.push({ url: request.url, port: request.headers.get('X-Nimbus-Port') });
      return new Response(bodyText, { status: 200, headers: { 'X-Served-By': 'fetch-stub' } });
    },
  };
}

// A stub shaped like makeLongRunningPortStub / vite: exposes handleHttpRequest.
function makeHandleStub(bodyText) {
  const seen = [];
  return {
    seen,
    async handleHttpRequest(request) {
      seen.push({ url: request.url });
      return new Response(bodyText, { status: 200 });
    },
  };
}

// ── 1. bindFacetStub(pid) then register(port, pid, null) is routeable ────────
{
  const reg = new PortRegistry();
  const stub = makeFetchStub('hello-from-http-server');
  const pid = 42;
  const port = 5000;

  // FacetManager._execViaLoader binds the entrypoint before the script runs.
  reg.bindFacetStub(pid, stub);
  // The http shim's listen() → SUPERVISOR.registerPort → register(port, pid).
  reg.register(port, pid);

  const entry = reg.get(port);
  assert.ok(entry, 'port entry exists after registerPort');
  assert.ok(entry.facetStub, 'null registration resolved to the pid-bound route stub');

  const res = await reg.routeRequest(port, new Request('http://s/port/5000/api?x=1'), '/api');
  assert.equal(res.status, 200, 'routeRequest reaches the bound stub');
  assert.equal(await res.text(), 'hello-from-http-server');
  assert.equal(res.headers.get('X-Served-By'), 'fetch-stub');
  assert.equal(stub.seen.length, 1, 'the bound stub handled exactly one request');
  // routeRequest rewrites the URL to the inner path + query and stamps the port.
  assert.equal(new URL(stub.seen[0].url).pathname, '/api');
  assert.equal(new URL(stub.seen[0].url).search, '?x=1');
  assert.equal(stub.seen[0].port, '5000', 'X-Nimbus-Port header threaded to the facet');
}

// ── 2. null reservation with NO bound stub → honest 501 ──────────────────────
{
  const reg = new PortRegistry();
  reg.register(3000, 7); // reserved, but no route target bound for pid 7

  const res = await reg.routeRequest(3000, new Request('http://s/port/3000/'), '/');
  assert.equal(res.status, 501, 'null-stub reservation returns 501, not a bogus route');
  const body = JSON.parse(await res.text());
  assert.match(body.error, /no routeable facet handler/);
  assert.equal(body.port, 3000);
}

// ── 3. an in-DO routeable target (vite) routes through the same binding ──────
{
  const reg = new PortRegistry();
  const stub = makeHandleStub('vite-body');
  reg.bindFacetStub(11, stub);
  reg.register(5173, 11);

  const res = await reg.routeRequest(5173, new Request('http://s/port/5173/@vite/client'), '/@vite/client');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'vite-body');
  assert.equal(new URL(stub.seen[0].url).pathname, '/@vite/client');
}

// ── 4. unregisterByPid drops the route on facet teardown ─────────────────────
{
  const reg = new PortRegistry();
  const stub = makeFetchStub('body');
  reg.bindFacetStub(9, stub);
  reg.register(8080, 9);
  assert.ok(reg.get(8080), 'registered before teardown');

  const dropped = reg.unregisterByPid(9);
  assert.equal(dropped, 1, 'one port dropped for the pid');
  assert.equal(reg.get(8080), undefined, 'port entry gone after teardown');

  // Documented contract: a port with NO entry routes to null so callers
  // report "no process listening" — not the 501 reserved for a registered
  // port whose stub hasn't attached yet (they mean different things).
  const res = await reg.routeRequest(8080, new Request('http://s/port/8080/'), '/');
  assert.equal(res, null, 'a torn-down facet no longer routes');
}

// ── 5. bind AFTER a null reservation still attaches (order-independent) ───────
{
  const reg = new PortRegistry();
  const stub = makeFetchStub('late-bind');
  // register lands before the stub is bound (race: shim listen() beats bind).
  reg.register(4321, 5);
  assert.ok(!reg.get(4321).facetStub, 'no route target yet');
  reg.bindFacetStub(5, stub); // attachFacetStubByPid backfills reserved ports
  assert.ok(reg.get(4321).facetStub, 'late bindFacetStub backfilled the reserved port');

  const res = await reg.routeRequest(4321, new Request('http://s/port/4321/'), '/');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'late-bind');
}

// ── 6. waiting resolves once the pid's port becomes routeable ────────────────
{
  const reg = new PortRegistry();
  let fetchReads = 0;
  const stub = {
    get fetch() {
      fetchReads++;
      return async () => new Response('waited-route');
    },
  };
  reg.bindFacetStub(17, stub);
  const waiting = reg.waitForRouteablePortsByPid(17, 100);
  queueMicrotask(() => reg.register(4170, 17));
  assert.deepEqual(await waiting, [4170]);
  assert.equal(fetchReads, 1, 'the route target is normalized exactly once, at bind');
}

console.log('port-registry-routeable-stub: ok');
