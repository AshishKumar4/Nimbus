#!/usr/bin/env bun
// A synchronous write the program was told succeeded, and the session then
// refused, is reported at the process's next sync and its next close of a
// descriptor, with the session's errno, once: fs.fsync, fs.fdatasync,
// fsyncSync, fdatasyncSync, FileHandle.sync and .datasync, FileHandle.close,
// fs.close and closeSync, as fsync(2) and close(2) report a deferred write's
// failure (and a WASI process's syncs and closes do). Red before: Node's
// syncs and closes never took the client's recorded refusals, so only the
// next effect or the exit reported them, as EIO.
//
// Each form is a process of its own over the real session (runScenarios).

import assert from 'node:assert/strict';
import { createAuthority, runScenarios } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const refusedWave = () => ({
  committedGroupSequence: 0, committedPathCount: 0, committedOps: 0, inodes: 0, chunks: 0, receipts: [],
  ok: false, error: { code: 'ERR_WRITE_BATCH_STREAM', phase: 'publish', message: 'no space left on device', errno: 'ENOSPC' },
});

/** A process whose session refuses the waves sent while `refusing.on`, and `refuseOne`, which makes one such refused write. */
function facet() {
  const refusing = { on: false };
  const authority = createAuthority();
  const { fs } = shimsOnSession({
    authority,
    overrides: (forward) => ({
      writeBatchStream: async (stream, fence, owner) => {
        if (!refusing.on) return forward('writeBatchStream', [stream, fence, owner]);
        await stream.cancel();
        return refusedWave();
      },
    }),
  });
  let lost = 0;
  /**
   * A synchronous write the session refuses, answered (and recorded) before
   * the call under test: sent and answered by the process's client, which
   * records the refusal for the next boundary that reports it.
   */
  const refuseOne = async () => {
    refusing.on = true;
    fs.writeFileSync(`/home/user/lost-${lost++}.txt`, 'lost');
    globalThis.__nimbusProcessFs.logHeld();
    await globalThis.__nimbusProcessFs.client.flush().catch(() => {});
    refusing.on = false;
  };
  return { fs, refuseOne };
}

const reported = (syscall) => (error) => {
  assert.equal(error.code, 'ENOSPC', error.message);
  assert.equal(error.syscall, syscall);
  return true;
};
const done = (resolve, reject) => (error) => (error ? reject(error) : resolve());

const syncs = {
  'fs.fsync': [(fs, fd) => new Promise((resolve, reject) => fs.fsync(fd, done(resolve, reject))), 'fsync'],
  'fs.fdatasync': [(fs, fd) => new Promise((resolve, reject) => fs.fdatasync(fd, done(resolve, reject))), 'fdatasync'],
  fsyncSync: [(fs, fd) => fs.fsyncSync(fd), 'fsync'],
  fdatasyncSync: [(fs, fd) => fs.fdatasyncSync(fd), 'fdatasync'],
};
const closes = {
  'fs.close': (fs, fd) => new Promise((resolve, reject) => fs.close(fd, done(resolve, reject))),
  closeSync: (fs, fd) => fs.closeSync(fd),
};

const scenarios = {};
for (const [name, [sync, syscall]] of Object.entries(syncs)) {
  scenarios[`${name} reports a refusal recorded before it, once`] = async () => {
    const { fs, refuseOne } = facet();
    const fd = fs.openSync(`/home/user/${name}.txt`, 'w');
    fs.writeSync(fd, 'kept');
    await globalThis.__nimbusProcessFs.flush();
    await refuseOne();
    await assert.rejects(async () => sync(fs, fd), reported(syscall), `${name} did not report the refusal recorded before it`);
    // Reported once: the next is clean.
    await sync(fs, fd);
    fs.closeSync(fd);
  };
}
for (const [name, close] of Object.entries(closes)) {
  scenarios[`${name} reports a refusal recorded before it, and closes`] = async () => {
    const { fs, refuseOne } = facet();
    const fd = fs.openSync(`/home/user/${name}.txt`, 'w');
    await globalThis.__nimbusProcessFs.flush();
    await refuseOne();
    await assert.rejects(async () => close(fs, fd), reported('close'), `${name} did not report the refusal recorded before it`);
    // Closed all the same.
    assert.throws(() => fs.fstatSync(fd), (error) => error.code === 'EBADF', `${name} left the descriptor open`);
  };
}
for (const [method, syscall] of [['sync', 'fsync'], ['datasync', 'fdatasync'], ['close', 'close']]) {
  scenarios[`FileHandle.${method} reports a refusal recorded before it`] = async () => {
    const { fs, refuseOne } = facet();
    const handle = await fs.promises.open(`/home/user/handle-${method}.txt`, 'w');
    await refuseOne();
    await assert.rejects(async () => handle[method](), reported(syscall), `FileHandle.${method} did not report the refusal recorded before it`);
    if (method !== 'close') {
      await handle[method]();
      await handle.close();
    }
  };
}

await runScenarios(import.meta.path, scenarios);
