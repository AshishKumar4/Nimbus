#!/usr/bin/env bun
// monaco-wave-b/new/file-tree-file-opens — clicking a file row in
// the tree opens it in Monaco. We verify:
//   1. HTML wiring: handleNodeClick on a file → Editor.openFile.
//   2. Protocol round-trip: fs-read on a known file returns content.
//   3. Selection sync: Editor.openFile updates FileTree.setSelected.

import WebSocket from 'ws';
import { mintSession, BASE, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/new/file-tree-file-opens');
console.log(`monaco-wave-b/new/file-tree-file-opens — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// HTML wiring.
a.check('handleNodeClick for file type calls Editor.openFile',
  /handleNodeClick[\s\S]{0,1200}Editor\.openFile/.test(html),
  `wiring missing`);
a.check('Editor.openFile calls FileTree.setSelected',
  /FileTree\.setSelected\(path\)/.test(html),
  `selection sync wiring missing`);
a.check('Editor.openFile dirty-prompt before switching',
  /Unsaved changes in[\s\S]{0,200}save and switch[\s\S]{0,200}discard/.test(html),
  `dirty-prompt logic missing`);

// Protocol-level — fs-read on a known starter file.
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const messages = [];
ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(()=>rej('timeout'), 10_000); });

// First list root to find a file we can read.
ws.send(JSON.stringify({ type: 'fs-list', dir: '/home/user', recursive: false, reqId: 8000 }));
let listRes = null;
const tList = Date.now();
while (Date.now() - tList < 8_000) {
  listRes = messages.find(m => m.reqId === 8000 && m.type === 'fs-list-result');
  if (listRes) break;
  await sleep(40);
}
a.check('fs-list root succeeded',
  listRes && Array.isArray(listRes.entries),
  `result=${JSON.stringify(listRes)}`);

const file = (listRes?.entries || []).find(e => e.type === 'file');
if (file) {
  ws.send(JSON.stringify({ type: 'fs-read', path: file.path, reqId: 8001 }));
  let readRes = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 8_000) {
    readRes = messages.find(m => m.reqId === 8001 && m.type === 'fs-read-result');
    if (readRes) break;
    await sleep(40);
  }
  a.check('fs-read on tree-clicked file returns content (or binary marker)',
    readRes && (readRes.content !== undefined || readRes.binary === true),
    `result=${JSON.stringify(readRes)}`);
}

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
