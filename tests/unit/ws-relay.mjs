#!/usr/bin/env bun
// The supervisor half of the WebSocket relay. A facet's socket is terminated
// here so an inbound frame reaches it as a supervisor reply — the only shape
// a cache invalidation can ride on.
//
// What matters beyond "frames arrive": a relay that silently dropped frames
// would trade a coherence bug for a data-loss bug, an unbounded one would let
// a chatty endpoint evict the supervisor from its 64 MiB heap, and one keyed
// only by an integer id would let a facet read another process's socket.

import assert from 'node:assert/strict';
import { WebSocketRelay, WS_RELAY_MAX_BACKLOG_BYTES } from '../../packages/worker/src/session/ws-relay.ts';

function fakeSocket() {
  const listeners = new Map();
  return {
    accepted: false,
    sent: [],
    closedWith: null,
    accept() { this.accepted = true; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    send(data) { this.sent.push(data); },
    close(code, reason) { this.closedWith = { code, reason }; },
    fire(type, event) { const fn = listeners.get(type); if (fn) fn(event); },
  };
}

function stubUpgrade(socket, { status = 101, protocol = '' } = {}) {
  globalThis.fetch = async () => ({
    status,
    webSocket: socket,
    headers: { get: (name) => (name === 'sec-websocket-protocol' ? protocol : null) },
  });
}

const PID = 1000002;
const OTHER_PID = 1000003;

// ── the upgrade, and what the facet is told when it does not happen ──
{
  const relay = new WebSocketRelay();
  globalThis.fetch = async () => ({ status: 404, webSocket: null, headers: { get: () => null } });
  await assert.rejects(
    () => relay.open(PID, 'wss://example.invalid/s', []),
    /did not upgrade \(HTTP 404\)/,
    'a destination that refuses the upgrade names itself and the status',
  );
}

// ── frames queued before the first poll are not lost ──
{
  const socket = fakeSocket();
  stubUpgrade(socket, { protocol: 'chat' });
  const relay = new WebSocketRelay();
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
  const relay = new WebSocketRelay();
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
  const relay = new WebSocketRelay();
  const { id } = await relay.open(PID, 'wss://example.invalid/s', []);
  await relay.poll(PID, id, 100);
  const started = Date.now();
  assert.deepEqual(await relay.poll(PID, id, 30), [], 'a quiet socket returns empty');
  assert.ok(Date.now() - started >= 25, 'and it waited for the window it was given');
}

// ── a socket belongs to the process that opened it ──
{
  const socket = fakeSocket();
  stubUpgrade(socket);
  const relay = new WebSocketRelay();
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
  const relay = new WebSocketRelay();
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
  const relay = new WebSocketRelay();
  const { id } = await relay.open(PID, 'wss://example.invalid/s', []);
  relay.closeForPid(PID);
  assert.equal(socket.closedWith.code, 1001, 'the process exiting closed its socket');
  const after = await relay.poll(PID, id, 10);
  assert.deepEqual(after.map((e) => e.kind), ['close'], 'the id is gone afterwards');
}

console.log('ws-relay: all assertions passed');
