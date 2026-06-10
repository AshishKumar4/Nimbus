#!/usr/bin/env bun
// file-tree-watch/regression/file-tree-manual-refresh-still-works —
// the existing manual-refresh path (btnRefresh) and fs-list pipeline
// remain functional. We assert the underlying fs-list re-fetch works
// repeatedly, which is what btnRefresh does internally (refreshTree
// clears the nodes Map and calls ensureLoaded which calls loadFolder
// which calls fsRequest(fs-list)).

import { mintSession, Terminal, sleep, makeAsserter, BASE } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/regression/file-tree-manual-refresh-still-works');
console.log(`file-tree-watch/regression/file-tree-manual-refresh-still-works — ${BASE}`);

// A session permits exactly ONE terminal WebSocket (a second /ws gets a
// 409). The browser file tree therefore issues fs-list over the SAME
// shell socket it uses for terminal I/O (init.ts terminal.onFs handles
// fs-read/fs-write/fs-list on the shell-kind WS). Mirror that: drive the
// touch AND the fs-list re-fetches over one Terminal socket.
const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

const results = new Map();
t.ws.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (m.type === 'fs-list-result' && typeof m.reqId === 'number') results.set(m.reqId, m);
  } catch {}
});

async function fsList(reqId) {
  // Raw protocol frame over the shell socket — Terminal.send() would wrap
  // it in a {type:'input'} keystroke envelope, so write to the ws directly.
  t.ws.send(JSON.stringify({ type: 'fs-list', reqId, dir: '/home/user', recursive: false }));
  const t0 = Date.now();
  while (!results.has(reqId) && Date.now() - t0 < 5_000) await sleep(25);
  return results.get(reqId);
}

// Initial fs-list over the shell socket.
const first = await fsList(71_001);
a.check('initial fs-list returned', first !== undefined, '');
const firstCount = first ? first.entries.length : 0;

// Add a file via shell.
const fileName = 'manual-refresh-' + Math.random().toString(36).slice(2, 8) + '.txt';
await t.run(`touch /home/user/${fileName}`, 10_000);

// Manual refresh: re-issue fs-list (simulates btnRefresh).
const second = await fsList(71_002);
a.check('second fs-list returned', second !== undefined, '');
const secondCount = second ? second.entries.length : 0;
const secondEntries = second ? second.entries : [];

// The first shell command also lazily materialises ~/.bash_history, so
// the count can grow by more than one. The meaningful contract is that a
// re-issued fs-list reflects the new on-disk state: the touched file is
// now listed and the entry count grew.
a.check('manual refresh sees the newly-added file',
  secondCount > firstCount
  && secondEntries.some((e) => e.path.endsWith(fileName)),
  `firstCount=${firstCount} secondCount=${secondCount} sample=${JSON.stringify(secondEntries.slice(-3))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
