#!/usr/bin/env bun
// monaco-wave-b/regression/ctrl-s-still-works — Wave-A Ctrl+S save.

import WebSocket from 'ws';
import { mintSession, BASE, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/regression/ctrl-s-still-works');
console.log(`monaco-wave-b/regression/ctrl-s-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

a.check('Ctrl+S global keydown handler present',
  /isCtrlS\s*=\s*\(e\.ctrlKey\s*\|\|\s*e\.metaKey\)\s*&&\s*e\.key\s*===\s*['"]s['"]/.test(html),
  `wiring missing`);
a.check('Monaco addCommand(Ctrl+S) wired to save()',
  /addCommand\(window\.monaco\.KeyMod\.CtrlCmd\s*\|\s*window\.monaco\.KeyCode\.KeyS,\s*\(\)\s*=>\s*save\(\)\)/.test(html),
  `Monaco binding missing`);

// Round-trip: fs-write then fs-read in fresh WS.
const path = '/home/user/wave-b-ctrl-s-' + Date.now() + '.txt';
const PAYLOAD = 'wave-b-ctrl-s-' + Date.now();

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
  try { result = await fn({ send, wait }); } finally { ws.close(); }
  return result;
}

// Write.
{
  const res = await withWs(async ({ send, wait }) => {
    send({ type: 'fs-write', reqId: 1, path, content: PAYLOAD });
    return await wait(m => m.reqId === 1 && m.type === 'fs-write-result');
  });
  a.check('fs-write returns ok:true', res && res.ok === true, `result=${JSON.stringify(res)}`);
}
// Read back on FRESH ws.
{
  const res = await withWs(async ({ send, wait }) => {
    send({ type: 'fs-read', reqId: 2, path });
    return await wait(m => m.reqId === 2 && m.type === 'fs-read-result');
  });
  a.check('fs-read on fresh WS returns same content',
    res && res.content === PAYLOAD,
    `expected=${JSON.stringify(PAYLOAD)} got=${JSON.stringify(res?.content)}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
