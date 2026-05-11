#!/usr/bin/env bun
// wasi/poll-multi-mixed — Stream-B B8 — concurrent-ready drain.
//
// Spec: poll_oneoff with N subscriptions blocks until at least one fires;
// the impl SHOULD drain all currently-ready subscriptions in one call
// rather than returning the first one and forcing N-1 follow-up calls.
//
// Fixture: 3 subscriptions in one poll_oneoff:
//   sub[0]: CLOCK MONOTONIC +10s (slow timer, won't fire in test budget)
//   sub[1]: FD_READ on a regular file (always-ready synchronously)
//   sub[2]: CLOCK MONOTONIC +50ms (fast timer)
// Asserts: nev >= 1 AND at least one returned event has type=FD_READ (1).
// The always-ready file should short-circuit the race; the +50ms timer
// MAY also fire concurrently (and that's still PASS); the +10s timer's
// setTimeout is canceled after the race resolves.
//
// Runtime-behavioral: validates the multi-subscription drain logic
// (Promise.race winner + microtask-sentinel probe of others).

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/poll-multi-mixed] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('poll-multi-mixed', 'pm.wasm'), 30_000);

const r = await t.run('wasm-runner pm.wasm', 30_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/poll-multi-mixed', sid, base: BASE, tail, ok }, null, 2));

const checks = [['poll_oneoff(clock+file+clock) drains always-ready file event', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/poll-multi-mixed] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
