#!/usr/bin/env bun
// behavioral/session-scrollback-replay-once — a terminal that reconnects is
// shown the session's history, and the history is not stored again: after
// three reconnects a line printed once is replayed once (SES-5). Black-box:
// the terminal's own replay on each reconnect.
//
// Red before: the replay went through the terminal's ordinary write, whose
// flush tees into the scrollback, so every reconnect stored another copy and
// the next one replayed both.

import { mintSession, Terminal, makeAsserter } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('session-scrollback-replay-once');
console.log(`behavioral/session-scrollback-replay-once\nBASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const marker = `replay-once-${Date.now().toString(36)}`;
// The line as the command prints it, not as it is typed: the typed command
// spells it with a quote between its halves.
const printed = new RegExp(`(^|\\n)${marker}\\r?\\n`, 'g');
const t1 = new Terminal(sid);
await t1.connect();
await t1.waitForPrompt(60_000);
await t1.run(`echo replay-once-''${marker.slice('replay-once-'.length)}`, 10_000);
await t1.close();

for (let reconnect = 1; reconnect <= 3; reconnect++) {
  const t = new Terminal(sid);
  await t.connect();
  // A rejoin replays the history before it announces the prompt.
  await t.waitForPrompt(30_000);
  const seen = t.buf.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').match(printed)?.length ?? 0;
  a.check(`reconnect ${reconnect} replays the printed line once`, seen === 1, `seen ${seen}; tail: ${JSON.stringify(t.buf.slice(-400))}`);
  await t.close();
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
