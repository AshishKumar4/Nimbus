#!/usr/bin/env bun

// The persisted shell state (cwd, env) is what a rebuilt session resumes
// from. It used to be written only after each inbound frame, and commands
// run asynchronously, so the row always recorded the state BEFORE the
// line that just ran: `cd /tmp && echo one`, then ten quiet seconds, and
// the woken shell answered `pwd` from /home/user (measured 2026-09-14).
// The next frame used to catch the row up; hibernation means there is no
// next frame on this instance. Every output flush of the shell terminal
// now snapshots too — the prompt that ends a command is one — and an
// unchanged state costs no SQL.

import assert from 'node:assert/strict';
import { shellTerminalTee, wsMessage } from '../../packages/worker/src/session/ws.ts';

/** A storage whose only job is to record what was written to the kv table. */
function storage() {
  const writes = [];
  return {
    writes,
    sql: {
      exec(query, ...args) {
        if (/INSERT OR REPLACE INTO nimbus_session_kv/.test(query)) writes.push({ k: args[0], v: args[1] });
        return [];
      },
    },
  };
}

function host() {
  const store = storage();
  const shell = {
    cwd: '/home/user',
    env: { HOME: '/home/user' },
    getCwd() { return this.cwd; },
    getEnv() { return this.env; },
  };
  return {
    store,
    shell,
    kernel: {},
    terminal: { ws: null, handleMessage() {} },
    cirrusReal: null,
    _cirrusHmrWsClients: null,
    _b4Phase: 'hydrated',
    wranglerAliasBannerShown: false,
    processes: { get: () => null, pidBase: 0 },
    ctx: { storage: store },
    _w5PersistRing: () => null,
    _w9FlushOnClose: () => {},
    _wakeRebuild: null,
    async initSession() { throw new Error('not expected: the session is built'); },
  };
}

const cwdWrites = (h) => h.store.writes.filter((w) => w.k === 'cwd').map((w) => w.v);

{
  const h = host();
  const ws = { readyState: WebSocket.OPEN, send() {}, deserializeAttachment: () => ({ kind: 'shell', seenAt: Date.now() }), serializeAttachment() {} };
  h.terminal.ws = ws;
  // The frame is snapshotted right after it is handled — before the
  // asynchronous command has changed anything.
  await wsMessage(h, ws, JSON.stringify({ type: 'input', data: 'cd /tmp\r' }));
  assert.deepEqual(cwdWrites(h), ['/home/user'], 'the inbound snapshot records the pre-command cwd');

  // The command takes effect, then its prompt flushes through the tee.
  h.shell.cwd = '/tmp';
  const tee = shellTerminalTee(h);
  tee('user@nimbus:/tmp$ ');
  assert.deepEqual(cwdWrites(h), ['/home/user', '/tmp'], 'the flush that carries the prompt persists the new cwd');
  console.log('  [1] the output flush after a command persists the state the command produced');
}

{
  const h = host();
  const tee = shellTerminalTee(h);
  tee('first\r\n');
  tee('second\r\n');
  tee('third\r\n');
  assert.equal(cwdWrites(h).length, 1, 'an unchanged state is written once, not per flush');
  h.shell.env = { ...h.shell.env, FOO: 'bar' };
  tee('user@nimbus:~$ ');
  const envWrites = h.store.writes.filter((w) => w.k === 'env');
  assert.equal(envWrites.length, 2, 'an env change is a change');
  assert.match(envWrites[1].v, /"FOO":"bar"/);
  console.log('  [2] a chatty command costs one write, and an export costs one more');
}

console.log('session-shell-state-on-flush OK: the persisted shell state keeps up with the shell');
