#!/usr/bin/env bun
// wasi/sock-connect-echo — Stream-B B7 — TCP socket round-trip.
//
// Spec: WASI preview1 sock_send + sock_recv. Nimbus extension: path_open
// detects '/dev/tcp/<host>/<port>' as a TCP socket request, delegates to
// cloudflare:sockets connect(). The async send/recv calls are wrapped in
// WebAssembly.Suspending so the wasm caller's sync-shape import survives
// JS Promise await.
//
// Fixture: connects to tcpbin.com:4242 (public TCP echo server per
// https://tcpbin.com), sends "PING\\n", reads bytes back, writes them
// to stdout. Expected: stdout contains "PING".
//
// Runtime-behavioral: end-to-end real TCP round-trip on prod. Pre-B7
// sock_send/sock_recv returned ENOSYS so any user program using sockets
// would fail at the syscall boundary. This probe is the canonical proof
// that B7 + JSPI + cloudflare:sockets are wired correctly.
//
// External dependency: tcpbin.com:4242 must be reachable. If the
// service is down at probe time, this probe RED's — see
// /workspace/.seal-internal/2026-05-11-stream-b/p3-spike.md §3 for
// alternate endpoints (gopher.floodgap.com:70 is a documented fallback).

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/sock-connect-echo] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
await t.run(writeStreamBFixtureCmd('sock-connect-echo', 'sc.wasm'), 30_000);

// Sockets need extra time for handshake + echo. 90s budget covers
// cold-start + DNS + TCP RTT + echo RTT.
const r = await t.run('wasm-runner sc.wasm', 90_000);
const out = stripAnsi(r.output);
const tail = out.split(/\r?\n/).slice(-8).join('\n');
const ok = /PING/.test(tail);

await t.close();

console.log(JSON.stringify({ probe: 'wasi/sock-connect-echo', sid, base: BASE, tail, ok }, null, 2));

const checks = [['TCP echo via /dev/tcp/tcpbin.com/4242 round-trips "PING"', ok]];
let pass = 0;
for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[wasi/sock-connect-echo] ${verdict} — ${pass}/${checks.length}`);
process.exit(verdict === 'GREEN' ? 0 : 1);
