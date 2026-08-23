#!/usr/bin/env bun

// The /ws upgrade decides who owns the terminal from a stamp in the
// socket attachment. Two call sites in session/ws.ts maintain that stamp,
// and the classifier tests cannot see either one: delete either call and
// every assertion over classifyWsUpgrade still passes while real sessions
// break. These cover the call sites.

import assert from 'node:assert/strict';
import { wsClose, wsError, wsMessage } from '../../packages/worker/src/session/ws.ts';
import { hasLiveShellOwner, tagShellSocket } from '../../packages/worker/src/session/shell-socket.ts';

const HOUR = 3_600_000;

function shellSocket(attachment) {
  return {
    readyState: WebSocket.OPEN,
    sent: [],
    deserializeAttachment: () => attachment,
    serializeAttachment(next) { attachment = next; },
    send(frame) { this.sent.push(frame); },
    close() {},
  };
}

/** Only the fields the shell branch of these handlers touches. */
function host() {
  return {
    shell: null,
    terminal: null,
    kernel: null,
    cirrusReal: null,
    _cirrusHmrWsClients: null,
    _b4Phase: 'hydrated',
    wranglerAliasBannerShown: false,
    processes: { get: () => null, pidBase: 0 },
    ctx: {},
    _w5PersistRing: () => null,
    _w9FlushOnClose: () => {},
  };
}

const owned = (ws) => hasLiveShellOwner(undefined, [ws]);

{
  const ws = shellSocket({ kind: 'shell', seenAt: Date.now() - HOUR });
  assert.equal(owned(ws), false, 'an hour of silence is not ownership');

  await wsMessage(host(), ws, JSON.stringify({ type: 'input', data: 'ls\r' }));
  assert.equal(owned(ws), true);
  console.log('  [1] an inbound frame re-proves the peer is on the socket');
}

{
  // The client probes a quiet socket with this frame rather than a ping,
  // so it has to count as the peer speaking.
  const ws = shellSocket({ kind: 'shell', seenAt: Date.now() - HOUR });
  await wsMessage(host(), ws, JSON.stringify({
    type: 'fs-watch-unsubscribe', subId: 'nimbus-liveness-probe', reqId: 'liveness-1',
  }));
  assert.equal(owned(ws), true);
  console.log('  [2] the liveness probe the browser sends counts as a frame');
}

{
  const ws = shellSocket({ kind: 'shell', seenAt: Date.now() - HOUR });
  await wsMessage(host(), ws, 'not json at all');
  assert.equal(owned(ws), true, 'a frame arriving is proof, whatever it says');
  console.log('  [3] even an unparseable frame proves the peer is there');
}

{
  const watcher = shellSocket({ kind: 'fs-watch' });
  await wsMessage(host(), watcher, JSON.stringify({ type: 'input', data: 'x' }));
  assert.equal(owned(watcher), false);
  console.log('  [4] a watcher socket never becomes the terminal owner');
}

{
  // The frame that triggered the close stamped the socket a moment ago.
  // Left alone, that stamp refuses the reconnect for the whole window.
  const ws = shellSocket(null);
  tagShellSocket(ws);
  assert.equal(owned(ws), true);
  await wsClose(host(), ws, 1006, '', false);
  assert.equal(owned(ws), false);
  console.log('  [5] a closed socket stops owning the terminal at once');
}

{
  // workerd cancels a handler that outruns the 5 s cap. Same conclusion.
  const ws = shellSocket(null);
  tagShellSocket(ws);
  await wsError(host(), ws, new Error('handler timed out'));
  assert.equal(owned(ws), false);
  console.log('  [6] an errored socket stops owning the terminal at once');
}

console.log('session-ws-liveness-stamp OK: ws.ts keeps the ownership stamp honest');
