// The live fd 1/2 relay when the output's reader goes away (a pipe's reader
// closed: `git show | head`):
//   - every later write is refused with the session's EPIPE, its code kept,
//     so fd_write answers EPIPE as a native write does;
//   - the relay says the pipe broke, which a runner reports as SIGPIPE's
//     status rather than as lost output;
//   - another refusal is lost output, as before, and no broken pipe.

import assert from 'node:assert/strict';
import { wasiOutputRelay } from '../../packages/core/src/runtime/wasi/stdio.ts';

const pipeClosed = () => Object.assign(new Error('EPIPE: pipe reader closed'), { code: 'EPIPE' });
{
  let calls = 0;
  const relay = wasiOutputRelay({
    stdout() { calls++; return Promise.reject(pipeClosed()); },
    stderr() {},
  });
  await relay.stdoutBytes(new Uint8Array([1]));
  await relay.drain();
  assert.equal(relay.brokenPipe(), true, 'the reader went away');
  assert.throws(() => relay.stdoutBytes(new Uint8Array([2])), (error) => error.code === 'EPIPE', 'a later write is EPIPE, its code kept');
  assert.equal(calls, 1, 'and is not sent');
}
{
  const relay = wasiOutputRelay({
    stdout() { return Promise.reject(Object.assign(new Error('EIO: the session refused'), { code: 'EIO' })); },
    stderr() {},
  });
  await relay.stdoutBytes(new Uint8Array([1]));
  assert.equal(await relay.drain(), 'EIO: the session refused', 'another refusal is lost output');
  assert.equal(relay.brokenPipe(), false);
}
console.log('wasi-output-broken-pipe: a closed reader is EPIPE to the writer, and SIGPIPE to its runner');
