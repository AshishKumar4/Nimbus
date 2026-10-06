#!/usr/bin/env bun
// wasi/proc-raise-sigabrt — WASI socket and polling support B5 — proc_raise encodes 128+sig.
//
// Spec: POSIX shell convention encodes a signal-terminated process as
// exit-status (128 + signo). SIGABRT = 6 → 134. WASI preview1 doesn't
// formalize this but our shim follows the bash/sh convention so users
// can distinguish signal-driven exit from regular non-zero exit.
//
// Fixture: calls proc_raise(6). Shim throws __WasiExit(134). The shell
// reports the exit code on the prompt line as a number, OR via the
// wasm-runner's stderr framing — we check both via the terminal's
// next prompt line / stderr.
//
// Runtime-behavioral: pre-B5 proc_raise(any sig) → exit 128 (no
// signal info). Modern wasi-libc's abort()→raise(SIGABRT) chain now
// surfaces the right status to the shell.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/proc-raise-sigabrt', { dir: '/home/user/sb', fixture: 'proc-raise-sigabrt', as: 'pra.wasm' });
const { t } = probe;
try {
  // Run wasm-runner; then `echo $?` to capture exit code on the shell.
  await t.run('wasm-runner pra.wasm', 60_000);
  const r = await t.run('echo $?', 10_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '134');

  probe.report([['proc_raise(SIGABRT=6) → exit code 134', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
