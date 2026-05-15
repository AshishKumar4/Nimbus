#!/usr/bin/env bun
// monaco-wave-a/new/ctrl-p-opens-file — Ctrl+P palette wiring.
//
// We don't run a real browser; instead, we assert:
//   1. The keydown handler for Ctrl+P is wired at the document level.
//   2. The palette overlay + input + list DOM is present.
//   3. The openPalette() function calls fs-list with the user dir.
//   4. The fs-list WS message round-trips correctly (the protocol
//      backbone that Ctrl+P relies on at runtime).
//   5. Picking a result triggers openFile → fs-read.

import WebSocket from 'ws';
import { mintSession, BASE, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/new/ctrl-p-opens-file');
console.log(`monaco-wave-a/new/ctrl-p-opens-file — ${process.env.BASE}`);

const sid = await mintSession();

// Probe 1-3: HTML/JS source-level checks.
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

a.check('Ctrl+P global keydown handler present',
  /isCtrlP\s*=\s*\(e\.ctrlKey\s*\|\|\s*e\.metaKey\)\s*&&\s*e\.key\s*===\s*['"]p['"]/.test(html),
  `Ctrl+P keydown wiring missing`);

a.check('palette overlay DOM present',
  /id=["']paletteOverlay["']/.test(html) && /id=["']paletteInput["']/.test(html) && /id=["']paletteList["']/.test(html),
  `palette DOM incomplete`);

a.check("openPalette() calls fs-list on /home/user",
  /openPalette[\s\S]{0,400}fsRequest\(\{[\s\S]{0,80}type:\s*['"]fs-list['"][\s\S]{0,80}dir:\s*['"]\/home\/user['"]/.test(html),
  `openPalette → fs-list wiring missing`);

a.check('Enter key in palette → openFile()',
  /key\s*===\s*['"]Enter['"][\s\S]{0,200}openFile\(/.test(html),
  `Enter→openFile wiring missing`);

a.check('palette items click → openFile()',
  /palette-item['"][\s\S]{0,300}openFile\(/.test(html),
  `palette-item click→openFile wiring missing`);

// Probe 4-5: protocol-level — fs-list with reqId echoes correctly,
// then a follow-up fs-read on one of the entries succeeds.
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const messages = [];
ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(()=>rej('timeout'), 10_000); });

ws.send(JSON.stringify({ type: 'fs-list', dir: '/home/user', recursive: false, reqId: 901 }));
let listRes = null;
{
  const t0 = Date.now();
  while (Date.now() - t0 < 8_000) {
    listRes = messages.find(m => m.reqId === 901 && m.type === 'fs-list-result');
    if (listRes) break;
    await sleep(40);
  }
}
a.check('fs-list returns result with echoed reqId',
  listRes !== null && Array.isArray(listRes && listRes.entries),
  `messages=${JSON.stringify(messages.slice(-3))}`);

if (listRes && Array.isArray(listRes.entries)) {
  // Pick a file entry and fs-read it.
  const file = (listRes.entries || []).find(e => e.type === 'file');
  a.check('fs-list found at least one file entry',
    file !== undefined,
    `entries=${JSON.stringify(listRes.entries)}`);
  if (file) {
    ws.send(JSON.stringify({ type: 'fs-read', path: file.path, reqId: 902 }));
    let readRes = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 8_000) {
      readRes = messages.find(m => m.reqId === 902 && m.type === 'fs-read-result');
      if (readRes) break;
      await sleep(40);
    }
    a.check('fs-read on palette-picked file returns content (or binary marker)',
      readRes !== null && (readRes.content !== undefined || readRes.binary === true),
      `readRes=${JSON.stringify(readRes)}`);
  }
}

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
