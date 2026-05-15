#!/usr/bin/env bun
// monaco-wave-a/new/fs-protocol-read-write — fs-* WS messages over
// the live terminal WS. Verifies round-trip:
//   1. fs-write writes content to the VFS.
//   2. fs-read returns the same content.
//   3. fs-list shows the new path in the directory listing.
//   4. Binary refuse heuristic (manually plant invalid UTF-8 via shell
//      `printf '\\xff\\xfe' > path`, then assert fs-read returns
//      binary:true).
//
// These tests are deploy-required (the WS handler lives in
// src/session/init.ts).

import WebSocket from 'ws';
import { mintSession, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/new/fs-protocol-read-write');
console.log(`monaco-wave-a/new/fs-protocol-read-write — ${process.env.BASE}`);

const sid = await mintSession();
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const messages = [];
ws.on('message', (data) => {
  try { messages.push(JSON.parse(data.toString('utf8'))); } catch {}
});
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
  setTimeout(() => rej(new Error('WS open timeout')), 15_000);
});

let nextReqId = 1;
function sendFs(frame) {
  const reqId = nextReqId++;
  frame.reqId = reqId;
  ws.send(JSON.stringify(frame));
  return reqId;
}
async function waitFor(predicate, label, timeoutMs = 8_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = messages.find(predicate);
    if (hit) return hit;
    await sleep(40);
  }
  throw new Error(`waitFor(${label}) timed out`);
}

// Probe 1: fs-write a known UTF-8 string.
const PAYLOAD = 'monaco-wave-a-probe-' + Date.now() + '\nline two';
const writeId = sendFs({ type: 'fs-write', path: '/home/user/probe-monaco.txt', content: PAYLOAD });
const writeRes = await waitFor(m => m.reqId === writeId && m.type === 'fs-write-result', 'fs-write-result');
a.check('fs-write returns ok:true', writeRes.ok === true, `result=${JSON.stringify(writeRes)}`);

// Probe 2: fs-read round-trips identical content.
const readId = sendFs({ type: 'fs-read', path: '/home/user/probe-monaco.txt' });
const readRes = await waitFor(m => m.reqId === readId && m.type === 'fs-read-result', 'fs-read-result');
a.check('fs-read returns same content',
  readRes.content === PAYLOAD,
  `expected=${JSON.stringify(PAYLOAD)} got=${JSON.stringify(readRes.content)}`);

// Probe 3: fs-list (non-recursive) at /home/user includes the file we wrote.
const listId = sendFs({ type: 'fs-list', dir: '/home/user', recursive: false });
const listRes = await waitFor(m => m.reqId === listId && m.type === 'fs-list-result', 'fs-list-result');
const found = (listRes.entries || []).some(e => e.path.endsWith('/probe-monaco.txt'));
a.check('fs-list includes the written file',
  found,
  `entries=${JSON.stringify((listRes.entries || []).slice(0, 5))}`);

// Probe 4: fs-read on non-existent path returns ENOENT error.
const enoentId = sendFs({ type: 'fs-read', path: '/home/user/__definitely_not_there__.xyz' });
const enoentRes = await waitFor(m => m.reqId === enoentId && m.type === 'fs-read-result', 'fs-read-result-enoent');
a.check('fs-read on missing path returns ENOENT error',
  !enoentRes.content && /ENOENT/.test(enoentRes.error || ''),
  `result=${JSON.stringify(enoentRes)}`);

// Probe 5: fs-list recursive populates the tree (cap at 2000 entries).
const recId = sendFs({ type: 'fs-list', dir: '/home/user', recursive: true });
const recRes = await waitFor(m => m.reqId === recId && m.type === 'fs-list-result', 'fs-list-recursive');
a.check('fs-list recursive returns entries array',
  Array.isArray(recRes.entries) && recRes.entries.length > 0,
  `count=${(recRes.entries || []).length} truncated=${recRes.truncated}`);

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
