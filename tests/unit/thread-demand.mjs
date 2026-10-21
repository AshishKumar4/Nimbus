#!/usr/bin/env bun
// thread-demand — what may want a session's thread while a one-shot computes
// there (packages/worker/src/session/thread-demand.ts), read from the
// session's own state: its terminal sockets as the session stamps them, and
// its process table and port registry.
import assert from 'node:assert/strict';
import { threadDemand } from '../../packages/worker/src/session/thread-demand.ts';
import { noteShellSocketActivity, tagShellSocket } from '../../packages/worker/src/session/shell-socket.ts';

/** A socket as workerd accepts one: open, its attachment kept. */
function socket() {
  let attachment = null;
  return { readyState: WebSocket.OPEN, serializeAttachment(value) { attachment = value; }, deserializeAttachment() { return attachment; } };
}
const now = Date.now();
const terminal = (name, seenAt = now) => {
  const ws = socket();
  tagShellSocket(ws, seenAt, name);
  noteShellSocketActivity(ws, seenAt);
  return ws;
};

function session({ sockets = [], processes = [], shells = [1], listening = [] } = {}) {
  const ctx = { getWebSockets: () => sockets, getWebSocketAutoResponseTimestamp: () => null };
  const table = new Map(processes.map((entry) => [entry.pid, entry]));
  const demand = threadDemand({
    ctx,
    processes: { getRunning: () => processes.filter((entry) => entry.state === 'running'), get: (pid) => table.get(pid) },
    listens: (pid) => listening.includes(pid),
    isShell: (pid) => shells.includes(pid),
  });
  return { ctx, demand };
}
const shell = { pid: 1, state: 'running', terminal: '' };
const run = { pid: 10, parentPid: 1, state: 'running', terminal: '' };

// The run's own terminal is not demand; another live one is.
assert.deepEqual(session({ sockets: [terminal(undefined)], processes: [shell, run] }).demand.wants(10), [], 'its own terminal alone: nothing');
assert.deepEqual(session({ sockets: [terminal(undefined), terminal('two')], processes: [shell, run] }).demand.wants(10), ['terminal'], 'another terminal attached');
// A terminal nobody holds any more is not demand.
assert.deepEqual(session({ sockets: [terminal(undefined), terminal('stale', now - 10 * 60_000)], processes: [shell, run] }).demand.wants(10), [],
  'a socket a closed tab left open, unstamped for minutes: nothing');
// A run with no terminal (an exec's): every live terminal is demand.
const headless = { pid: 20, state: 'running' };
assert.deepEqual(session({ sockets: [terminal(undefined)], processes: [shell, headless] }).demand.wants(20), ['terminal'], "an exec's run: the one terminal attached");
// Another running process; not the run's ancestors, not the shells.
const sh = { pid: 11, parentPid: 1, state: 'running', terminal: '' };
const child = { pid: 12, parentPid: 11, state: 'running', terminal: '' };
assert.deepEqual(session({ processes: [shell, sh, child] }).demand.wants(12), [], "its parent shell and the session's shell: nothing");
const server = { pid: 30, parentPid: 1, state: 'running', terminal: '' };
assert.deepEqual(session({ processes: [shell, run, server] }).demand.wants(10), ['process'], 'a server running beside it');
assert.deepEqual(session({ processes: [shell, run, { ...server, state: 'exited' }] }).demand.wants(10), [], 'one that ended: nothing');
// A server that starts the run still answers requests: a listening ancestor is demand.
const spawned = { pid: 31, parentPid: 30, state: 'running', terminal: '' };
assert.deepEqual(session({ processes: [shell, server, spawned], listening: [30] }).demand.wants(31), ['process'], 'its listening parent');
assert.deepEqual(session({ processes: [shell, server, spawned] }).demand.wants(31), [], 'a parent that does not listen waits for it: nothing');
console.log('thread-demand OK');
