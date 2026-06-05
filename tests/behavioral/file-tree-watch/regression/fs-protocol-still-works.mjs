#!/usr/bin/env bun
// file-tree-watch/regression/fs-protocol-still-works — fs-read /
// fs-write / fs-list round-trip still works through the existing
// init.ts handler. Wave is additive; this is a guardrail.

import { mintSession, sleep, makeAsserter, BASE, WS_BASE } from '../../_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/regression/fs-protocol-still-works');
console.log(`file-tree-watch/regression/fs-protocol-still-works — ${BASE}`);

const sid = await mintSession();
const w = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const responses = new Map();
let opened = false;
w.on('open', () => { opened = true; });
w.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (typeof m.reqId === 'number' && typeof m.type === 'string' && m.type.endsWith('-result')) {
      responses.set(m.reqId, m);
    }
  } catch {}
});
{ const t0 = Date.now(); while (!opened && Date.now() - t0 < 10_000) await sleep(25); }

// fs-write
const path = '/home/user/fs-protocol-' + Math.random().toString(36).slice(2, 8) + '.txt';
const content = 'hello fs-protocol-still-works';
w.send(JSON.stringify({ type: 'fs-write', reqId: 73_001, path, content }));
{ const t0 = Date.now(); while (!responses.has(73_001) && Date.now() - t0 < 5_000) await sleep(25); }
const wr = responses.get(73_001);
a.check('fs-write succeeded', wr && wr.ok === true, `wr=${JSON.stringify(wr)}`);

// fs-read
w.send(JSON.stringify({ type: 'fs-read', reqId: 73_002, path }));
{ const t0 = Date.now(); while (!responses.has(73_002) && Date.now() - t0 < 5_000) await sleep(25); }
const rd = responses.get(73_002);
a.check('fs-read returns content',
  rd && rd.content === content,
  `rd=${JSON.stringify(rd).slice(0, 200)}`);

// fs-list
w.send(JSON.stringify({ type: 'fs-list', reqId: 73_003, dir: '/home/user', recursive: false }));
{ const t0 = Date.now(); while (!responses.has(73_003) && Date.now() - t0 < 5_000) await sleep(25); }
const ls = responses.get(73_003);
a.check('fs-list returns our file',
  ls && Array.isArray(ls.entries)
    && ls.entries.some((e) => e.path === path),
  `entries=${JSON.stringify(ls?.entries?.slice(-5))}`);

try { w.close(); } catch {}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
