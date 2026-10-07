#!/usr/bin/env bun
// wasi/poll-socket-read-ready — WASI socket and polling support B8 — async socket-fd readiness.
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

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/poll-socket-read-ready', { dir: '/home/user/sb', fixture: 'poll-socket-read-ready', as: 'ps.wasm' });
const { t } = probe;
try {
  // Socket needs handshake + round-trip; 90s budget like the B7 probes.
  const r = await t.run('wasm-runner ps.wasm', 90_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['poll_oneoff(FD_READ on socket) fires when echo arrives', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
