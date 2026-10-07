#!/usr/bin/env bun
// wasi/poll-clock-timeout — WASI socket and polling support B8 — poll_oneoff CLOCK subscription.
//
// Spec: WASI preview1 poll_oneoff with subscription tag EVENTTYPE_CLOCK=0,
// clock id=MONOTONIC=1, relative timeout. Should block until the
// deadline, then return nevents=1 with event.type=EVENTTYPE_CLOCK=0.
//
// Fixture: subscribes to CLOCK_MONOTONIC at ~100ms relative. Asserts
// stdout '1' (poll returned nev=1 AND event.type==0).
//
// Runtime-behavioral: pre-B8 poll_oneoff returned ENOSYS so any
// sleep/select/poll based program failed at the syscall boundary. This
// probe validates the JSPI-wrapped setTimeout deadline path works on prod.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/poll-clock-timeout', { dir: '/home/user/sb', fixture: 'poll-clock-timeout', as: 'pc.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner pc.wasm', 30_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['poll_oneoff(CLOCK MONOTONIC +100ms) → nev=1, type=CLOCK', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
