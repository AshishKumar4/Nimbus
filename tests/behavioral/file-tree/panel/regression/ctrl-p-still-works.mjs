#!/usr/bin/env bun
// file-tree/panel/regression/ctrl-p-still-works — the recursive fs-list
// round-trip the Ctrl+P palette lists files with. The palette itself is
// driven in a real Chrome by editor/monaco/new/ctrl-p-opens-file and
// monaco-polish/regression/existing-monaco-probes-preserved.

import WebSocket from 'ws';
import { mintSession, WS_BASE, makeAsserter, sleep, wsHeaders } from '../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree/panel/regression/ctrl-p-still-works');
console.log(`file-tree/panel/regression/ctrl-p-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`, wsHeaders(sid));
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
