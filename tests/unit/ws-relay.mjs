#!/usr/bin/env bun
// The supervisor half of the WebSocket relay. A facet's socket is terminated
// here so an inbound frame reaches it as a supervisor reply — the only shape
// a cache invalidation can ride on.
//
// What matters beyond "frames arrive": a relay that silently dropped frames
// would trade a coherence bug for a data-loss bug, an unbounded one would let
// a chatty endpoint evict the supervisor from its 64 MiB heap, and one keyed
// only by an integer id would let a facet read another process's socket.
// The upgrade carries the program's own headers but the handshake's and the
// hop-by-hop ones, and a refused upgrade is answered as the destination
// answered it (status, headers, a bounded head of its body), so a client
// built on http.request (the ws package) sees what it would see in Node.

import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import assert from 'node:assert/strict';
import { WebSocketRelay, WS_RELAY_MAX_BACKLOG_BYTES, WS_RELAY_REFUSAL_BODY_MAX_BYTES } from '../../packages/worker/src/session/ws-relay.ts';

function fakeSocket() {
  const listeners = new Map();
  return {
    accepted: false,
    sent: [],
    closedWith: null,
    // workerd's default (the standard binaryType): a binary frame is a Blob.
    binaryType: 'blob',
    accept() { this.accepted = true; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    send(data) { this.sent.push(data); },
    close(code, reason) { this.closedWith = { code, reason }; },
    fire(type, event) {
      const fn = listeners.get(type);
      if (!fn) return;
      // A binary frame as workerd delivers it under the socket's binaryType.
      if (type === 'message' && event.data instanceof ArrayBuffer && this.binaryType === 'blob') event = { data: new Blob([event.data]) };
      fn(event);
    },
  };
}

/**
 * fetch as workerd answers it: an upgrade goes to an http(s) URL, and any
 * other scheme is refused with workerd's own words (a ws: or wss: URL the
 * relay passed through unchanged failed every outbound socket this way).
 */
const fetched = [];
const sentHeaders = [];
function workerdFetch(answer) {
  return async (input, init) => {
    const url = String(input);
    if (!/^https?:/.test(url)) throw new TypeError(`Fetch API cannot load: ${url}`);
    fetched.push(url);
    sentHeaders.push([...new Headers(init?.headers)]);
    return answer();
  };
}

function stubUpgrade(socket, { status = 101, protocol = '' } = {}) {
  globalThis.fetch = workerdFetch(() => ({
    status,
    statusText: 'Switching Protocols',
    webSocket: socket,
    headers: new Headers({ ...(protocol ? { 'sec-websocket-protocol': protocol } : {}), 'x-server': 'upstream' }),
  }));
}

const PID = 1000002;
const OTHER_PID = 1000003;

// ── the upgrade, and what the facet is told when it does not happen ──
{
  const relay = new WebSocketRelay(() => ISOLATE_NETWORK);
  globalThis.fetch = workerdFetch(() => new Response('{"error":"unauthorized"}', {
    status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
  }));
  const refused = await relay.open(PID, 'wss://example.invalid/s', []);
  assert.deepEqual(refused, {
    refused: {
      status: 401,
      statusText: 'Unauthorized',
      headers: [['content-type', 'application/json'], ['www-authenticate', 'Bearer']],
      body: new TextEncoder().encode('{"error":"unauthorized"}'),
      truncated: false,
    },
  }, 'a destination that refuses the upgrade is answered as it answered: status, headers, body');

  globalThis.fetch = workerdFetch(() => new Response(new Uint8Array(WS_RELAY_REFUSAL_BODY_MAX_BYTES + 10), { status: 500 }));
  const long = await relay.open(PID, 'wss://example.invalid/s', []);
  assert.equal(long.refused.body.byteLength, WS_RELAY_REFUSAL_BODY_MAX_BYTES, 'a long refusal body is cut at the bound');
  assert.equal(long.refused.truncated, true, 'and says it was');
}

// ── the program's headers go with the upgrade, but the relay's own ──
{
  const relay = new WebSocketRelay(() => ISOLATE_NETWORK);
  stubUpgrade(fakeSocket(), { protocol: 'chat' });
  sentHeaders.length = 0;
  const opened = await relay.open(PID, 'wss://example.invalid/s', ['chat', 'superchat'], [
    ['Authorization', 'Bearer t'], ['Origin', 'https://app.example'], ['Cookie', 'a=1'], ['X-Custom', 'yes'],
    ['Host', 'evil.example'], ['Connection', 'keep-alive'], ['Sec-WebSocket-Key', 'k'], ['Sec-WebSocket-Version', '13'],
    ['Sec-WebSocket-Extensions', 'permessage-deflate'], ['Sec-WebSocket-Protocol', 'other'], ['Content-Length', '5'],
  ]);
  assert.deepEqual(sentHeaders[0], [
    ['authorization', 'Bearer t'], ['cookie', 'a=1'], ['origin', 'https://app.example'],
    ['sec-websocket-protocol', 'chat, superchat'], ['upgrade', 'websocket'], ['x-custom', 'yes'],
  ], "the program's headers, but the handshake's and the hop-by-hop ones, which are the relay's");
  assert.equal(opened.protocol, 'chat');
  assert.deepEqual(opened.headers, [['sec-websocket-protocol', 'chat'], ['x-server', 'upstream']], "the upgrade's response headers reach the facet");
}

// ── the upgrade goes to the socket's own address over http(s) ──
{
  const relay = new WebSocketRelay(() => ISOLATE_NETWORK);
  stubUpgrade(fakeSocket());
  fetched.length = 0;
  await relay.open(PID, 'wss://example.invalid:8443/s?x=1#f', []);
  await relay.open(PID, 'ws://example.invalid/plain', []);
  assert.deepEqual(fetched, ['https://example.invalid:8443/s?x=1', 'http://example.invalid/plain'],
    'wss: is fetched as https:, ws: as http:, with host, port, path and query kept (no fragment)');
}

// ── frames queued before the first poll are not lost ──
{
  const socket = fakeSocket();
  stubUpgrade(socket, { protocol: 'chat' });
  const relay = new WebSocketRelay(() => ISOLATE_NETWORK);
  const { id, protocol } = await relay.open(PID, 'wss://example.invalid/s', ['chat']);
  assert.equal(protocol, 'chat', 'the negotiated subprotocol reaches the facet');
  assert.ok(socket.accepted, 'the supervisor accepted the socket');

  socket.fire('message', { data: 'first' });
  const events = await relay.poll(PID, id, 100);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['open', 'message'],
    'the open event and a frame that landed before the first poll both arrive',
  );
  assert.equal(events[1].text, 'first');
  assert.equal(events[1].bytes, null);
}

