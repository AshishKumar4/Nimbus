#!/usr/bin/env bun
// A frame from a socket that comes while the session is being built (its
// fields set, its commands still registering) is delivered after the build
// and its shell's start, as the socket's first frame is (bindShellSocket
// joins it to the build): never ahead of it, never ahead of the login files.
// Red before: with the session's fields set, the frame was attached and
// delivered at once, mid-build.
import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { bindShellSocket } = await importWorkerBundle({ 'packages/worker/src/session/ws.ts': ['bindShellSocket'] });

let release;
const build = new Promise((resolve) => { release = resolve; });
let joined = 0;
const ws = { readyState: 1, send() {}, close() {} };
const self = {
  shell: {},
  kernel: {},
  terminal: { ws, attach() { throw new Error('attached mid-build'); } },
  building: build,
  _wakeRebuild: null,
  initSession(socket, options) {
    joined++;
    assert.equal(socket, ws);
    assert.deepEqual(options, { resume: 'wake' });
    return build;
  },
};
let delivered = false;
const bound = bindShellSocket(self, ws).then((ok) => { delivered = ok; });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(delivered, false, 'a frame during a build waits for it');
assert.equal(joined, 1, 'and joins the build through initSession');
release();
await bound;
assert.equal(delivered, true, 'then it is delivered');
// After the build, while the wake that joined it still waits for the login
// files (a headless build does not wait for them), a later frame waits on
// that wake, behind the first frame.
{
  let releaseWake;
  const wake = new Promise((resolve) => { releaseWake = resolve; });
  const self = {
    shell: {},
    kernel: {},
    terminal: { ws, attach() { throw new Error('attached during the wake'); } },
    building: null,
    _wakeRebuild: wake,
    initSession() { throw new Error('a second join'); },
  };
  let later = false;
  const bound = bindShellSocket(self, ws).then((ok) => { later = ok; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(later, false, 'a later frame waits for the pending wake');
  releaseWake();
  await bound;
  assert.equal(later, true, 'then it is delivered');
}
console.log('session-ws-frame-during-build: ok');
