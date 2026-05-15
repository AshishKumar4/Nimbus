#!/usr/bin/env bun
// monaco-wave-b/new/file-tree-folder-expands — folder click triggers
// lazy fs-list and the response shape supports per-folder rendering.
//
// We don't run a real browser; we exercise the underlying contract:
//   - fs-list non-recursive on /home/user returns at least one
//     directory entry (the starter project has app/, projects/, .config/)
//   - fs-list non-recursive on THAT subdirectory returns children
//   - The reqId echo (Wave-A hotfix) works for both calls

import WebSocket from 'ws';
import { mintSession, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/new/file-tree-folder-expands');
console.log(`monaco-wave-b/new/file-tree-folder-expands — ${process.env.BASE}`);

const sid = await mintSession();
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const messages = [];
ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(()=>rej('timeout'), 10_000); });

async function waitFor(reqId, type, timeoutMs = 8_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = messages.find(m => m.reqId === reqId && m.type === type);
    if (hit) return hit;
    await sleep(40);
  }
  return null;
}

// Probe 1: root listing returns entries (incl. at least one dir).
ws.send(JSON.stringify({ type: 'fs-list', dir: '/home/user', recursive: false, reqId: 9000 }));
const rootRes = await waitFor(9000, 'fs-list-result');
a.check('root fs-list returns entries array',
  rootRes && Array.isArray(rootRes.entries) && rootRes.entries.length > 0,
  `result=${JSON.stringify(rootRes)}`);
const dirEntry = (rootRes?.entries || []).find(e => e.type === 'directory');
a.check('root listing contains at least one directory',
  dirEntry !== undefined,
  `entries=${JSON.stringify(rootRes?.entries?.slice(0, 5))}`);

// Probe 2: subdir listing returns children (or empty array if dir is empty).
if (dirEntry) {
  ws.send(JSON.stringify({ type: 'fs-list', dir: dirEntry.path, recursive: false, reqId: 9001 }));
  const subRes = await waitFor(9001, 'fs-list-result');
  a.check('subdir fs-list returns valid result shape',
    subRes && Array.isArray(subRes.entries),
    `result=${JSON.stringify(subRes)}`);
  a.check('subdir reqId echoed correctly',
    subRes && subRes.reqId === 9001,
    `reqId=${subRes?.reqId}`);
}

// Probe 3: HTML wiring — clicking a folder triggers loadFolder().
const r = await fetch(`${process.env.BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();
a.check('handleNodeClick toggles expanded state for directories',
  /handleNodeClick[\s\S]{0,400}type\s*===\s*['"]directory['"][\s\S]{0,200}expanded\.add/.test(html) ||
  /handleNodeClick[\s\S]{0,400}directory[\s\S]{0,200}expanded/.test(html),
  `folder-click wiring missing`);
a.check('handleNodeClick lazy-loads folder children',
  /handleNodeClick[\s\S]{0,500}loadFolder/.test(html),
  `lazy loadFolder wiring missing`);

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