// ── a frame that lands WHILE the facet is parked wakes the poll ──
{
  const socket = fakeSocket();
  stubUpgrade(socket);
  const relay = new WebSocketRelay(() => ISOLATE_NETWORK);
  const { id } = await relay.open(PID, 'wss://example.invalid/s', []);
  await relay.poll(PID, id, 100); // drain the open event

  const parked = relay.poll(PID, id, 5000);
  socket.fire('message', { data: new Uint8Array([1, 2, 3]).buffer });
  const events = await parked;
  assert.equal(events.length, 1, 'the parked poll returned as soon as the frame landed');
  assert.equal(events[0].text, null);
  assert.deepEqual([...events[0].bytes], [1, 2, 3], 'a binary frame crosses as bytes');
}

// ── an empty poll returns rather than parking forever ──
{
  const socket = fakeSocket();
  stubUpgrade(socket);
  const relay = new WebSocketRelay(() => ISOLATE_NETWORK);
  const { id } = await relay.open(PID, 'wss://example.invalid/s', []);
  await relay.poll(PID, id, 100);
  // Ordered, not timed: a timer due inside the window has fired by the time
  // the poll gives up on it.
  let dueInside = false;
  setTimeout(() => { dueInside = true; }, 5);
  assert.deepEqual(await relay.poll(PID, id, 30), [], 'a quiet socket returns empty');
  assert.equal(dueInside, true, 'and it waited for the window it was given');
}

// ── a socket belongs to the process that opened it ──
{
  const socket = fakeSocket();
  stubUpgrade(socket);
  const relay = new WebSocketRelay(() => ISOLATE_NETWORK);
  const { id } = await relay.open(PID, 'wss://example.invalid/s', []);
  const stolen = await relay.poll(OTHER_PID, id, 10);
  assert.deepEqual(
    stolen.map((e) => e.kind),
    ['close'],
    'another process guessing the id gets nothing but a close',
  );
  socket.fire('message', { data: 'secret' });
  relay.send(OTHER_PID, id, 'spoofed', null);
  assert.deepEqual(socket.sent, [], 'and cannot write to it either');
}

// ── the backlog is bounded in bytes, and says so ──
{
  const socket = fakeSocket();
  stubUpgrade(socket);
  const relay = new WebSocketRelay(() => ISOLATE_NETWORK);
  const { id } = await relay.open(PID, 'wss://example.invalid/s', []);
  const chunk = new Uint8Array(256 * 1024);
  for (let sent = 0; sent <= WS_RELAY_MAX_BACKLOG_BYTES + chunk.byteLength; sent += chunk.byteLength) {
    socket.fire('message', { data: chunk.buffer });
  }
  const events = await relay.poll(PID, id, 10);
  const last = events[events.length - 1];
  assert.equal(last.kind, 'close', 'overflow closes the socket instead of dropping frames');
  assert.equal(last.code, 1009);
  assert.match(
    last.reason,
    new RegExp(String(WS_RELAY_MAX_BACKLOG_BYTES)),
    'and the reason names the limit that was hit',
  );
  assert.equal(socket.closedWith.code, 1009, 'the real socket was closed too');
}

// ── every socket a process opened dies with it ──
{
  const socket = fakeSocket();
  stubUpgrade(socket);
  const relay = new WebSocketRelay(() => ISOLATE_NETWORK);
  const { id } = await relay.open(PID, 'wss://example.invalid/s', []);
  relay.closeForPid(PID);
  assert.equal(socket.closedWith.code, 1001, 'the process exiting closed its socket');
  const after = await relay.poll(PID, id, 10);
  assert.deepEqual(after.map((e) => e.kind), ['close'], 'the id is gone afterwards');
}

console.log('ws-relay: all assertions passed');
