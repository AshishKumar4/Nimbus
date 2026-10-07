#!/usr/bin/env bun
// wasi/symlink-create-readlink — WASI socket and polling support B3 — round-trip a symlink.
//
// Spec:
//   path_symlink(old_path, fd, new_path) — creates a symlink at
//     fd/new_path whose stored target string is old_path (verbatim).
//   path_readlink(fd, path, buf, buf_len, *bufused) — reads the target
//     into buf (truncated to buf_len), writes byte count to *bufused.
//
// Fixture: creates symlink "b" → "target123" (9 bytes), readlinks it
// into a 16-byte buffer, writes (bufused-many bytes + "\\n") to stdout.
// Expected stdout line: "target123".
//
// Runtime-behavioral: pre-B3 path_symlink/readlink returned ENOSYS so
// any user program (git, npm linking node_modules/.bin/*) crashed.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/symlink-create-readlink', { dir: '/home/user/sb', fixture: 'symlink-create-readlink', as: 'sym.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner sym.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === 'target123');

  probe.report([['symlink+readlink round-trip "target123"', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
