#!/usr/bin/env bun
// behavioral/multi-tab — same-sid file visibility across WS reconnects.
//
// Black-box surfaces only. NO _diag.
//
// User-visible contract: a session URL (sid) is persistent. A user opens
// the URL in tab 1, writes a file, closes/refreshes/reopens (tab 2),
// and sees the file. That's the platform's "shareable URL" promise.
//
// Two SIMULTANEOUS terminals on the SAME sid are not: while one tab holds
// the terminal, a second terminal upgrade answers 409 (one owner at a
// time, session/routes.ts). Both contracts are asserted: the sequential
// one users rely on, and the refusal with the holder unharmed.

import { mintSession, Terminal, makeAsserter, sleep, wsHeaders, WS_BASE, hasOutputLine } from './_driver.mjs';
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

// One terminal owner at a time: while a tab holds a session's terminal, a
// second terminal socket on it is refused, and the holder keeps working.
{
  const sid2 = await mintSession();
  const holder = new Terminal(sid2);
  await holder.connect();
  await holder.waitForPrompt(60_000);
  const second = new WebSocket(`${WS_BASE}/s/${sid2}/ws`, wsHeaders(sid2));
  const outcome = await Promise.race([
    new Promise((resolve) => {
      second.once('open', () => resolve('opened'));
      second.once('error', (error) => resolve(`refused: ${error.message}`));
      second.once('close', (code) => resolve(`closed ${code}`));
    }),
    sleep(10_000).then(() => 'no answer in 10 s'),
  ]);
  second.terminate();
  a.check('a second terminal socket on a held session is refused', outcome.startsWith('refused'), outcome);
  const { output } = await holder.run('echo still-the-owner', 10_000);
  a.check('the holding tab keeps its terminal', hasOutputLine(output, 'still-the-owner'), JSON.stringify(output.slice(-200)));
  await holder.close();
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
