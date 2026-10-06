#!/usr/bin/env bun
// wasi/fdstat-set-rights — WASI socket and polling support B6 — capability tightening round-trip.
//
// Spec: WASI preview1 fd_fdstat_set_rights(fd, rights_base,
// rights_inheriting). Narrows the per-fd rights mask. fd_fdstat_get
// reads the active mask back at statbuf+8 (rights_base) and +16
// (rights_inheriting).
//
// Fixture: opens "r.dat", narrows to rb=7, ri=3, reads back via
// fd_fdstat_get, prints '1' if BOTH match exactly. Pre-B6 the shim
// returned a hardcoded 0x3FFFFFFF mask regardless of narrowing → '0'.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/fdstat-set-rights', { dir: '/home/user/sb', fixture: 'fdstat-set-rights', as: 'fsr.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner fsr.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['set_rights(7,3) round-trips through fdstat_get', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
