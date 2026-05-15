#!/usr/bin/env bun
// monaco-wave-a/new/ctrl-s-saves-file — Ctrl+S save wiring +
// round-trip persistence.
//
// HTML/JS assertions verify the keybinding + save() function calls
// fs-write. Then the WS protocol level: write a sentinel via fs-write
// in session A, open a FRESH session B (same sid), read back via
// fs-read, content matches. This validates persistence across
// session reconnect.

import WebSocket from 'ws';
import { mintSession, BASE, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/new/ctrl-s-saves-file');
console.log(`monaco-wave-a/new/ctrl-s-saves-file — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// HTML/JS: Ctrl+S global handler + Monaco addCommand binding.
a.check('Ctrl+S global keydown handler present',
  /isCtrlS\s*=\s*\(e\.ctrlKey\s*\|\|\s*e\.metaKey\)\s*&&\s*e\.key\s*===\s*['"]s['"]/.test(html),
  `Ctrl+S keydown wiring missing`);
a.check('Monaco editor.addCommand(Ctrl+S) wired to save()',
  /addCommand\(window\.monaco\.KeyMod\.CtrlCmd\s*\|\s*window\.monaco\.KeyCode\.KeyS,\s*\(\)\s*=>\s*save\(\)\)/.test(html),
  `Monaco Ctrl+S binding missing`);
a.check('save() calls fs-write',
  /async function save[\s\S]{0,400}fsRequest\(\{[\s\S]{0,80}type:\s*['"]fs-write['"]/.test(html),
  `save → fs-write wiring missing`);

// Protocol-level round-trip.
const path = '/home/user/probe-ctrl-s-' + Date.now() + '.txt';
const PAYLOAD = 'ctrl-s-probe-' + Date.now() + '\nsecond line\n  indented';

async function withWs(fn) {
  const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
  const messages = [];
  ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString('utf8'))); } catch {} });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(()=>rej('timeout'), 10_000); });
  const send = (frame) => ws.send(JSON.stringify(frame));
  const wait = async (predicate, timeoutMs = 8_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = messages.find(predicate);
      if (hit) return hit;
      await sleep(40);
    }
    return null;
  };
  let result;
  try { result = await fn({ send, wait, messages }); } finally { ws.close(); }
  return result;
}

// Session-1: write the file.
{
  const res = await withWs(async ({ send, wait }) => {
    send({ type: 'fs-write', reqId: 1, path, content: PAYLOAD });
    return await wait(m => m.reqId === 1 && m.type === 'fs-write-result');
  });
  a.check('fs-write returns ok:true',
    res && res.ok === true,
    `result=${JSON.stringify(res)}`);
}

// Session-2: a brand-new WS connection on the SAME sid. The file
// must still be there (SqliteVFS-backed, not in-memory).
{
  const res = await withWs(async ({ send, wait }) => {
    send({ type: 'fs-read', reqId: 2, path });
    return await wait(m => m.reqId === 2 && m.type === 'fs-read-result');
  });
  a.check('fs-read on fresh WS connection returns same content',
    res && res.content === PAYLOAD,
    `expected=${JSON.stringify(PAYLOAD)} got=${JSON.stringify(res && res.content)}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
