#!/usr/bin/env bun
// file-tree-fix/new/file-tree-loads-after-ws-ready — happy path
// regression. When WS is already OPEN, fsRequest takes the fast
// path (direct send) and the tree loads instantly.
//
// Protocol-level: send fs-list AFTER WS is open + receive result.

import WebSocket from 'ws';
import { mintSession, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-fix/new/file-tree-loads-after-ws-ready');
console.log(`file-tree-fix/new/file-tree-loads-after-ws-ready — ${process.env.BASE}`);

const sid = await mintSession();
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const messages = [];
ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
  setTimeout(() => rej(new Error('WS open timeout')), 15_000);
});
// Wait for the cold-start ready frame so the DO is fully attached.
const t0 = Date.now();
while (Date.now() - t0 < 5_000) {
  if (messages.some(m => m.type === 'ready')) break;
  await sleep(50);
}
a.check('cold-start ready frame received',
  messages.some(m => m.type === 'ready'),
  `messages-head=${JSON.stringify(messages.slice(0, 3))}`);

// fs-list now should respond promptly (post-open fast path).
const startedAt = Date.now();
ws.send(JSON.stringify({ type: 'fs-list', dir: '/home/user', recursive: false, reqId: 4000 }));
let res = null;
while (Date.now() - startedAt < 3_000) {
  res = messages.find(m => m.reqId === 4000 && m.type === 'fs-list-result');
  if (res) break;
  await sleep(30);
}
const elapsed = Date.now() - startedAt;
a.check('fs-list after WS-open resolves within 3s',
  res !== null,
  `elapsed=${elapsed}ms result=${JSON.stringify(res)}`);
a.check('fs-list result has entries',
  res && Array.isArray(res.entries) && res.entries.length > 0,
  `result=${JSON.stringify(res)}`);

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
