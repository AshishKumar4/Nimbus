#!/usr/bin/env bun
// A synchronous write the program was told succeeded, and the session then
// refused, is reported at the process's next sync and its next close of a
// descriptor, with the session's errno, once: fs.fsync, fs.fdatasync,
// fsyncSync, fdatasyncSync, FileHandle.sync and .datasync, FileHandle.close,
// fs.close and closeSync, as fsync(2) and close(2) report a deferred write's
// failure (and a WASI process's syncs and closes do). Red before: Node's
// syncs and closes never took the client's recorded refusals, so only the
// next effect or the exit reported them, as EIO.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const authority = createAuthority();
authority.kfs.mkdir('/home/user', { recursive: true });

// While `on`, the session refuses each wave: the wave is not applied, and its
// answer is the refusal with the errno the session gives (ENOSPC).
const refusing = { on: false };
const refusedWave = () => ({
  committedGroupSequence: 0, committedPathCount: 0, committedOps: 0, inodes: 0, chunks: 0, receipts: [],
  ok: false, error: { code: 'ERR_WRITE_BATCH_STREAM', phase: 'publish', message: 'no space left on device', errno: 'ENOSPC' },
});
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
const flushClient = () => globalThis.__nimbusProcessFs.flush();

let lost = 0;
/** A synchronous write the session refuses, answered (and recorded) before the call under test. */
async function refuseOne() {
  refusing.on = true;
  fs.writeFileSync(`/home/user/lost-${lost++}.txt`, 'lost');
  await flushClient();
  refusing.on = false;
}

const reported = (name, syscall) => (error) => {
  assert.equal(error.code, 'ENOSPC', `${name}: ${error.message}`);
  assert.equal(error.syscall, syscall, name);
  return true;
};
const callback = (call) => (fd) => new Promise((resolve, reject) => call(fd, (error) => (error ? reject(error) : resolve())));

const syncs = {
  'fs.fsync': [callback(fs.fsync), 'fsync'],
  'fs.fdatasync': [callback(fs.fdatasync), 'fdatasync'],
  fsyncSync: [async (fd) => fs.fsyncSync(fd), 'fsync'],
  fdatasyncSync: [async (fd) => fs.fdatasyncSync(fd), 'fdatasync'],
};
for (const [name, [sync, syscall]] of Object.entries(syncs)) {
  const fd = fs.openSync(`/home/user/${name}.txt`, 'w');
  fs.writeSync(fd, 'kept');
  await flushClient();
  await refuseOne();
  await assert.rejects(sync(fd), reported(name, syscall), `${name} did not report the refusal recorded before it`);
  // Reported once: the next is clean.
  await sync(fd);
  fs.closeSync(fd);
}

const closes = {
  'fs.close': callback(fs.close),
  closeSync: async (fd) => fs.closeSync(fd),
};
for (const [name, close] of Object.entries(closes)) {
  const fd = fs.openSync(`/home/user/${name}.txt`, 'w');
  await flushClient();
  await refuseOne();
  await assert.rejects(close(fd), reported(name, 'close'), `${name} did not report the refusal recorded before it`);
  // Closed all the same.
  assert.throws(() => fs.fstatSync(fd), (error) => error.code === 'EBADF', `${name} left the descriptor open`);
}

for (const [method, syscall] of [['sync', 'fsync'], ['datasync', 'fdatasync'], ['close', 'close']]) {
  const handle = await fs.promises.open(`/home/user/handle-${method}.txt`, 'w');
  await refuseOne();
  await assert.rejects(handle[method](), reported(`FileHandle.${method}`, syscall), `FileHandle.${method} did not report the refusal recorded before it`);
  if (method !== 'close') {
    await handle[method]();
    await handle.close();
  }
}

console.log('node-sync-close-refusal: ok');
