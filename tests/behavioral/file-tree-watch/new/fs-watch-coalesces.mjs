#!/usr/bin/env bun
// file-tree-watch/fs-watch-coalesces — 100 rapid writes produce far
// fewer FRAMES than events.
//
// The server debounces a subscription's events for COALESCE_MS
// (fs-watch.ts). 100 rapid writes land in 1-3 frames (timing variance),
// at most 10, and every written path gets its one add event.

import { mintSession, sleep, readUntil, makeAsserter, BASE, WS_BASE, wsHeaders } from '../../_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/fs-watch-coalesces');
console.log(`file-tree-watch/fs-watch-coalesces — ${BASE}`);

/** fs-watch.ts COALESCE_MS. */
const COALESCE_MS = 50;

const sid = await mintSession();

const subWs = new WebSocket(`${WS_BASE}/s/${sid}/ws?kind=fs-watch`, wsHeaders(sid));
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

const driverWs = new WebSocket(`${WS_BASE}/s/${sid}/ws`, wsHeaders(sid));
const driverResponses = new Map();
let driverOpened = false;
driverWs.on('open', () => { driverOpened = true; });
driverWs.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (typeof m.reqId === 'number' && m.type === 'fs-write-result') {
      driverResponses.set(m.reqId, m);
    }
  } catch {}
});
{ const t0 = Date.now(); while (!driverOpened && Date.now() - t0 < 10_000) await sleep(25); }
a.check('driver WS opened', driverOpened, '');

const before = received.length;
const tag = 'coal-' + Math.random().toString(36).slice(2, 7);
for (let i = 1; i <= 100; i++) {
  driverWs.send(JSON.stringify({
    type: 'fs-write',
    reqId: 94_000 + i,
    path: `/home/user/${tag}-${i}.txt`,
    content: '',
  }));
}
{ const t0 = Date.now(); while (driverResponses.size < 100 && Date.now() - t0 < 10_000) await sleep(25); }
const failedWrites = [...driverResponses.values()].filter((response) => response.ok !== true);
a.check('all 100 fs-writes succeeded',
  driverResponses.size === 100 && failedWrites.length === 0,
  `responses=${driverResponses.size} failed=${JSON.stringify(failedWrites.slice(0, 3))}`);

// Each written path, and the 'add' events each got, in the frames since the burst began.
const expected = new Set(Array.from({ length: 100 }, (_, i) => `home/user/${tag}-${i + 1}.txt`));
const adds = () => {
  const counts = new Map();
  for (const frame of received.slice(before)) {
    for (const event of frame.events ?? []) {
      if (event?.type === 'add' && expected.has(event.path)) counts.set(event.path, (counts.get(event.path) ?? 0) + 1);
    }
  }
  return counts;
};
const seen = await readUntil(adds, (counts) => counts.size === expected.size, 10_000);
// Frames a burst's last writes produce trail its first: the frame budget
// counts what arrives for ten debounce periods after every path was seen.
await sleep(COALESCE_MS * 10);
const frames = received.length - before;
const repeated = [...adds()].filter(([, count]) => count > 1);
console.log(`[fs-watch-coalesces] frames=${frames} paths with an add=${seen.size}`);

a.check('every written path gets its add event',
  seen.size === expected.size,
  `missing=${JSON.stringify([...expected].filter((path) => !seen.has(path)).slice(0, 5))}`);
a.check('each path gets one add event', repeated.length === 0, JSON.stringify(repeated.slice(0, 5)));
a.check('frames ≤ 10 (coalescing absorbed the burst)',
  frames <= 10,
  `frames=${frames} (allow up to 10 — typical 1-3)`);

try { subWs.close(); } catch {}
try { driverWs.close(); } catch {}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
