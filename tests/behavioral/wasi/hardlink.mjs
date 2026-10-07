#!/usr/bin/env bun
// wasi/hardlink — WASI socket and polling support B3 — path_link creates a hardlink.
//
// Spec: WASI preview1 path_link(old_fd, old_flags, old_path, new_fd,
// new_path). Both names refer to the same on-disk inode (in our in-
// memory FS: the same Uint8Array reference).
//
// Fixture: writes 1-byte file "src" containing 'X', calls path_link to
// create "dst", then path_filestat_get("dst") expects size=1. Prints
// '1' on match.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/hardlink', { dir: '/home/user/sb', fixture: 'hardlink', as: 'hl.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner hl.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['path_link(src,dst) + stat(dst).size == 1', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
