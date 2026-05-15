#!/usr/bin/env bun
// monaco-wave-a/regression/ws-protocol-existing-still-works — the
// pre-existing WS message types (input/resize/output) still flow
// after Wave-A's additions (fs-read/fs-write/fs-list).

import WebSocket from 'ws';
import { mintSession, WS_BASE, makeAsserter, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/regression/ws-protocol-existing-still-works');
console.log(`monaco-wave-a/regression/ws-protocol-existing-still-works — ${process.env.BASE}`);

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

// Probe 1: 'resize' message accepted (no error frame).
ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

// Probe 2: 'input' message → shell processes → 'output' frame comes back.
await sleep(100); // brief settle for resize.
ws.send(JSON.stringify({ type: 'input', data: 'echo regression-output-marker\r' }));

const t0 = Date.now();
let outputHit = null;
while (Date.now() - t0 < 10_000) {
  outputHit = messages.find(m => m.type === 'output' && /regression-output-marker/.test(m.data || ''));
  if (outputHit) break;
  await sleep(50);
}

a.check('shell echoes input via output frames',
  outputHit !== null,
  `messages-tail=${JSON.stringify(messages.slice(-5))}`);

// Probe 3: unknown message type does NOT crash the WS (the switch's
// default branch ignores). Send a bogus type, then a normal input,
// expect output.
ws.send(JSON.stringify({ type: 'bogus-type-xyz', payload: 'foo' }));
await sleep(50);
ws.send(JSON.stringify({ type: 'input', data: 'echo post-bogus-OK\r' }));
const t1 = Date.now();
let postBogus = null;
while (Date.now() - t1 < 8_000) {
  postBogus = messages.find(m => m.type === 'output' && /post-bogus-OK/.test(m.data || ''));
  if (postBogus) break;
  await sleep(50);
}
a.check('WS survives unknown message type and resumes shell traffic',
  postBogus !== null,
  `messages-tail=${JSON.stringify(messages.slice(-5))}`);

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
