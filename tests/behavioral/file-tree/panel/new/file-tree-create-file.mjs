#!/usr/bin/env bun
// file-tree/panel/new/file-tree-create-file — the protocol the New File
// action creates with: an fs-write of empty content makes a file that
// fs-list then reports. The button itself (prompt, row, tab) is driven in
// a real Chrome by file-tree/panel/new/file-tree-renders.

import WebSocket from 'ws';
import { mintSession, WS_BASE, makeAsserter, sleep, wsHeaders } from '../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree/panel/new/file-tree-create-file');
console.log(`file-tree/panel/new/file-tree-create-file — ${process.env.BASE}`);

const sid = await mintSession();
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`, wsHeaders(sid));
const messages = [];
ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(()=>rej('timeout'), 10_000); });

const newPath = '/home/user/wave-b-new-file-' + Date.now() + '.txt';

// Write empty file.
ws.send(JSON.stringify({ type: 'fs-write', path: newPath, content: '', reqId: 7000 }));
let writeRes = null;
const tw = Date.now();
while (Date.now() - tw < 8_000) {
  writeRes = messages.find(m => m.reqId === 7000 && m.type === 'fs-write-result');
  if (writeRes) break;
  await sleep(40);
}
a.check('fs-write creates new empty file (ok:true)',
  writeRes && writeRes.ok === true,
  `result=${JSON.stringify(writeRes)}`);

// List root and verify the new file appears.
ws.send(JSON.stringify({ type: 'fs-list', dir: '/home/user', recursive: false, reqId: 7001 }));
let listRes = null;
const tl = Date.now();
while (Date.now() - tl < 8_000) {
  listRes = messages.find(m => m.reqId === 7001 && m.type === 'fs-list-result');
  if (listRes) break;
  await sleep(40);
}
const found = (listRes?.entries || []).some(e => e.path === newPath);
a.check('fs-list shows the newly-created file',
  found,
  `entries=${JSON.stringify((listRes?.entries || []).slice(-5))}`);

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
