#!/usr/bin/env bun
// file-tree-watch/file-tree-refreshes-on-mkdir — `mkdir /home/user/X`
// from terminal delivers fs-watch-event with type=addDir.

import { mintSession, Terminal, sleep, makeAsserter, BASE, WS_BASE, wsHeaders } from '../../_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/file-tree-refreshes-on-mkdir');
console.log(`file-tree-watch/file-tree-refreshes-on-mkdir — ${BASE}`);

const sid = await mintSession();

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
subWs.send(JSON.stringify({ type: 'fs-watch-subscribe', reqId: 92_000, paths: ['/home/user'] }));
{ const t0 = Date.now(); while (!subResult && Date.now() - t0 < 5_000) await sleep(25); }
a.check('subscribed ok', subResult && subResult.ok === true, `subResult=${JSON.stringify(subResult)}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const before = received.length;
const dirName = 'refreshes-mkdir-' + Math.random().toString(36).slice(2, 8);
await t.run(`mkdir /home/user/${dirName}`, 10_000);

// Wait for THIS mkdir's event, not for "some frame to arrive". The session
// seed writes /home/user/app and friends, and that burst can land after the
// first prompt — a wait that stops on any frame stops on the seed and reads
// the verdict off it. Measured propagation is 68 ms p50 / 78 ms p90 / 466 ms
// worst over 40 samples, 20 of them against a target carrying eight other
// sessions under continuous shell load, so 1 s is ~2x the worst observed.
const matchesMkdir = (ev) => ev && ev.type === 'addDir'
  && typeof ev.path === 'string' && ev.path.endsWith(dirName);
const findHit = () => received.slice(before).flatMap((f) => f.events || []).find(matchesMkdir);

let addDirHit;
{ const t0 = Date.now(); while (!(addDirHit = findHit()) && Date.now() - t0 < 1000) await sleep(25); }

const events = received.slice(before).flatMap((f) => f.events || []);

a.check(`'addDir' event for ${dirName} received within 1 s`,
  addDirHit !== undefined,
  `events=${JSON.stringify(events.slice(-5))}`);

await t.close();
try { subWs.close(); } catch {}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
