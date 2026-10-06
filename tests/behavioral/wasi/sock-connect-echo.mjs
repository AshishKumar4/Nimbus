#!/usr/bin/env bun
// wasi/sock-connect-echo — WASI socket and polling support B7 — TCP socket round-trip.
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
// service is down at probe time, this probe failing's — see
// alternate endpoints (gopher.floodgap.com:70 is a documented fallback).

import { openWasiProbe, tailLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/sock-connect-echo', { dir: '/home/user/sb', fixture: 'sock-connect-echo', as: 'sc.wasm' });
const { t } = probe;
try {
  // Sockets need extra time for handshake + echo. 90s budget covers
  // cold-start + DNS + TCP RTT + echo RTT.
  const r = await t.run('wasm-runner sc.wasm', 90_000);
  const tail = tailLines(r.output, 8);
  const ok = /PING/.test(tail);

  probe.report([['TCP echo via /dev/tcp/tcpbin.com/4242 round-trips "PING"', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
