#!/usr/bin/env bun
// file-tree-fix/new/fs-request-queues-while-ws-pending — protocol-
// level repro of the race: send fs-* frames IMMEDIATELY upon WS
// open (no settle time), assert all resolve correctly with reqId
// echo.
//
// We can't drive the BROWSER race directly (page-load vs onopen)
// from a WS-only probe, but we CAN drive an analogous race by
// sending requests before/after a brief deliberate stall — and
// importantly we drive an HTML-source-level assertion that the
// queue + drain logic is present.

import WebSocket from 'ws';
import { mintSession, BASE, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-fix/new/fs-request-queues-while-ws-pending');
console.log(`file-tree-fix/new/fs-request-queues-while-ws-pending — ${process.env.BASE}`);

const sid = await mintSession();

// HTML wiring — both Editor and FileTree expose drainFsQueue.
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();
a.check('Editor exposes drainFsQueue in return-object',
  /return\s*\{\s*ensureLoaded[\s\S]{0,200}drainFsQueue\s*\}/.test(html),
  `Editor.drainFsQueue not exported`);
a.check('FileTree exposes drainFsQueue in return-object',
  /return\s*\{\s*ensureLoaded[\s\S]{0,150}drainFsQueue\s*\}/.test(html.split('return { ensureLoaded, tryHandleFsResult')[1] || ''),
  `FileTree.drainFsQueue not exported`);
a.check('ws.onopen drains Editor + FileTree queues',
  /ws\.onopen\s*=[\s\S]{0,500}Editor\.drainFsQueue\(\)/.test(html) &&
  /ws\.onopen\s*=[\s\S]{0,500}FileTree\.drainFsQueue\(\)/.test(html),
  `onopen drain wiring missing`);
a.check('fsRequest no longer rejects on WS-not-OPEN (queues instead)',
  /outQueue\.push\(frame\)/.test(html),
  `outQueue push logic missing`);
a.check('fsRequest still tries direct send when WS is OPEN',
  /ws\.readyState\s*===\s*WebSocket\.OPEN[\s\S]{0,200}ws\.send/.test(html),
  `fast-path send missing`);

// Protocol round-trip: open WS, immediately send 3 fs-* frames in
// rapid succession. Server should respond to ALL three with proper
// reqId echo.
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const messages = [];
ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
  setTimeout(() => rej(new Error('WS open timeout')), 15_000);
});

// Three back-to-back requests.
const path = '/home/user/race-probe-' + Date.now() + '.txt';
ws.send(JSON.stringify({ type: 'fs-write', reqId: 1001, path, content: 'race-OK' }));
ws.send(JSON.stringify({ type: 'fs-read',  reqId: 1002, path }));
ws.send(JSON.stringify({ type: 'fs-list',  reqId: 1003, dir: '/home/user', recursive: false }));

async function waitForReqId(reqId, type, timeoutMs = 8_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = messages.find(m => m.reqId === reqId && m.type === type);
    if (hit) return hit;
    await sleep(40);
  }
  return null;
}

const writeRes = await waitForReqId(1001, 'fs-write-result');
const readRes  = await waitForReqId(1002, 'fs-read-result');
const listRes  = await waitForReqId(1003, 'fs-list-result');

a.check('fs-write (reqId 1001) resolved', writeRes && writeRes.ok === true,
  `result=${JSON.stringify(writeRes)}`);
a.check('fs-read (reqId 1002) resolved with correct content',
  readRes && readRes.content === 'race-OK',
  `result=${JSON.stringify(readRes)}`);
a.check('fs-list (reqId 1003) resolved with entries',
  listRes && Array.isArray(listRes.entries) && listRes.entries.length > 0,
  `result=${JSON.stringify(listRes)}`);

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
