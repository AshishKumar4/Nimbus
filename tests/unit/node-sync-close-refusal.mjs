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
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';
import { waveSupervisor } from './lib/wave-supervisor.mjs';

/** The node shims over `supervisor`, with the process's client's flush (which answers, never reports). */
function facet(supervisor) {
  waveSupervisor(supervisor);
  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    `"use strict";${VFS_WRITE_LEDGER_SOURCE}\n${SHIMS_STORE_PRELUDE + generateShimsCode()}
;return { fs: builtins.fs, flushClient: () => __nimbusProcessFs().flush() };`,
  );
  const metadata = { 'home/user': { type: 'directory', size: 0, mode: 0o40755, uid: 1000, gid: 1000 } };
  return (declareNamespace({ metadata, manifest: {} }), factory(
    {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  ));
}

const refusing = { on: false };
const refusal = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
const supervisor = {
  async writeFile() { if (refusing.on) throw refusal(); },
  async fsWriteRange() { if (refusing.on) throw refusal(); },
};
const { fs, flushClient } = facet(supervisor);

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
  assert.match(error.message, /the session refused what this process wrote/, name);
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
