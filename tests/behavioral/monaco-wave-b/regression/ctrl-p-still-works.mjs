#!/usr/bin/env bun
// monaco-wave-b/regression/ctrl-p-still-works — Wave-A Ctrl+P
// palette + protocol round-trip preserved.

import WebSocket from 'ws';
import { mintSession, BASE, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/regression/ctrl-p-still-works');
console.log(`monaco-wave-b/regression/ctrl-p-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

a.check('Ctrl+P global keydown handler still present',
  /isCtrlP\s*=\s*\(e\.ctrlKey\s*\|\|\s*e\.metaKey\)\s*&&\s*e\.key\s*===\s*['"]p['"]/.test(html),
  `wiring missing`);
a.check('palette overlay DOM still present',
  /id=["']paletteOverlay["']/.test(html) && /id=["']paletteInput["']/.test(html),
  `palette DOM incomplete`);

// Protocol — fs-list round-trip (what openPalette uses).
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const messages = [];
ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(()=>rej('timeout'), 10_000); });

ws.send(JSON.stringify({ type: 'fs-list', dir: '/home/user', recursive: true, reqId: 6000 }));
let listRes = null;
const t0 = Date.now();
while (Date.now() - t0 < 8_000) {
  listRes = messages.find(m => m.reqId === 6000 && m.type === 'fs-list-result');
  if (listRes) break;
  await sleep(40);
}
a.check('fs-list recursive (palette source) still works',
  listRes && Array.isArray(listRes.entries),
  `result=${JSON.stringify(listRes)}`);

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
