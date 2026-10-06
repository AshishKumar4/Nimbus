#!/usr/bin/env bun
// wasi/fd-allocate — WASI socket and polling support B4 — fd_allocate extends file size.
//
// Spec: WASI preview1 fd_allocate(fd, offset, len) — preallocates space
// in [offset, offset+len). Equivalent of posix_fallocate(3). Our in-
// memory FS extends the file's Uint8Array (zero-fill is implicit).
//
// Fixture: creates "ext", calls fd_allocate(_, 0, 16), then fd_filestat_get
// and checks size == 16. Prints '1' on match. Pre-B4 returned ENOSYS → no
// size change → '0'.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/fd-allocate', { dir: '/home/user/sb', fixture: 'fd-allocate', as: 'all.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner all.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['fd_allocate(0, 16) extends file to 16 bytes', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
