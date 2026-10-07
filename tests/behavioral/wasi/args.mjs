#!/usr/bin/env bun
// wasi/args — args_sizes_get + args_get plumbing. Fixture writes
// ('0' + argc) + '\n' to fd 1. The first WASI arg is conventionally
// the program name; wasm-runner is responsible for setting argv up so
// the program sees its own filename as argv[0]. We don't pass extra
// args here, so argc should be 1 → output "1\n".

import { openWasiProbe, tailLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/args', { dir: '/home/user/wasi', fixture: 'args', as: 'args.wasm' });
const { t } = probe;
try {
  const result = await t.run('wasm-runner args.wasm _start', 30_000);
  const tail = tailLines(result.output, 6);
  const argcOk = /^\s*1\s*$/m.test(tail);

  probe.report([
    ['argc (no extra args) → "1"', argcOk],
  ], { tail, argcOk });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
