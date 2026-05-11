#!/usr/bin/env bun
// wasi/sock-shutdown-write — Stream-B B7 — sock_shutdown(SDFLAGS_WR).
//
// Spec: WASI preview1 sock_shutdown(fd, how). When how & SDFLAGS_WR(2)
// is set, close the writable half; subsequent sock_send returns EPIPE.
// Recv side remains open and the peer's echo data still arrives.
//
// Fixture: connect to tcpbin.com:4242, send "BYE\\n", shutdown WR,
// then recv loop (up to 8 iterations) accumulating bytes. Prints '1'
// if total bytes received > 0 (i.e., the server echoed back BEFORE
// closing), else '0'.
//
// Validates: (1) the WR-shutdown wrappers our impl provides actually
// half-close vs full-close, (2) the readable side still functions
// post-shutdown.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/sock-shutdown-write] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('sock-shutdown-write', 'ss.wasm'), 30_000);

const r = await t.run('wasm-runner ss.wasm', 90_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-8).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/sock-shutdown-write', sid, base: BASE, tail, ok }, null, 2));

const checks = [['shutdown(WR) + recv-loop receives nonzero bytes', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/sock-shutdown-write] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
