#!/usr/bin/env bun
// monaco-wave-b/new/file-tree-create-file — New File toolbar action.
//
// HTML wiring + protocol round-trip:
//   1. btnTreeNewFile click handler bound to newFile() (which calls
//      prompt() for the name; we can't drive the prompt without a
//      real browser, so we exercise the underlying flow:
//      newFile → fs-write empty → re-fetch parent).
//   2. fs-write with an empty content body produces an actual entry
//      that fs-list afterwards reports.

import WebSocket from 'ws';
import { mintSession, BASE, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/new/file-tree-create-file');
console.log(`monaco-wave-b/new/file-tree-create-file — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// HTML wiring.
a.check('btnTreeNewFile click wired to newFile()',
  /btnNewFile\.addEventListener\(['"]click['"]\s*,\s*newFile\)/.test(html),
  `wiring missing`);
a.check('newFile() prompts user for name + calls fs-write',
  /async function newFile[\s\S]{0,400}prompt\([\s\S]{0,300}fs-write/.test(html),
  `newFile prompt+fs-write flow missing`);
a.check('newFile() refreshes parent folder after fs-write',
  /async function newFile[\s\S]{0,800}loadFolder/.test(html),
  `parent refresh wiring missing`);

// Protocol round-trip.
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
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
