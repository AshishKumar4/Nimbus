#!/usr/bin/env bun
// wasi/filestat-set-times-fd — WASI socket and polling support B2 — fd_filestat_set_times.
//
// Spec: WASI preview1 fd_filestat_set_times(fd, atim, mtim, fstflags).
// With fstflags = MTIM_NOW(8) | ATIM_NOW(2) = 10, the shim writes
// realtime clock into both. fd_filestat_get's mtim field at +48 of the
// statbuf must then be nonzero (was always 0n before WASI socket and polling support).
//
// Fixture: creates "tf.dat", calls fd_filestat_set_times(_, 0, 0, 10),
// reads back via fd_filestat_get, prints '1' if mtime > 0 else '0'.
//
// Runtime-behavioral: a user running `touch -m file.txt` from a WASI
// program would see this stat field; pre-B2 every touch was a silent
// no-op. Now mtime advances.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/filestat-set-times-fd', { dir: '/home/user/sb', fixture: 'fst-fd', as: 'fst.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner fst.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['fd_filestat_set_times(MTIM_NOW) → mtime > 0', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
