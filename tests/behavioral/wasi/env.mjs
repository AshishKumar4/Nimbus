#!/usr/bin/env bun
// wasi/env — environ_sizes_get plumbing. Fixture writes the single byte
// ('0' + envc) + '\n'. Nimbus's session env grows over time as primitive
// waves add keys (PATH/HOME/USER/PWD/NIMBUS_SESSION_ID/PORT/HOST/...).
// envc=20 manifests as 'D' (= '0' + 20). The fixture is single-byte, so
// any printable ASCII byte > '0' indicates a non-zero envc — that's what
// we assert. The '0' character would mean envc=0 which is the only fail
// state we care about for this probe.

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/env', { dir: '/home/user/wasi', fixture: 'env', as: 'env.wasm' });
const { t } = probe;
try {
  const result = await t.run('wasm-runner env.wasm _start', 30_000);
  const tail = tailLines(result.output, 6);
  // envc > 0 → fixture writes '0' + envc as one byte. We look for a
  // line that is exactly ONE printable ASCII byte (not the shell prompt,
  // not the command echo). Nimbus's session env post primitives+heap
  // waves is ~20 keys → 'D'. We accept any single-char line that isn't
  // '0' (which would mean envc=0 → environ_sizes_get is broken).
  const lines = trimmedLines(tail);
  const oneByteLine = lines.find(s => s.length === 1 && /^[!-~]$/.test(s));
  const envcOk = !!oneByteLine;
  const notZeroEnvc = oneByteLine !== '0';

  probe.report([
    ['environ_sizes_get returned and last line is one printable byte', envcOk],
    ['envc != 0 (environ_sizes_get really populated something)',       notZeroEnvc],
  ], { tail, envcOk, notZeroEnvc });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
