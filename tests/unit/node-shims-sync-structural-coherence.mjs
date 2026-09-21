#!/usr/bin/env bun
// A synchronous structural mutation — mkdirSync, rmdirSync, unlinkSync,
// renameSync — has no channel to the authority: a sync syscall cannot make
// an RPC. writeFileSync parks a cell that the write ledger flushes later;
// directories and removals had no such path and edited local tables only.
// So node-tar's per-entry sequence, `mkdirSync(dir)` then
// `fs.promises.open(dir + '/file', 'w')`, asked the authority to open a file
// under a directory it had never heard of, and was answered ENOENT. That is
// create-astro's template copy.
//
// The repair queues the authority mutation behind the sync effect, ordered
// behind every pending mutation of the path's ancestors, and every async
// entry point that reaches the authority waits for those first. This test
// pins the ORDER the authority observes, against the real SqliteVFS.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const dec = new TextDecoder();
const home = '/home/user';
vfs.mkdir(home, { recursive: true });

// Every authority call, in the order the authority received it.
const calls = [];
const record = (op, path, fn) => (...args) => {
  calls.push({ op, path: String(path(...args)) });
  return fn(...args);
};
const first = (...args) => args[0];
const supervisor = {
  readFile: record('readFile', first, async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; }),
  writeFile: record('writeFile', first, (p, c) => bridge.writeFile(p, c)),
  stat: record('stat', first, (p) => bridge.stat(p)),
  lstat: record('lstat', first, (p) => bridge.stat(p, { followSymlinks: false })),
  readdir: record('readdir', first, (p) => bridge.readdir(p)),
  exists: record('exists', first, async (p) => (await bridge.stat(p)) !== null),
  access: record('access', first, (p, m) => bridge.access(p, m)),
  mkdir: record('mkdir', first, (p, o) => bridge.mkdir(p, o ?? { recursive: true })),
  rmdir: record('rmdir', first, (p) => bridge.rmdir(p)),
  unlink: record('unlink', first, (p) => bridge.unlink(p)),
  rename: record('rename', (a, b) => `${a} -> ${b}`, (a, b) => bridge.rename(a, b)),
  fsReadRange: record('fsReadRange', first, (p, o, l) => bridge.readRange(p, o, l)),
  fsWriteRange: record('fsWriteRange', first, (p, o, b) => bridge.writeRange(p, o, b)),
  fsTruncate: record('fsTruncate', first, (p, s) => bridge.truncate(p, s)),
  fsAcquire: (epoch, cursor) => bridge.acquire(epoch, cursor),
};
globalThis.__nimbusVfsCursor = { epoch: rawVfs.epoch, rev: rawVfs.revision() };

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode()
  + '\n;return { fs: __fsMod, drain: () => __nimbusDrainVfsWrites(__supervisor) };',
);
const { fs, drain } = factory(
  {},
  { 'home/user': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } },
  {}, { home: ['user'], 'home/user': [] }, supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, home, [], {}, `${home}/s.mjs`, home,
);

const indexOf = (op, path) => calls.findIndex((c) => c.op === op && c.path === path);
const rejectsWith = async (promise, code) => {
  let seen = null;
  try { await promise; } catch (error) { seen = error.code; }
  assert.equal(seen, code, `expected ${code}, got ${seen}`);
};

// 1. mkdirSync then fs.promises.open under it, the node-tar sequence.
{
  fs.mkdirSync(`${home}/d`, { recursive: true });
  const handle = await fs.promises.open(`${home}/d/f`, 'w');
  await handle.write('hello');
  await handle.close();
  const mkdirAt = indexOf('mkdir', `${home}/d`);
  const firstTouch = calls.findIndex((c) => c.path === `${home}/d/f`);
  assert.ok(mkdirAt >= 0, 'the authority received the mkdir');
  assert.ok(firstTouch > mkdirAt, `mkdir(d) at ${mkdirAt} must precede the first touch of d/f at ${firstTouch}`);
  assert.equal(dec.decode(bridge.readFile(`${home}/d/f`)), 'hello', 'the file content reached the authority');
}

// 2. Nested mkdirSync lands parent before child at the authority.
{
  fs.mkdirSync(`${home}/a`);
  fs.mkdirSync(`${home}/a/b`);
  await fs.promises.access(`${home}/a/b`);
  const parent = indexOf('mkdir', `${home}/a`);
  const child = indexOf('mkdir', `${home}/a/b`);
  assert.ok(parent >= 0 && child >= 0, 'both directories reached the authority');
  assert.ok(parent < child, `mkdir(a) at ${parent} must precede mkdir(a/b) at ${child}`);
  assert.equal(bridge.stat(`${home}/a/b`)?.type, 'directory');
}

// 3. mkdirSync then an async readdir of it answers [] rather than ENOENT.
{
  fs.mkdirSync(`${home}/x`);
  const entries = await fs.promises.readdir(`${home}/x`);
  assert.deepEqual(entries, []);
}

// 4. writeFileSync then unlinkSync: the authority never ends with the file.
// Once for a file that only ever existed as a parked cell, and once for a
// file the authority already held — the unlink must reach it.
{
  fs.writeFileSync(`${home}/g`, '1');
  fs.unlinkSync(`${home}/g`);
  await rejectsWith(fs.promises.access(`${home}/g`), 'ENOENT');
  assert.equal(bridge.stat(`${home}/g`), null, 'the authority does not hold g');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bridge.stat(`${home}/g`), null, 'and no later write-back resurrects it');

  vfs.writeFile(`${home}/h`, new TextEncoder().encode('held'));
  fs.unlinkSync(`${home}/h`);
  await rejectsWith(fs.promises.access(`${home}/h`), 'ENOENT');
  assert.equal(bridge.stat(`${home}/h`), null, 'a sync unlink of an authority-held file lands');
  assert.ok(indexOf('unlink', `${home}/h`) >= 0, 'the authority received the unlink');
}

// 5. mkdirSync then renameSync of the directory: the new name is a directory.
{
  fs.mkdirSync(`${home}/r`);
  fs.renameSync(`${home}/r`, `${home}/s`);
  const st = await fs.promises.stat(`${home}/s`);
  assert.ok(st.isDirectory(), 's is a directory at the authority');
  await rejectsWith(fs.promises.stat(`${home}/r`), 'ENOENT');
}

// 6. A program that only mkdirSync's and returns: the exit drain lands it.
{
  fs.mkdirSync(`${home}/only`);
  await drain();
  assert.equal(bridge.stat(`${home}/only`)?.type, 'directory', 'the exit drain carried the directory across');
}

console.log('node-shims-sync-structural-coherence: all assertions passed');
