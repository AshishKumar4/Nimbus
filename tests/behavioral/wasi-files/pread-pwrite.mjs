#!/usr/bin/env bun
// wasi-files/pread-pwrite — offset-based I/O.
//
// Fixture:
//   - Create data.txt with "abcdefgh" (8 bytes).
//   - fd_pwrite "XY" @ offset 3 → file becomes "abcXYfgh".
//   - fd_pread 5 bytes @ offset 1 → should return "bcXYf".
//   - Echo to stdout + '\n'. Expected: "bcXYf\n".

import { openWasiProbe, tailLines } from '../wasi/_harness.mjs';

const probe = await openWasiProbe('wasi-files/pread-pwrite', { dir: '/home/user/w2', fixture: 'pread-pwrite', as: 'pp.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner pp.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const ok = /\bbcXYf\b/.test(tail);

  probe.report([['fd_pwrite @3 + fd_pread @1 len 5 → "bcXYf"', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
