#!/usr/bin/env bun
// wasi/clock — clock_time_get(CLOCK_REALTIME=0, precision=0, out=8) must
// return errno=0 (ESUCCESS). Fixture writes ('0' + errno) + '\n', so a
// successful call produces "0\n".

import { openWasiProbe, tailLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/clock', { dir: '/home/user/wasi', fixture: 'clock', as: 'clock.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner clock.wasm _start', 30_000);
  const tail = tailLines(r.output, 6);
  const errnoZeroOk = /^\s*0\s*$/m.test(tail);

  probe.report([
    ['clock_time_get returns errno 0', errnoZeroOk],
  ], { tail, errnoZeroOk });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
