#!/usr/bin/env bun
// A tty.ReadStream a program makes reads the process's stdin, and holds the
// input as a referenced stdin handle does, so the program waits for its
// keystrokes. The hold has owners: each such reader, and the program's own
// reading of process.stdin (its resume, until its pause). Destroyed, a reader
// lets go of its own: with no owner left the hold goes, so a program whose
// only reader of its terminal is gone ends (its natural exit counts the input
// handles), and one that reads stdin itself is held still. Red before:
// destroying it left the hold, and an attached program waited for its
// terminal's end.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
// A live input channel (a child_process child's): its supervisor long-polls
// it, until the test ends it.
let ended = false;
const supervisor = {
  async cpReadStdin(_pid, waitMs) { await tick(Math.min(waitMs, 20)); return { data: new Uint8Array(0), ended }; },
};
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

ended = true;
console.log('tty-readstream-release: ok');
