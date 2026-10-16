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
import { ProcessFabric } from '../../packages/fabric/src/process-fabric.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import {
  HOSTED_WEBSOCKET_CAPABILITY_HEADER,
  HOSTED_WEBSOCKET_KEY_HEADER,
  isHostedWebSocket,
} from '../../packages/fabric/src/peer-host.ts';
import { createFacetWorld, createProcessHost } from './lib/facet-host-harness.mjs';

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
// Through the real coordinator → sibling → facet path. The workerKey is
// derivable from a pid, so on its own it authorises nothing. A mismatch
// answers 404 rather than 403: the route must not confirm what this peer
// happens to be hosting. And the process never sees the transport.
{
  adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });
  const served = [];
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('http'); },
    async fetch(request) {
      served.push([...request.headers.keys()].filter((name) => name.startsWith('x-nimbus-hosted')));
      return new Response(null, { status: 101 });
    },
  }), { resolveConfig: false });
  const host = createProcessHost('peer', world, { readFile() { throw new Error('no disk'); } });
  const handle = await new ProcessFabric(host).startResidentProcess({
    onWriterActivated() {},
    onWriterRetired() {},
    startContract: 'boot',
    pid: 70,
    workerKey: 'k70',
    boot: { kind: 'code', code: { compatibilityDate: '2025-01-01', compatibilityFlags: [], mainModule: 'worker.js', modules: { 'worker.js': 'export default {}' } } },
  });
  await handle.booted();

  const upgraded = await handle.routeTarget.handleWebSocketRequest(new Request('https://x/ws', { headers: UPGRADE }));
  assert.equal(upgraded.status, 101, 'the 101 comes back as itself, across the sibling hop');
  assert.deepEqual(served, [[]], 'the process never sees the transport that carried it');

  const [peer] = host.peers.values();
  const forged = (headers) => peer.peerHost.routeWebSocket(new Request('https://x/ws', { headers }));
  const key = { [HOSTED_WEBSOCKET_KEY_HEADER]: 'k70' };
  const wrong = await forged({ ...UPGRADE, ...key, [HOSTED_WEBSOCKET_CAPABILITY_HEADER]: crypto.randomUUID() });
  assert.equal(wrong.status, 404, 'a wrong capability is indistinguishable from no such process');
  assert.equal((await forged({ ...UPGRADE, ...key })).status, 404, 'and so is none');
  assert.equal((await forged({ ...key, [HOSTED_WEBSOCKET_CAPABILITY_HEADER]: crypto.randomUUID() })).status, 426, 'a hop that is no upgrade is refused');
  assert.deepEqual(served, [[]], 'and none of them reaches the process');
  assert.equal(isHostedWebSocket(new Request('https://x/ws', { headers: UPGRADE })), false, 'an upgrade that is not a hop is left to the object\'s own routes');
  assert.equal(isHostedWebSocket(new Request('https://x/ws', { headers: key })), true, 'and one that names a process is the hop');

  handle.kill();
  await handle.done.catch(() => {});
}

console.log('port registry websocket route: ok');

for (const ending of ['client', 'target', 'error', 'reserved-close', 'process']) {
  const reg = new PortRegistry(), events = [];
  reg.setClientSocketActivity(() => events.push(reg.clientSocketCount));
  const pair = new WebSocketPair(), target = pair[0], app = pair[1];
  app.accept(); app.send('queued greeting');
  reg.bindFacetStub(81, { async handleHttpRequest() { return new Response('page'); }, async handleWebSocketRequest() {
    return new Response(null, { status: 101, webSocket: target, headers: { 'sec-websocket-protocol': 'hmr' } });
  } });
  reg.register(5081, 81);
  const response = await reg.routeRequest(5081, new Request('https://x/hmr', { headers: UPGRADE }), '/hmr');
  const client = response.webSocket;
  const clientMessages = [], appMessages = [];
  client.addEventListener('message', event => clientMessages.push(event.data));
  app.addEventListener('message', event => appMessages.push(event.data));
  client.accept();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(response.headers.get('sec-websocket-protocol'), 'hmr');
  assert.deepEqual(clientMessages, ['queued greeting'], 'listeners precede accept, including buffered greetings');
  client.send('client text'); app.send('server text');
  client.send(new Uint8Array([0, 255, 42]).buffer); app.send(new Uint8Array([254, 1]).buffer);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(appMessages, ['client text', new Uint8Array([0, 255, 42]).buffer]);
  assert.deepEqual(clientMessages.slice(1), ['server text', new Uint8Array([254, 1]).buffer]);
  assert.equal(reg.clientSocketCount, 1);
  const closed = new Promise(resolve => client.addEventListener('close', resolve, { once: true }));
  if (ending === 'client') client.close(4001, 'tab closed');
  else if (ending === 'target') app.close(4002, 'server closed');
  else if (ending === 'error') target.dispatchEvent(new Event('error'));
  else if (ending === 'reserved-close') { const event = new Event('close'); Object.assign(event, { code: 1006, reason: '' }); target.dispatchEvent(event); }
  else reg.unregisterByPid(81);
  const result = await closed;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reg.clientSocketCount, 0, 'every close/error/process-end releases its client interest');
  assert.deepEqual(events, [1, 0], 'client interest ends exactly once');
  assert.equal(result.code, ending === 'client' ? 4001 : ending === 'target' ? 4002 : ending === 'error' || ending === 'reserved-close' ? 1011 : 1001);
}

{
  const reg = new PortRegistry(); reg.setClientSocketActivity(() => {});
  const pair = new WebSocketPair(), target = pair[0], app = pair[1];
  target.accept = () => { throw new Error('accept failed'); };
  reg.bindFacetStub(82, { async handleHttpRequest() { return new Response('page'); }, async handleWebSocketRequest() { return new Response(null, { status: 101, webSocket: target }); } });
  reg.register(5082, 82);
  const response = await reg.routeRequest(5082, new Request('https://x/ws', { headers: UPGRADE }), '/ws');
  assert.equal(response.status, 502);
  assert.equal(reg.clientSocketCount, 0, 'failed acceptance cannot leak resident interest');
  assert.equal(app.readyState, 3, 'failed acceptance closes the acquired socket');
}
