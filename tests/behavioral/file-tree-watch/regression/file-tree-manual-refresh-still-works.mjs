#!/usr/bin/env bun
// file-tree-watch/regression/file-tree-manual-refresh-still-works —
// the existing manual-refresh path (btnRefresh) and fs-list pipeline
// remain functional. We assert the underlying fs-list re-fetch works
// repeatedly, which is what btnRefresh does internally (refreshTree
// clears the nodes Map and calls ensureLoaded which calls loadFolder
// which calls fsRequest(fs-list)).

import { mintSession, Terminal, sleep, makeAsserter, BASE, WS_BASE } from '../../_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/regression/file-tree-manual-refresh-still-works');
console.log(`file-tree-watch/regression/file-tree-manual-refresh-still-works — ${BASE}`);

const sid = await mintSession();
const w = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const results = new Map();
let opened = false;
w.on('open', () => { opened = true; });
w.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (m.type === 'fs-list-result' && typeof m.reqId === 'number') {
      results.set(m.reqId, m);
    }
  } catch {}
});
{ const t0 = Date.now(); while (!opened && Date.now() - t0 < 10_000) await sleep(25); }

// Initial fs-list.
w.send(JSON.stringify({ type: 'fs-list', reqId: 71_001, dir: '/home/user', recursive: false }));
{ const t0 = Date.now(); while (!results.has(71_001) && Date.now() - t0 < 5_000) await sleep(25); }
a.check('initial fs-list returned', results.has(71_001), '');
const firstCount = results.get(71_001).entries.length;

// Add a file via shell.
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);
const fileName = 'manual-refresh-' + Math.random().toString(36).slice(2, 8) + '.txt';
await t.run(`touch /home/user/${fileName}`, 10_000);

// Manual refresh: re-issue fs-list (simulates btnRefresh).
w.send(JSON.stringify({ type: 'fs-list', reqId: 71_002, dir: '/home/user', recursive: false }));
{ const t0 = Date.now(); while (!results.has(71_002) && Date.now() - t0 < 5_000) await sleep(25); }
a.check('second fs-list returned', results.has(71_002), '');
const secondCount = results.get(71_002).entries.length;
const secondEntries = results.get(71_002).entries;

a.check('manual refresh sees the newly-added file',
  secondCount === firstCount + 1
  && secondEntries.some((e) => e.path.endsWith(fileName)),
  `firstCount=${firstCount} secondCount=${secondCount} sample=${JSON.stringify(secondEntries.slice(-3))}`);

await t.close();
try { w.close(); } catch {}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
