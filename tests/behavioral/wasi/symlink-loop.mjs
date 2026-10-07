#!/usr/bin/env bun
// wasi/symlink-loop — WASI socket and polling support B3 — ELOOP loop-detection.
//
// Spec: POSIX SYMLOOP_MAX. WASI preview1 defines ELOOP=32. When a path
// resolution chain exceeds SYMLOOP_MAX (our shim: 40 hops), path_open
// returns ELOOP.
//
// Fixture: creates self-symlink "a" → "a", then path_open("a", follow=on).
// The shim walks the symlink, sees the same path, walks again, ... after
// 40 iterations bails with ELOOP=32. The fixture prints '0' + (errno%10)
// + '\\n' = '2\\n'.
//
// Runtime-behavioral: pre-B3 path_open would either ENOSYS the symlink
// or (worse) infinite-loop. ELOOP is the spec-mandated response.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/symlink-loop', { dir: '/home/user/sb', fixture: 'symlink-loop', as: 'loop.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner loop.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  // ELOOP = 32 → last digit '2'.
  const ok = lines.some(s => s === '2');

  probe.report([['path_open self-symlink → ELOOP (errno 32)', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
