#!/usr/bin/env bun
// wasi-files/filestat — path_filestat_get.
//
// Fixture creates data.bin with 13 bytes ("hello, world!"), then calls
// path_filestat_get and prints ('0' + (size%10)) + '\n'. With size=13,
// expected stdout = "3\n".

import { openWasiProbe, tailLines, trimmedLines } from '../wasi/_harness.mjs';

const probe = await openWasiProbe('wasi-files/filestat', { dir: '/home/user/w2', fixture: 'filestat', as: 'fs.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner fs.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '3');

  probe.report([['path_filestat_get returns size=13 (mod 10 = 3)', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
