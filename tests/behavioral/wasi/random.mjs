#!/usr/bin/env bun
// wasi/random — random_get fills a buffer; fixture writes (buf[0] % 10) + '\n'.
// Probe asserts a single ASCII digit + newline appears.

import { openWasiProbe, tailLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/random', { dir: '/home/user/wasi', fixture: 'random', as: 'random.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner random.wasm _start', 30_000);
  const tail = tailLines(r.output, 6);
  const digitOk = /^\s*[0-9]\s*$/m.test(tail);

  probe.report([
    ['random_get → single digit on stdout', digitOk],
  ], { tail, digitOk });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
