#!/usr/bin/env bun
// wasi/fdstat-rights-no-widen — WASI socket and polling support B6 — rights can only narrow.
//
// Spec: POSIX capability model — rights are monotonically-decreasing
// once set. Attempting to widen via fd_fdstat_set_rights must return
// ENOTCAPABLE (errno 76). Our shim enforces this via a bitmask check:
//   (new_rb & ~cur_rb) !== 0n   → reject
//
// Fixture: opens "rw.dat", narrows to rb=7, ri=7, then attempts to
// widen to rb=~0, ri=~0. Expects errno 76 = ENOTCAPABLE. Prints
// '0' + (errno%10) + '\\n' = '6\\n'.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/fdstat-rights-no-widen', { dir: '/home/user/sb', fixture: 'fdstat-rights-no-widen', as: 'fsr2.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner fsr2.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  // ENOTCAPABLE = 76; last digit '6'.
  const ok = lines.some(s => s === '6');

  probe.report([['set_rights widen attempt → ENOTCAPABLE (errno 76)', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
