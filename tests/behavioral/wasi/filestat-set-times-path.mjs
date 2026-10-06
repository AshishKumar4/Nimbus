#!/usr/bin/env bun
// wasi/filestat-set-times-path — WASI socket and polling support B2 — path_filestat_set_times.
//
// Spec: WASI preview1 path_filestat_set_times(fd, lookupflags, path,
// path_len, atim, mtim, fstflags). With fstflags = MTIM_NOW(8) the shim
// writes realtime into mtime; path_filestat_get's mtim field at +48
// must be nonzero (was always 0n before WASI socket and polling support).
//
// Fixture: creates "tf2.dat", calls path_filestat_set_times(_, 1, …, 8),
// reads back via path_filestat_get, prints '1' if mtime > 0 else '0'.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/filestat-set-times-path', { dir: '/home/user/sb', fixture: 'fst-path', as: 'fst-p.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner fst-p.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['path_filestat_set_times(MTIM_NOW) → mtime > 0', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
