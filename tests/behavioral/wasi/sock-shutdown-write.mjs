#!/usr/bin/env bun
// wasi/sock-shutdown-write — WASI socket and polling support B7 — sock_shutdown(SDFLAGS_WR).
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

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/sock-shutdown-write', { dir: '/home/user/sb', fixture: 'sock-shutdown-write', as: 'ss.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner ss.wasm', 90_000);
  const tail = tailLines(r.output, 8);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['shutdown(WR) + recv-loop receives nonzero bytes', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
