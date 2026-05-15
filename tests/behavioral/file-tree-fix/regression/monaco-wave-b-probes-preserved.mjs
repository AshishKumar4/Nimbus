#!/usr/bin/env bun
// file-tree-fix/regression/monaco-wave-b-probes-preserved —
// hotfix doesn't regress key Wave-B file-tree probes.
//
// We exercise the same protocol-level invariants the Wave-B probes
// assert: fs-write + fs-read round-trip, fs-list returns entries,
// reqId echo, FileTree DOM + JS hooks present.

import WebSocket from 'ws';
import { mintSession, BASE, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-fix/regression/monaco-wave-b-probes-preserved');
console.log(`file-tree-fix/regression/monaco-wave-b-probes-preserved — ${process.env.BASE}`);

const sid = await mintSession();

// HTML — Wave-B FileTree + Wave-A Editor surfaces intact.
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

a.check('FileTree IIFE module still declared',
  /const FileTree\s*=\s*\(function\(\)/.test(html),
  `FileTree module missing`);
a.check('FileTree.tryHandleFsResult hook still wired',
  /FileTree\.tryHandleFsResult\(msg\)/.test(html),
  `FileTree WS hook missing`);
a.check('panel-tree DOM still present',
  /id=["']treePanel["']/.test(html),
  `panel-tree DOM missing`);
a.check('btnEditor still single canonical mode',
  /id=["']btnEditor["'][^>]*>\s*Editor\s*</.test(html),
  `btnEditor missing or stale`);
a.check('Monaco config still has minimap enabled',
  /minimap:\s*\{[^}]*enabled:\s*true/.test(html),
  `Monaco config regressed`);
a.check('Monaco config still uses Menlo 14px',
  /fontFamily:\s*["']Menlo[^"']*Monaco/.test(html) && /fontSize:\s*14\b/.test(html),
  `font config regressed`);

// Protocol — round-trip fs-write → fs-read, fs-list.
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const messages = [];
ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(()=>rej('timeout'), 10_000); });

async function rtt(frame, expectedType, reqId, timeoutMs = 8_000) {
  ws.send(JSON.stringify({ ...frame, reqId }));
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = messages.find(m => m.reqId === reqId && m.type === expectedType);
    if (hit) return hit;
    await sleep(40);
  }
  return null;
}

const path = '/home/user/file-tree-fix-regress-' + Date.now() + '.txt';
const PAYLOAD = 'regression-OK';
const w = await rtt({ type: 'fs-write', path, content: PAYLOAD }, 'fs-write-result', 3001);
a.check('fs-write ok + reqId echo', w?.ok === true && w?.reqId === 3001, `result=${JSON.stringify(w)}`);

const rd = await rtt({ type: 'fs-read', path }, 'fs-read-result', 3002);
a.check('fs-read content + reqId echo',
  rd?.content === PAYLOAD && rd?.reqId === 3002,
  `result=${JSON.stringify(rd)}`);

const ls = await rtt({ type: 'fs-list', dir: '/home/user', recursive: false }, 'fs-list-result', 3003);
const found = (ls?.entries || []).some(e => e.path === path);
a.check('fs-list shows the new file + reqId echo',
  ls?.reqId === 3003 && found,
  `entries-tail=${JSON.stringify((ls?.entries || []).slice(-3))}`);

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
