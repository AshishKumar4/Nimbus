#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { classifyWsUpgrade } from '../../packages/worker/src/session/init-phases.ts';
import { SHELL_OWNER_LIVENESS_MS } from '../../packages/worker/src/session/shell-socket.ts';

const NOW = 1_700_000_000_000;

function makeSession(ctx) {
  return {
    _b4Phase: 'hydrated',
    shell: {},
    terminal: {},
    kernel: {},
    ctx,
  };
}

/**
 * A socket as the upgrade handler sees it: a readyState, an attachment
 * that survives hibernation, and whatever the runtime last auto-answered
 * on it. An absent `seenAt` models a socket an older deploy tagged.
 */
function socket({ kind = 'shell', readyState = WebSocket.OPEN, seenAt, autoResponseAt } = {}) {
  const attachment = seenAt === undefined ? { kind } : { kind, seenAt };
  return {
    readyState,
    autoResponseAt: autoResponseAt ?? null,
    deserializeAttachment: () => attachment,
    serializeAttachment: (next) => { Object.assign(attachment, next); },
  };
}

function ctxFor(sockets) {
  return {
    getWebSocketAutoResponseTimestamp: (ws) => sockets.find((s) => s === ws)?.autoResponseAt ?? null,
  };
}

function classify(self, sockets) {
  return classifyWsUpgrade(self, sockets, NOW);
}

{
  const sockets = [
    socket({ kind: 'fs-watch', seenAt: NOW }),
    socket({ readyState: WebSocket.CLOSED, seenAt: NOW }),
    { readyState: WebSocket.OPEN, deserializeAttachment: () => { throw new Error('bad attachment'); } },
  ];
  assert.equal(classify(makeSession(ctxFor(sockets)), sockets), 'warm-join');
  console.log('  [1] a headless hydrated session with no open shell socket warm-joins');
}

{
  const sockets = [socket({ seenAt: NOW - 3_000 })];
  assert.equal(classify(makeSession(ctxFor(sockets)), sockets), 'conflict');
  console.log('  [2] a second tab is refused while the first one is proven live');
}

{
  const half = makeSession(ctxFor([]));
  half.terminal = null;
  assert.equal(classify(half, []), 'cold');

  const noKernel = makeSession(ctxFor([]));
  noKernel.kernel = null;
  assert.equal(classify(noKernel, []), 'cold');

  const cold = makeSession(ctxFor([]));
  cold.shell = null;
  assert.equal(classify(cold, []), 'cold');
  console.log('  [3] a half-built session rebuilds instead of refusing itself forever');
}

{
  // The owner's tab vanished without a close frame. The socket still reads
  // OPEN, so readyState alone locks the session out for good.
  const ghost = [socket({ seenAt: NOW - SHELL_OWNER_LIVENESS_MS - 1 })];
  assert.equal(classify(makeSession(ctxFor(ghost)), ghost), 'warm-join');

  const neverStamped = [socket({})];
  assert.equal(classify(makeSession(ctxFor(neverStamped)), neverStamped), 'warm-join');
  console.log('  [4] a ghost socket no longer holds the session hostage');
}

{
  // The object hibernated, so isolate memory holds nothing about this
  // socket. The attachment survives the sleep and still names its owner.
  const hibernated = [socket({ seenAt: NOW - 20_000 })];
  assert.equal(classify(makeSession(ctxFor(hibernated)), hibernated), 'conflict');

  // A tab that only pings never wakes the object, so nothing stamps the
  // attachment. The runtime's own auto-response is the proof it is there.
  const pinger = [socket({
    seenAt: NOW - SHELL_OWNER_LIVENESS_MS - 1,
    autoResponseAt: new Date(NOW - 2_000),
  })];
  assert.equal(classify(makeSession(ctxFor(pinger)), pinger), 'conflict');
  console.log('  [5] a live tab keeps the terminal across hibernation');
}

console.log('session-ws-upgrade OK: /ws decisions follow the live shell socket');
