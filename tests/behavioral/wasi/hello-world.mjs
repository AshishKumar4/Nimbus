#!/usr/bin/env bun
// wasi/hello-world — fd_write the bytes "hello, WASI!\n" to stdout via WASI.
//
// Fixture: 143 B hand-rolled wasm; one import (fd_write); _start calls
// fd_write(fd=1, iov_ptr=8, iov_len=1, nwritten=16) with an iovec pointing
// at the message bytes at offset 24. Verified locally under node:wasi:
// prints "hello, WASI!\n".
//
// core WASI WASI fn under test: fd_write (fd 1 → stdout via ProcessLogStore).

import { openWasiProbe, tailLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/hello-world', { dir: '/home/user/wasi', fixture: 'hello', as: 'hello.wasm' });
const { t } = probe;
try {
  const result = await t.run('wasm-runner hello.wasm _start', 30_000);
  const tail = tailLines(result.output, 6);
  const wroteOk = /hello, WASI!/.test(tail);
  const noErr  = !/error|err:/i.test(tail);

  probe.report([
    ['hello-world fd_write produced "hello, WASI!"', wroteOk],
    ['no error string in output',                    noErr],
  ], { tail, wroteOk, noErr });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
