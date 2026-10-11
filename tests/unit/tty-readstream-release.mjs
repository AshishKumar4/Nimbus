#!/usr/bin/env bun
// fd 0 has one source and independent consumers, as Node's process.stdin and
// a tty.ReadStream are separate handles on it: each is a Readable with its own
// flow, its own backpressure and its own hold on the input. A consumer
// flowing holds the input open, as a reading Node stdin does, so the program
// waits for its keystrokes; pausing or destroying one lets go of its own
// hold, and of nothing of another's. Each chunk goes to one consumer reading
// now. What has to hold:
//   - a tty reader destroyed, the hold goes; one of two, it stays;
//   - the program's own reading (a 'data' listener, a bare resume) keeps the
//     hold after a tty reader goes, and its pause lets go;
//   - the program's pause pauses process.stdin while a tty reader reads: it
//     is given nothing, the reader is;
//   - a tty reader destroyed while backpressured leaves the program reading.
// Red before: a destroyed reader kept the hold, and the attached program
// waited for its terminal's end; then, with readers riding on process.stdin,
// its pause was ignored while one read, and a backpressured reader destroyed
// left process.stdin paused.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
// A live input channel (a child_process child's): its supervisor long-polls
// it, handing what the test feeds, until the test ends it.
const inbox = [];
let ended = false;
const supervisor = {
  async cpReadStdin(_pid, waitMs) {
    await tick(Math.min(waitMs, 5));
    return inbox.length > 0 ? { data: inbox.shift(), ended: false } : { data: new Uint8Array(0), ended };
  },
};
const feed = (text) => inbox.push(new TextEncoder().encode(text));
const shim = new Function('__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  'const __pendingIO = [];' + generateShimsCode() + '\nreturn { tty: builtins.tty, stdin: __processMod.stdin };')(
  {}, {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], { NIMBUS_CP_CHILD_PID: '41' }, '/home/user/main.js', '/home/user');
const held = () => globalThis.__nimbusInputHandles || 0;

{
  const input = new shim.tty.ReadStream(0);
  input.resume();
  await tick(20);
  assert.equal(held(), 1, 'reading the terminal holds the input');
  input.destroy();
  await tick(20);
  assert.equal(held(), 0, 'its only reader destroyed, the hold goes');
}

{
  const first = new shim.tty.ReadStream(0);
  const second = new shim.tty.ReadStream(0);
  first.resume();
  second.resume();
  await tick(20);
  first.destroy();
  await tick(20);
  assert.equal(held(), 1, 'one of two destroyed, the other still reads');
  second.destroy();
  await tick(20);
  assert.equal(held(), 0, 'the last destroyed, the hold goes');
}

{
  const own = () => {};
  shim.stdin.on('data', own);
  const input = new shim.tty.ReadStream(0);
  input.resume();
  await tick(20);
  input.destroy();
  await tick(20);
  assert.equal(held(), 1, 'the program reading stdin itself keeps it');
  shim.stdin.removeListener('data', own);
  shim.stdin.pause();
  await tick(20);
  assert.equal(held(), 0);
}

{
  // The program's own resume, with no listener, is its own hold.
  shim.stdin.resume();
  const input = new shim.tty.ReadStream(0);
  input.resume();
  await tick(20);
  input.destroy();
  await tick(20);
  assert.equal(held(), 1, "the program's resume keeps the input held after its reader goes");
  assert.equal(shim.stdin.readableFlowing, true, 'and flowing');
  shim.stdin.pause();
  await tick(20);
  assert.equal(held(), 0, 'its pause lets go of the last hold');
}

{
  const own = [];
  const ownListener = (chunk) => own.push(String(chunk));
  shim.stdin.on('data', ownListener);
  const got = [];
  const input = new shim.tty.ReadStream(0);
  input.on('data', (chunk) => got.push(String(chunk)));
  await tick(20);
  shim.stdin.pause();
  assert.equal(shim.stdin.isPaused(), true, "the program's pause pauses process.stdin while a tty reader reads");
  feed('c');
  await tick(40);
  assert.deepEqual(own, [], 'paused, process.stdin is given nothing');
  assert.deepEqual(got, ['c'], 'the reader still reading is');
  assert.equal(held(), 1, "the reader's hold stays");
  input.destroy();
  shim.stdin.removeListener('data', ownListener);
  await tick(20);
  assert.equal(held(), 0);
}

{
  // process.stdin is paused: a reader that reads into its buffer and is never
  // read takes what comes, past its high-water mark, and is backpressured.
  const input = new shim.tty.ReadStream(0);
  input.on('readable', () => {});
  await tick(20);
  feed('x'.repeat(64 * 1024));
  await tick(40);
  assert.equal(input.readableLength, 64 * 1024, 'the reader took it');
  const own = [];
  const ownListener = (chunk) => own.push(String(chunk));
  shim.stdin.on('data', ownListener);
  input.destroy();
  await tick(20);
  feed('b');
  await tick(40);
  assert.deepEqual(own, ['b'], 'a reader destroyed while backpressured leaves the program reading');
  assert.equal(shim.stdin.readableFlowing, true);
  shim.stdin.removeListener('data', ownListener);
  shim.stdin.pause();
  await tick(20);
  assert.equal(held(), 0);
}

ended = true;
console.log('tty-readstream-release: ok');
