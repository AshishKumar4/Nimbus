#!/usr/bin/env bun

// A hibernated session object is evicted from memory while its accepted
// shell socket stays open. The frame that wakes it lands on a fresh
// instance with no shell, terminal or kernel, and before this seam existed
// the message handler looked the terminal up, found null, and returned
// "ok" — the peer's command vanished with no output, no close and no
// error (measured live 2026-09-14: 8 s idle fine, 10 s idle dead). The
// handler now rebuilds the session on the socket that spoke, before the
// frame is handled. These cover that seam: session/ws.ts bindShellSocket
// as reached through wsMessage.

import assert from 'node:assert/strict';
import { wsMessage } from '../../packages/worker/src/session/ws.ts';

function socket(attachment) {
  return {
    readyState: WebSocket.OPEN,
    sent: [],
    closed: null,
    deserializeAttachment: () => attachment,
    serializeAttachment(next) { attachment = next; },
    send(frame) { this.sent.push(frame); },
    close(code, reason) { this.closed = { code, reason }; },
  };
}

const shellSocket = () => socket({ kind: 'shell', seenAt: Date.now() });

function terminalOn(ws) {
  return {
    ws,
    handled: [],
    attached: [],
    handleMessage(msg) { this.handled.push(msg); },
    attach(next) { this.attached.push(next); this.ws = next; },
  };
}

/**
 * A host as a woken instance sees it: nothing built. `build` decides how
 * initSession behaves; the default builds synchronously-after-a-tick, the
 * way the real one resolves after its SQL reads.
 */
function wokenHost(build) {
  const host = {
    shell: null,
    terminal: null,
    kernel: null,
    cirrusReal: null,
    _cirrusHmrWsClients: null,
    _b4Phase: null,
    wranglerAliasBannerShown: false,
    processes: { get: () => null, pidBase: 0 },
    ctx: {},
    _w5PersistRing: () => null,
    _w9FlushOnClose: () => {},
    _wakeRebuild: null,
    initCalls: [],
    async initSession(ws, options) {
      this.initCalls.push({ ws, options });
      if (build) return build(this, ws);
      await Promise.resolve();
      this.shell = {};
      this.kernel = {};
      this.terminal = terminalOn(ws);
    },
  };
  return host;
}

const input = (data) => JSON.stringify({ type: 'input', data });

{
  const host = wokenHost();
  const ws = shellSocket();
  await wsMessage(host, ws, input('echo two\r'));
  assert.equal(host.initCalls.length, 1, 'the frame rebuilt the session');
  assert.equal(host.initCalls[0].ws, ws, 'on the socket that spoke');
  assert.deepEqual(host.initCalls[0].options, { resume: 'wake' }, 'as a wake, not a reconnect');
  assert.deepEqual(host.terminal.handled, [{ type: 'input', data: 'echo two\r' }],
    'and the frame reached the shell the rebuild produced');
  assert.equal(host._wakeRebuild, null, 'nothing left in flight');
  console.log('  [1] a frame on a woken instance rebuilds the session, then lands on it');
}

{
  // Two keystrokes arrive while the build is still running. One build,
  // both frames delivered to it, in order.
  let release;
  const host = wokenHost((self, ws) => new Promise((resolve) => {
    release = () => {
      self.shell = {};
      self.kernel = {};
      self.terminal = terminalOn(ws);
      resolve();
    };
  }));
  const ws = shellSocket();
  const first = wsMessage(host, ws, input('a'));
  const second = wsMessage(host, ws, input('b'));
  await Promise.resolve();
  assert.equal(host.initCalls.length, 1, 'the second frame joined the build in flight');
  assert.equal(host.terminal, null, 'nothing delivered before the build finished');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(host.terminal.handled.map((m) => m.data), ['a', 'b']);
  console.log('  [2] frames that arrive during the build await it — one build, all delivered');
}

{
  const host = wokenHost();
  const ws = shellSocket();
  host.shell = {};
  host.kernel = {};
  host.terminal = terminalOn(ws);
  await wsMessage(host, ws, input('ls\r'));
  assert.equal(host.initCalls.length, 0, 'a live session is not rebuilt');
  assert.equal(host.terminal.attached.length, 0, 'nor re-attached to the socket it already has');
  assert.deepEqual(host.terminal.handled.map((m) => m.data), ['ls\r']);
  console.log('  [3] a resident session handles the frame as before');
}

{
  // An SDK call woke the instance first and built the session on its
  // headless terminal. The browser's frame takes the terminal over.
  const host = wokenHost();
  const headless = { readyState: WebSocket.OPEN, send() {} };
  const ws = shellSocket();
  host.shell = {};
  host.kernel = {};
  host.terminal = terminalOn(headless);
  await wsMessage(host, ws, input('pwd\r'));
  assert.equal(host.initCalls.length, 0, 'no second build');
  assert.deepEqual(host.terminal.attached, [ws], 'the speaking socket is handed the terminal');
  assert.deepEqual(host.terminal.handled.map((m) => m.data), ['pwd\r']);
  console.log('  [4] a session built on another socket is handed to the one that speaks');
}

{
  const host = wokenHost(async () => { throw new Error('mounts table missing'); });
  const ws = shellSocket();
  await wsMessage(host, ws, input('echo two\r'));
  assert.equal(ws.closed?.code, 1011, 'a failed rebuild closes the socket, it does not go quiet');
  assert.match(ws.closed.reason, /rebuild after wake failed: mounts table missing/);
  assert.equal(host.terminal, null);
  assert.equal(host._wakeRebuild, null, 'the failure does not pin the next frame to a dead promise');
  console.log('  [5] a rebuild that fails tells the peer why, with a close frame');
}

{
  const host = wokenHost();
  await wsMessage(host, socket({ kind: 'fs-watch' }), input('x'));
  await wsMessage(host, socket({ kind: 'process-logs', pid: 7 }), JSON.stringify({ type: 'stdin', pid: 7, data: 'x' }));
  await wsMessage(host, socket({ kind: 'cirrus-hmr', clientId: 'c1' }), '{"type":"ping"}');
  assert.equal(host.initCalls.length, 0, 'only a shell socket has a session to rebuild');
  console.log('  [6] watcher, process-log and HMR sockets never rebuild the session');
}

{
  // Destroy closes every accepted socket and nulls the terminal before it
  // wipes storage; a frame still in flight on one of those sockets must
  // not rebuild the session being torn down.
  const host = wokenHost();
  const ws = shellSocket();
  ws.readyState = WebSocket.CLOSING;
  await wsMessage(host, ws, input('echo two\r'));
  assert.equal(host.initCalls.length, 0, 'a socket this side has closed gets no session');
  assert.equal(host.terminal, null);
  console.log('  [7] a frame on a socket already closing here is dropped, not built for');
}

console.log('session-ws-wake-rebuild OK: a woken instance rebuilds the session on the socket that spoke');
