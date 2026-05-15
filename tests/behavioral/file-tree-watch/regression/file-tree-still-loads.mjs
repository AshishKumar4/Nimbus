#!/usr/bin/env bun
// file-tree-watch/regression/file-tree-still-loads — fs-list still
// works (the FileTree's initial-load path).
//
// The wave is additive to the existing fs-list handler. This probe
// confirms fs-list responses still arrive correctly post-wave.

import { mintSession, Terminal, sleep, makeAsserter, BASE, WS_BASE } from '../../_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/regression/file-tree-still-loads');
console.log(`file-tree-watch/regression/file-tree-still-loads — ${BASE}`);

const sid = await mintSession();
const w = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
let opened = false;
let result = null;
w.on('open', () => { opened = true; });
w.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (m.type === 'fs-list-result') result = m;
  } catch {}
});
{ const t0 = Date.now(); while (!opened && Date.now() - t0 < 10_000) await sleep(25); }
a.check('WS opened', opened, '');
w.send(JSON.stringify({ type: 'fs-list', reqId: 70_001, dir: '/home/user', recursive: false }));
{ const t0 = Date.now(); while (!result && Date.now() - t0 < 5_000) await sleep(25); }
a.check('fs-list-result received', result !== null, '');
a.check('fs-list result has entries array',
  result && Array.isArray(result.entries),
  `result=${JSON.stringify(result).slice(0, 200)}`);
a.check('fs-list reports at least one entry under /home/user',
  result && result.entries.length > 0,
  `entryCount=${result?.entries?.length}`);
try { w.close(); } catch {}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
