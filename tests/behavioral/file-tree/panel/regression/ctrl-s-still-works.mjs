#!/usr/bin/env bun
// file-tree/panel/regression/ctrl-s-still-works — the fs-write the
// editor's Ctrl+S saves with lands, and a fresh socket reads it back.
// Ctrl+S itself is driven in a real Chrome by editor/monaco/new/
// ctrl-s-saves-file and monaco-polish/regression/existing-monaco-probes-
// preserved.

import WebSocket from 'ws';
import { mintSession, WS_BASE, makeAsserter, sleep, wsHeaders } from '../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree/panel/regression/ctrl-s-still-works');
console.log(`file-tree/panel/regression/ctrl-s-still-works — ${process.env.BASE}`);

const sid = await mintSession();
// Round-trip: fs-write then fs-read in fresh WS.
const path = '/home/user/wave-b-ctrl-s-' + Date.now() + '.txt';
const PAYLOAD = 'wave-b-ctrl-s-' + Date.now();

async function withWs(fn) {
  const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`, wsHeaders(sid));
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
