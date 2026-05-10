#!/usr/bin/env bun
// behavioral/multi-tab — same-sid file visibility across WS reconnects.
//
// Black-box surfaces only. NO _diag.
//
// User-visible contract: a session URL (sid) is persistent. A user opens
// the URL in tab 1, writes a file, closes/refreshes/reopens (tab 2),
// and sees the file. That's the platform's "shareable URL" promise.
//
// Note: on the current platform, two SIMULTANEOUS WS clients on the
// SAME sid is gated (409-style) — the second connection gets refused
// with WS close 1002. That's a documented architectural choice (single
// owner per session at a time). The behavioral assertion below probes
// the SEQUENTIAL contract (tab 2 sees what tab 1 wrote after tab 1
// closes), which is what users actually do.

import { mintSession, Terminal, makeAsserter, sleep } from './_driver.mjs';
import WebSocket from 'ws';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('multi-tab');
console.log(`behavioral/multi-tab — same-sid sequential file visibility\nBASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

// Tab 1: connect, write, close.
const tab1 = new Terminal(sid);
await tab1.connect();
await sleep(2_000);
const stamp = Date.now().toString(36);
await tab1.run('mkdir -p /home/user/multi && cd /home/user/multi', 10_000);
await tab1.run(`echo "tab1-wrote-${stamp}" > /home/user/multi/shared.txt`, 10_000);
await tab1.close();

// Document the simultaneous-WS gate (informational; not gating).
{
  const sid2 = await mintSession();
  // Open WS A, then attempt WS B — observe close code 1002 if gated.
  const wsA = new WebSocket(process.env.BASE.replace(/^http/, 'ws') + `/s/${sid2}/ws`);
  await new Promise((res) => { wsA.on('open', res); wsA.on('error', () => res()); });
  await sleep(500);
  let secondClosed = false;
  let secondOpen = false;
  const wsB = new WebSocket(process.env.BASE.replace(/^http/, 'ws') + `/s/${sid2}/ws`);
  wsB.on('open', () => { secondOpen = true; });
  wsB.on('close', () => { secondClosed = true; });
  wsB.on('error', () => { /* eaten */ });
  await sleep(3_000);
  try { wsA.close(); } catch {}
  try { wsB.close(); } catch {}
  console.log(`  (info) simultaneous same-sid WS: secondOpen=${secondOpen} secondClosed=${secondClosed}`);
}

// Tab 2: connect (same sid as tab1), read.
const tab2 = new Terminal(sid);
await tab2.connect();
await sleep(2_500);
{
  const r = await tab2.run('cat /home/user/multi/shared.txt', 10_000);
  a.check('tab 2 (sequential reconnect) sees the file written by tab 1',
    new RegExp(`tab1-wrote-${stamp}`).test(r.output), r.output.slice(-200));
}

// Reverse: tab 2 writes, tab 1 (after reconnect) reads.
await tab2.run(`echo "tab2-wrote-${stamp}" > /home/user/multi/reverse.txt`, 10_000);
await tab2.close();

const tab1b = new Terminal(sid);
await tab1b.connect();
await sleep(2_000);
{
  const r = await tab1b.run('cat /home/user/multi/reverse.txt', 10_000);
  a.check('tab 1 (sequential reconnect) sees the file written by tab 2',
    new RegExp(`tab2-wrote-${stamp}`).test(r.output), r.output.slice(-200));
}
await tab1b.close();

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
