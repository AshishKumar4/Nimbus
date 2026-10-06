#!/usr/bin/env bun
// wasi-files/path-write-read — full WASI write+read+close cycle.
//
// Fixture (439 B): opens hello.txt with O_CREAT, writes "write+read OK\n",
// closes; reopens RDONLY, reads it back, closes; echoes the readback to
// stdout. filesystem WASI fns exercised: path_open (twice), fd_close (twice).
//
// Pass: stdout includes "write+read OK".

import { openWasiProbe, tailLines } from '../wasi/_harness.mjs';

const probe = await openWasiProbe('wasi-files/path-write-read', { dir: '/home/user/w2', fixture: 'path-write-read', as: 'pwr.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner pwr.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const ok = /write\+read OK/.test(tail);

  probe.report([['path_open + fd_write + fd_close + path_open RDONLY + fd_read → "write+read OK"', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
