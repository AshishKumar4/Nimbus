#!/usr/bin/env bun
// wasi/symlink-follow-open — WASI socket and polling support B3 — symlink follow on path_open.
//
// Spec: dirflags & LOOKUPFLAGS_SYMLINK_FOLLOW (bit 1) makes path_open
// dereference symlinks transparently. The authority codec hands the flag to
// the filesystem, whose path resolution walks the chain (bounded by
// SYMLOOP_MAX) and opens the final non-symlink target.
//
// Fixture: writes "real.txt" containing "OK\\n", creates symlink "lnk"
// → "real.txt", opens "lnk" with follow=on, reads 3 bytes, echoes them
// to stdout. Expected: "OK\\n" in output.

import { openWasiProbe, tailLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/symlink-follow-open', { dir: '/home/user/sb', fixture: 'symlink-follow-open', as: 'sfo.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner sfo.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const ok = /OK/.test(tail);

  probe.report([['path_open(follow) on symlink reads target contents', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
