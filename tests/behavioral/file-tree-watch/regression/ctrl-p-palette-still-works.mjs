#!/usr/bin/env bun
// file-tree-watch/regression/ctrl-p-palette-still-works — the Cmd+P
// palette uses fs-list with recursive=true. Verify the recursive
// variant still works (covers the path our invalidateFileListCache
// hook needs to re-issue when called).

import { mintSession, sleep, makeAsserter, BASE, WS_BASE } from '../../_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/regression/ctrl-p-palette-still-works');
console.log(`file-tree-watch/regression/ctrl-p-palette-still-works — ${BASE}`);

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

// Recursive fs-list (the palette's call shape — public/s/index.html:955).
w.send(JSON.stringify({ type: 'fs-list', reqId: 72_001, dir: '/home/user', recursive: true }));
{ const t0 = Date.now(); while (!result && Date.now() - t0 < 8_000) await sleep(25); }
a.check('recursive fs-list-result received', result !== null, '');
a.check('palette fs-list returns entries',
  result && Array.isArray(result.entries) && result.entries.length > 0,
  `entryCount=${result?.entries?.length}`);
// Cmd+P filters out directories — confirm at least one file is present.
const files = (result?.entries || []).filter((e) => e.type !== 'directory');
a.check('palette fs-list returns at least one file (non-dir)',
  files.length > 0,
  `fileCount=${files.length}`);

try { w.close(); } catch {}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
