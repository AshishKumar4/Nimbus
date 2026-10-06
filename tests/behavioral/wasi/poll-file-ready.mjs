#!/usr/bin/env bun
// wasi/poll-file-ready — WASI socket and polling support B8 — FD_READ on regular file is always-ready.
//
// Spec: WASI preview1 poll_oneoff with subscription tag EVENTTYPE_FD_READ=1
// on a regular file fd. POSIX: regular files never block on read; the
// event must fire immediately with type=FD_READ.
//
// Fixture: creates "p.dat", subscribes to FD_READ on its fd, asserts
// poll returns nev=1 AND event.type==1.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/poll-file-ready', { dir: '/home/user/sb', fixture: 'poll-file-ready', as: 'pf.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner pf.wasm', 30_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['poll_oneoff(FD_READ on regular file) → nev=1, type=FD_READ', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
