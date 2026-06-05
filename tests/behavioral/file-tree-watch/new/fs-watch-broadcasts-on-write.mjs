#!/usr/bin/env bun
// file-tree-watch/fs-watch-broadcasts-on-write — server pushes
// fs-watch-event on a terminal-driven write.
//
// Foundational probe for the wave: prove the new WS protocol works
// end-to-end. Subscribe via a second WS (raw — not the Terminal class
// since we need to receive fs-watch-event frames, not just terminal
// output), then drive a write through a separate Terminal, then
// assert the second WS received the event within 1500 ms (50 ms
// server coalesce + ~300 ms network + safety margin).

import { mintSession, Terminal, sleep, makeAsserter, BASE, WS_BASE } from '../../_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/fs-watch-broadcasts-on-write');
console.log(`file-tree-watch/fs-watch-broadcasts-on-write — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

// Subscriber WS (raw).
const subWs = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
let opened = false;
const received = []; // fs-watch-event frames
let subscribeResult = null;
let nextReqId = 80_000;
subWs.on('open', () => { opened = true; });
subWs.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (m && m.type === 'fs-watch-subscribe-result') subscribeResult = m;
    if (m && m.type === 'fs-watch-event') received.push(m);
  } catch { /* ignore */ }
});
{
  const t0 = Date.now();
  while (!opened && Date.now() - t0 < 15_000) await sleep(25);
  a.check('subscriber WS opened', opened, '');
}
// Subscribe to /home/user
subWs.send(JSON.stringify({
  type: 'fs-watch-subscribe',
  reqId: nextReqId++,
  paths: ['/home/user'],
}));
{
  const t0 = Date.now();
  while (!subscribeResult && Date.now() - t0 < 5_000) await sleep(25);
  a.check('fs-watch-subscribe-result received',
    subscribeResult && subscribeResult.ok === true,
    `result=${JSON.stringify(subscribeResult)}`);
}

// Driver Terminal — issues the write through the shell.
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

// Snapshot received count before the write.
const baseCount = received.length;
await t.run('touch /home/user/probe-broadcast.txt', 10_000);

// Wait up to 1500 ms for the fs-watch-event.
{
  const t0 = Date.now();
  while (received.length === baseCount && Date.now() - t0 < 1500) await sleep(25);
}

// Find an event matching our touched file.
const newFrames = received.slice(baseCount);
const allEvents = newFrames.flatMap((f) => Array.isArray(f.events) ? f.events : []);
const hit = allEvents.find((ev) =>
  ev && (ev.type === 'add' || ev.type === 'change')
  && typeof ev.path === 'string'
  && ev.path.endsWith('probe-broadcast.txt'));

a.check('fs-watch-event received within 1500ms for new file',
  hit !== undefined,
  `frameCount=${newFrames.length} eventCount=${allEvents.length} sample=${JSON.stringify(allEvents.slice(-3))}`);

await t.close();
try { subWs.close(); } catch {}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
