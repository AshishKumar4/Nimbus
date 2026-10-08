#!/usr/bin/env bun
// A probe's WebSockets ping while they are open. One that carries nothing
// either way for about 270 s is dropped on the way to the session (close
// 1006, no close frame), and a probe waiting on a command that prints
// nothing for that long read the drop as its session resetting.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const server = createServer();
const sockets = new WebSocketServer({ server });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
// connectProcessTerminal dials the suite's BASE.
process.env.BASE = base;
const { Terminal, connectProcessTerminal, sleep } = await import('../behavioral/_driver.mjs');
const failures = [];

/** `open` connects a socket that then stays quiet, and returns it and how to close it. */
async function quiet(name, open) {
  try {
    const connected = once(sockets, 'connection');
    const { ws, close } = await open();
    const [peer] = await connected;
    let received = 0;
    peer.on('ping', () => { received++; });
    let sent = 0;
    const ping = ws.ping.bind(ws);
    ws.ping = (...args) => { sent++; return ping(...args); };
    await sleep(150);
    assert.ok(received >= 2, `the session got ${received} pings in 150 ms of quiet at a 20 ms keepalive`);
    await close();
    const before = sent;
    await sleep(100);
    assert.equal(sent, before, 'a closed socket is not pinged');
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

try {
  await quiet('a quiet terminal socket is pinged until it closes', async () => {
    const terminal = new Terminal('keepalive', { base, wsOptions: {}, keepaliveMs: 20 });
    await terminal.connect();
    return { ws: terminal.ws, close: () => terminal.close() };
  });

  await quiet('a quiet process terminal socket is pinged until it closes', async () => {
    const terminal = await connectProcessTerminal('keepalive', 1, { keepaliveMs: 20 });
    return { ws: terminal.ws, close: async () => { const closed = once(terminal.ws, 'close'); terminal.ws.close(); await closed; } };
  });
} finally {
  for (const peer of sockets.clients) peer.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
assert.deepEqual(failures, []);
console.log('behavioral-socket-keepalive: PASS');
