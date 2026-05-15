#!/usr/bin/env bun
// file-tree-watch/fs-watch-coalesces — 100 rapid writes produce far
// fewer FRAMES than events.
//
// Server-side debounce is 50 ms (COALESCE_MS in fs-watch.ts). 100
// rapid writes happen well within that window, so all 100 should be
// packed into 1-3 frames (timing variance) — definitely ≤ 10 frames.
// Total event COUNT should still reflect every write (100 events
// across the frames).

import { mintSession, Terminal, sleep, makeAsserter, BASE, WS_BASE } from '../../_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/fs-watch-coalesces');
console.log(`file-tree-watch/fs-watch-coalesces — ${BASE}`);

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
subWs.send(JSON.stringify({ type: 'fs-watch-subscribe', reqId: 93_000, paths: ['/home/user'] }));
{ const t0 = Date.now(); while (!subResult && Date.now() - t0 < 5_000) await sleep(25); }
a.check('subscribed ok', subResult && subResult.ok === true, `subResult=${JSON.stringify(subResult)}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const before = received.length;
// 100 rapid writes via a single bash loop — single command, single
// process — so all writes hit the bus within a few ms.
const tag = 'coal-' + Math.random().toString(36).slice(2, 7);
await t.run(
  `for i in $(seq 1 100); do echo "" > /home/user/${tag}-$i.txt; done`,
  60_000,
);

// Wait up to 2 s for the trailing frame to land.
await sleep(2000);

const newFrames = received.slice(before);
const allEvents = newFrames.flatMap((f) => Array.isArray(f.events) ? f.events : []);
// Filter to events for our tagged files (the shell wrapper may emit
// a few unrelated events for prompt-state etc.).
const ourEvents = allEvents.filter((ev) =>
  ev && typeof ev.path === 'string' && ev.path.includes(tag + '-'));

console.log(`[fs-watch-coalesces] frames=${newFrames.length} totalEvents=${allEvents.length} ourEvents=${ourEvents.length}`);

a.check('frames ≤ 10 (coalescing absorbed the burst)',
  newFrames.length <= 10,
  `frames=${newFrames.length} (allow up to 10 — typical 1-3)`);

a.check('our 100 writes produced ≥ 100 events across the frames',
  ourEvents.length >= 100,
  `ourEvents=${ourEvents.length} (expected ≥ 100)`);

await t.close();
try { subWs.close(); } catch {}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
