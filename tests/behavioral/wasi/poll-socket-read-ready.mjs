#!/usr/bin/env bun
// wasi/poll-socket-read-ready — Stream-B B8 — async socket-fd readiness.
//
// Spec: WASI preview1 poll_oneoff(FD_READ on socket fd) blocks until
// data is available, returns nev=1 with event.type=FD_READ.
//
// Fixture: open /dev/tcp/tcpbin.com/4242, send "GO\\n", then poll
// FD_READ on the socket fd. The echo arrives → readable side becomes
// ready → poll returns nev=1, type=1. Asserts stdout '1'.
//
// This is the END-TO-END proof that B8 + JSPI Suspending + the
// stash-into-readBuf bridging between poll and sock_recv all work.
// Pre-P4 there was no way to poll a socket.
//
// External dep: tcpbin.com:4242 (same as B7 socket probes).

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/poll-socket-read-ready] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('poll-socket-read-ready', 'ps.wasm'), 30_000);

// Socket needs handshake + round-trip; 90s budget like the B7 probes.
const r = await t.run('wasm-runner ps.wasm', 90_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-6).join('\n');
const lines = tail.split(/\r?\n/).map(s => s.trim());
const ok = lines.some(s => s === '1');

await t.close();

console.log(JSON.stringify({ probe: 'wasi/poll-socket-read-ready', sid, base: BASE, tail, ok }, null, 2));

const checks = [['poll_oneoff(FD_READ on socket) fires when echo arrives', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/poll-socket-read-ready] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
