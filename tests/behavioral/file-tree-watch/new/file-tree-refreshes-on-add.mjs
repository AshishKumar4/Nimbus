#!/usr/bin/env bun
// file-tree-watch/file-tree-refreshes-on-add — touch from terminal,
// fs-watch-event delivered within 1 s with type=add for the new file.
//
// Asserts the END-TO-END flow at the protocol layer (the FileTree
// IIFE's incremental refresh is asserted indirectly: the server-side
// event delivery is the necessary precondition. UI-layer assertions
// would need puppeteer + libglib which is unavailable in the sandbox
// per the W1 framework probe failures — so we assert the WS protocol
// directly, same shape as fs-watch-broadcasts-on-write but specific
// to the 'add' event type).

import { mintSession, Terminal, sleep, makeAsserter, BASE, WS_BASE } from '../../_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/file-tree-refreshes-on-add');
console.log(`file-tree-watch/file-tree-refreshes-on-add — ${BASE}`);

const sid = await mintSession();

const subWs = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const received = [];
let opened = false;
let subResult = null;
subWs.on('open', () => { opened = true; });
subWs.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (m.type === 'fs-watch-subscribe-result') subResult = m;
    if (m.type === 'fs-watch-event') received.push(m);
  } catch {}
});
{ const t0 = Date.now(); while (!opened && Date.now() - t0 < 10_000) await sleep(25); }
subWs.send(JSON.stringify({ type: 'fs-watch-subscribe', reqId: 90_000, paths: ['/home/user'] }));
{ const t0 = Date.now(); while (!subResult && Date.now() - t0 < 5_000) await sleep(25); }
a.check('subscribed ok', subResult && subResult.ok === true, `subResult=${JSON.stringify(subResult)}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const before = received.length;
const fileName = 'refreshes-add-' + Math.random().toString(36).slice(2, 8) + '.txt';
await t.run(`touch /home/user/${fileName}`, 10_000);

{ const t0 = Date.now(); while (received.length === before && Date.now() - t0 < 1000) await sleep(25); }

const events = received.slice(before).flatMap((f) => f.events || []);
const addHit = events.find((ev) => ev && ev.type === 'add'
  && typeof ev.path === 'string' && ev.path.endsWith(fileName));

a.check(`'add' event for ${fileName} received within 1 s`,
  addHit !== undefined,
  `events=${JSON.stringify(events.slice(-3))}`);

await t.close();
try { subWs.close(); } catch {}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
