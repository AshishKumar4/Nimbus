#!/usr/bin/env bun
// wasi-files/mkdir-readdir — path_create_directory + fd_readdir.
//
// Fixture creates "sub" dir, opens it with O_DIRECTORY, calls fd_readdir
// asking for 200 bytes, prints '0' + (bufused > 0 ? 1 : 0) + '\n'.
// Pass: stdout includes "1".
//
// Note: an empty directory still yields synthetic "." / ".." entries from
// most WASI impls, so bufused > 0 is expected.

import { openWasiProbe, tailLines, trimmedLines } from '../wasi/_harness.mjs';

const probe = await openWasiProbe('wasi-files/mkdir-readdir', { dir: '/home/user/w2', fixture: 'mkdir-readdir', as: 'mkr.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner mkr.wasm', 60_000);
  const tail = tailLines(r.output, 6);
  // '1' on its own line; not the prompt
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['path_create_directory + fd_readdir → bufused > 0', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
