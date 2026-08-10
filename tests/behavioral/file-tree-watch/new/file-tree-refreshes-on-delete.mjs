#!/usr/bin/env bun
// file-tree-watch/file-tree-refreshes-on-delete — rm from terminal,
// fs-watch-event delivered with type=unlink for the removed file.

import { mintSession, Terminal, sleep, makeAsserter, BASE, WS_BASE, wsHeaders } from '../../_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/file-tree-refreshes-on-delete');
console.log(`file-tree-watch/file-tree-refreshes-on-delete — ${BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

// Create the file first; subscribe AFTER creation; then delete + assert.
const fileName = 'refreshes-del-' + Math.random().toString(36).slice(2, 8) + '.txt';
await t.run(`touch /home/user/${fileName}`, 10_000);

const subWs = new WebSocket(`${WS_BASE}/s/${sid}/ws?kind=fs-watch`, wsHeaders());
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
subWs.send(JSON.stringify({ type: 'fs-watch-subscribe', reqId: 91_000, paths: ['/home/user'] }));
{ const t0 = Date.now(); while (!subResult && Date.now() - t0 < 5_000) await sleep(25); }
a.check('subscribed ok', subResult && subResult.ok === true, `subResult=${JSON.stringify(subResult)}`);

const before = received.length;
await t.run(`rm /home/user/${fileName}`, 10_000);

// Wait for THIS rm's event, not for "some frame to arrive" — see the note in
// file-tree-refreshes-on-mkdir.mjs. Measured propagation is 68 ms p50 /
// 78 ms p90 / 466 ms worst, so 1 s is ~2x the worst observed.
const matchesUnlink = (ev) => ev && ev.type === 'unlink'
  && typeof ev.path === 'string' && ev.path.endsWith(fileName);
const findHit = () => received.slice(before).flatMap((f) => f.events || []).find(matchesUnlink);

let unlinkHit;
{ const t0 = Date.now(); while (!(unlinkHit = findHit()) && Date.now() - t0 < 1000) await sleep(25); }

const events = received.slice(before).flatMap((f) => f.events || []);

a.check(`'unlink' event for ${fileName} received within 1 s`,
  unlinkHit !== undefined,
  `events=${JSON.stringify(events.slice(-5))}`);

await t.close();
try { subWs.close(); } catch {}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
