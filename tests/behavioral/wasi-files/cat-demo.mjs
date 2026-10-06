#!/usr/bin/env bun
// wasi-files/cat-demo — the filesystem WASI end-to-end demo.
//
// Write hello.txt with known content via the user shell, then run
//   wasm-runner cat.wasm hello.txt
// and assert the wasm program echoes the file content. This is the
// "real WASI program reading real files from SqliteFS" proof point
// per the filesystem WASI scope re-frame (clang deferred to Wave-3).
//
// Fixture path length is hardcoded to 9 ('hello.txt'). The full path
// resolution exercise lives in path-write-read; this probe specifically
// validates argv-driven path_open + multi-block fd_read loop + fd_write
// to stdout.

import { openWasiProbe, tailLines } from '../wasi/_harness.mjs';

const CONTENTS = 'hello, world from cat.wasm running on Nimbus WASI filesystem WASI\n';

const probe = await openWasiProbe('wasi-files/cat-demo', { dir: '/home/user/w2', fixture: 'cat', as: 'cat.wasm' });
const { t } = probe;
try {
  // Write hello.txt via shell — supervisor VFS-visible.
  const b64 = Buffer.from(CONTENTS, 'utf8').toString('base64');
  await t.run(`node -e "require('fs').writeFileSync('hello.txt', Buffer.from('${b64}','base64'))"`, 30_000);

  const r = await t.run('wasm-runner cat.wasm hello.txt', 60_000);
  const tail = tailLines(r.output, 5);
  const ok = /hello, world from cat\.wasm/.test(tail);

  probe.report([['cat.wasm hello.txt → echoes file content via WASI fd_read+fd_write', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
