#!/usr/bin/env bun
// wasi/exit — proc_exit(7) must surface as wasm-runner exit code 7, NOT 0
// and NOT a crash. The wasm-runner shell handler maps proc_exit's
// thrown sentinel into the supervisor's exit-code path; the shell
// echoes `$?` if we run it after.

import { openWasiProbe, tailLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/exit', { dir: '/home/user/wasi', fixture: 'exit7', as: 'exit7.wasm' });
const { t } = probe;
try {
  // Run, then read $? via the shell `echo $?` convention.
  await t.run('wasm-runner exit7.wasm _start', 30_000);
  const ec = await t.run('echo "rc=$?"', 10_000);
  const tail = tailLines(ec.output, 5);
  const codeOk = /\brc=7\b/.test(tail);

  probe.report([
    ['proc_exit(7) → shell rc=7', codeOk],
  ], { tail, codeOk });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
