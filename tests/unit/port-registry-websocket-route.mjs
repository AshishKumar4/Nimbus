#!/usr/bin/env bun
// A WebSocket upgrade to a resident process's registered port.
//
// Ordinary HTTP crosses Workers RPC as Request/Response values, which is why
// the port registry can hand a facet a Request and get a Response back. An
// upgrade cannot: the 101 owns a live socket, and RPC's transport reconstructs
// the value rather than handing the socket over. So an upgrade takes a
// separate, fetch-semantic entrypoint on the route target, and every hop —
// registry to facet, coordinator to peer, peer to its facet — stays on fetch.
//
// These are the properties that make that split load-bearing rather than
// decorative.

import assert from 'node:assert/strict';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { routeHostedWebSocket } from '../../packages/worker/src/session/rpc.ts';

const UPGRADE = { upgrade: 'websocket', connection: 'Upgrade' };

// ── The upgrade reaches the WebSocket entrypoint; plain HTTP does not ───────
{
  const reg = new PortRegistry();
  const seen = [];
  reg.bindFacetStub(7, {
    async handleHttpRequest() {
      seen.push('http');
      return new Response('http', { status: 200 });
    },
    async handleWebSocketRequest(request) {
      seen.push('ws');
      assert.equal(request.headers.get('upgrade'), 'websocket', 'the upgrade header survives the hop');
      assert.equal(request.headers.get('X-Nimbus-Port'), '5000', 'the port is still stamped on');
      return new Response(null, { status: 101 });
    },
  });
  reg.register(5000, 7);

  const plain = await reg.routeRequest(5000, new Request('https://x/app'), '/app');
  assert.equal(plain.status, 200);

  const upgraded = await reg.routeRequest(
    5000,
    new Request('https://x/ws', { headers: UPGRADE }),
    '/ws',
  );
  assert.equal(upgraded.status, 101, 'the 101 comes back as itself');
  assert.deepEqual(seen, ['http', 'ws'], 'each request took its own entrypoint');
}

// ── A target that serves HTTP only says so, rather than dropping the socket ──
{
  const reg = new PortRegistry();
  reg.bindFacetStub(8, { async handleHttpRequest() { return new Response('ok'); } });
  reg.register(5001, 8);

  assert.equal((await reg.routeRequest(5001, new Request('https://x/'), '/')).status, 200);
  const refused = await reg.routeRequest(
    5001,
    new Request('https://x/ws', { headers: UPGRADE }),
    '/ws',
  );
  assert.equal(refused.status, 501, 'no WebSocket entrypoint is an honest 501');
  assert.match(await refused.text(), /WebSocket/);
}

// ── A `fetch`-shaped stub already has fetch semantics, so it serves both ────
//
// This is the one-shot exec entrypoint and the dynamic-worker stub. Binding it
// to HTTP only would have made every upgrade to a loaded worker a 501.
{
  const reg = new PortRegistry();
  const calls = [];
  reg.bindFacetStub(9, {
    async fetch(request) {
      calls.push(request.headers.get('upgrade'));
      return new Response(null, { status: request.headers.get('upgrade') ? 101 : 200 });
    },
  });
  reg.register(5002, 9);

  assert.equal((await reg.routeRequest(5002, new Request('https://x/'), '/')).status, 200);
  assert.equal(
    (await reg.routeRequest(5002, new Request('https://x/ws', { headers: UPGRADE }), '/ws')).status,
    101,
  );
  assert.deepEqual(calls, [null, 'websocket']);
}

// ── The peer hop is authorised by a capability, not by the process key ──────
//
// The workerKey is derivable from a pid, so on its own it authorises nothing.
// A mismatch answers 404 rather than 403: the route must not confirm what this
// peer happens to be hosting.
{
  const served = [];
  const host = {
    _hostedProcesses: new Map([['k1', {
      facet: Promise.resolve({
        async handleWebSocketRequest(request) {
          served.push(request.url);
          return new Response(null, { status: 101 });
        },
      }),
      started: Promise.resolve(null),
      webSocketCapability: 'cap-right',
      cancelled: new Promise(() => {}),
      cancel() {},
    }]]),
    _hostedProcessWaiters: new Map(),
  };

  const wrong = await routeHostedWebSocket(host, 'k1', 'cap-wrong', new Request('https://x/ws'));
  assert.equal(wrong.status, 404, 'a wrong capability is indistinguishable from no such process');
  assert.deepEqual(served, [], 'and never reaches the process');

  const right = await routeHostedWebSocket(host, 'k1', 'cap-right', new Request('https://x/ws'));
  assert.equal(right.status, 101);
  assert.deepEqual(served, ['https://x/ws']);
}

console.log('port registry websocket route: ok');
