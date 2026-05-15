#!/usr/bin/env bun
// monaco-wave-b/regression/fs-protocol-still-works — Wave-A hotfix
// reqId-echo preserved + all three fs-* messages.

import WebSocket from 'ws';
import { mintSession, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/regression/fs-protocol-still-works');
console.log(`monaco-wave-b/regression/fs-protocol-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const messages = [];
ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(()=>rej('timeout'), 10_000); });

async function rtt(frame, expectedType, reqId) {
  ws.send(JSON.stringify({ ...frame, reqId }));
  const t0 = Date.now();
  while (Date.now() - t0 < 8_000) {
    const hit = messages.find(m => m.reqId === reqId && m.type === expectedType);
    if (hit) return hit;
    await sleep(40);
  }
  return null;
}

// fs-write.
const path = '/home/user/wave-b-fs-' + Date.now() + '.txt';
const PAYLOAD = 'fs-protocol-still-works';
const w = await rtt({ type: 'fs-write', path, content: PAYLOAD }, 'fs-write-result', 5000);
a.check('fs-write ok + reqId echo', w?.ok === true && w?.reqId === 5000, `result=${JSON.stringify(w)}`);

// fs-read.
const rd = await rtt({ type: 'fs-read', path }, 'fs-read-result', 5001);
a.check('fs-read content + reqId echo',
  rd?.content === PAYLOAD && rd?.reqId === 5001,
  `expected=${PAYLOAD} got=${JSON.stringify(rd)}`);

// fs-list.
const ls = await rtt({ type: 'fs-list', dir: '/home/user', recursive: false }, 'fs-list-result', 5002);
const found = (ls?.entries || []).some(e => e.path === path);
a.check('fs-list entries + reqId echo + new file visible',
  ls?.reqId === 5002 && found,
  `entries-end=${JSON.stringify((ls?.entries || []).slice(-3))}`);

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
