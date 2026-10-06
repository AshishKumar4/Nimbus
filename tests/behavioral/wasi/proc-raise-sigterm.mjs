#!/usr/bin/env bun
// wasi/proc-raise-sigterm — WASI socket and polling support B5 — proc_raise(SIGTERM=15) → 143.
//
// Spec: POSIX convention exit = 128 + signo. SIGTERM=15 → 143. Sibling
// probe to proc-raise-sigabrt: validates the encoding holds for multiple
// signals (not hardcoded for SIGABRT).

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/proc-raise-sigterm', { dir: '/home/user/sb', fixture: 'proc-raise-sigterm', as: 'prt.wasm' });
const { t } = probe;
try {
  await t.run('wasm-runner prt.wasm', 60_000);
  const r = await t.run('echo $?', 10_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '143');

  probe.report([['proc_raise(SIGTERM=15) → exit code 143', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
