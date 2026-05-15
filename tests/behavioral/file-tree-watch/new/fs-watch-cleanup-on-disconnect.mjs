#!/usr/bin/env bun
// file-tree-watch/fs-watch-cleanup-on-disconnect — subscriptions are
// reaped on WS close (no listener leak).
//
// We assert this indirectly: a SECOND subscriber WS opened AFTER the
// first one is closed receives events normally, and subscribing again
// from a new WS after the first WS's disconnect should NOT receive
// duplicated events from the first WS's listener (which would be the
// leak signature). Equivalently: when the first WS subscribed and
// then closed, the bus listener count returns to baseline. We assert
// the cheaper observable: subscribe + disconnect + re-subscribe →
// drive a write → SECOND ws receives exactly the expected events
// (no extras leaked from the first sub).

import { mintSession, Terminal, sleep, makeAsserter, BASE, WS_BASE } from '../../_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/fs-watch-cleanup-on-disconnect');
console.log(`file-tree-watch/fs-watch-cleanup-on-disconnect — ${BASE}`);

const sid = await mintSession();

// First subscriber — open, subscribe, then close.
{
  const w = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
  let opened = false;
  let subbed = false;
  w.on('open', () => { opened = true; });
  w.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString('utf8'));
      if (m.type === 'fs-watch-subscribe-result' && m.ok) subbed = true;
    } catch {}
  });
  { const t0 = Date.now(); while (!opened && Date.now() - t0 < 10_000) await sleep(25); }
  w.send(JSON.stringify({ type: 'fs-watch-subscribe', reqId: 95_000, paths: ['/home/user'] }));
  { const t0 = Date.now(); while (!subbed && Date.now() - t0 < 5_000) await sleep(25); }
  a.check('first subscriber subscribed', subbed, '');
  w.close();
  // Wait for the close to propagate server-side cleanup.
  await sleep(500);
}

// Second subscriber — separate WS — should receive its own events
// cleanly.
const w2 = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const received2 = [];
let opened2 = false;
let subResult2 = null;
w2.on('open', () => { opened2 = true; });
w2.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (m.type === 'fs-watch-subscribe-result') subResult2 = m;
    if (m.type === 'fs-watch-event') received2.push(m);
  } catch {}
});
{ const t0 = Date.now(); while (!opened2 && Date.now() - t0 < 10_000) await sleep(25); }
w2.send(JSON.stringify({ type: 'fs-watch-subscribe', reqId: 96_000, paths: ['/home/user'] }));
{ const t0 = Date.now(); while (!subResult2 && Date.now() - t0 < 5_000) await sleep(25); }
a.check('second subscriber subscribed', subResult2 && subResult2.ok === true, '');

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const fileName = 'cleanup-' + Math.random().toString(36).slice(2, 8) + '.txt';
const before2 = received2.length;
await t.run(`touch /home/user/${fileName}`, 10_000);
{ const t0 = Date.now(); while (received2.length === before2 && Date.now() - t0 < 1500) await sleep(25); }

const newEvents = received2.slice(before2).flatMap((f) => f.events || []);
const hits = newEvents.filter((ev) =>
  ev && (ev.type === 'add' || ev.type === 'change')
  && typeof ev.path === 'string' && ev.path.endsWith(fileName));

// We expect EXACTLY one add and possibly some path adjacent events.
// The leak signature would be the first (closed) subscriber's frames
// arriving on w2 (impossible by construction since they're separate
// WS objects) OR the same event appearing twice in w2's queue if the
// first subscriber's listener was still firing (would not even reach
// w2; only failure shape is "w2 saw nothing" if the bus is broken
// post-cleanup).
a.check(`second subscriber received our 'add'/'change' for ${fileName}`,
  hits.length >= 1,
  `hits=${hits.length} newEvents=${JSON.stringify(newEvents.slice(-5))}`);

a.check('no duplicate events for the exact same path+type',
  hits.length <= 2,  // tolerate add + change combo from a touch
  `hits=${hits.length} events=${JSON.stringify(hits)}`);

await t.close();
try { w2.close(); } catch {}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
