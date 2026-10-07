#!/usr/bin/env bun
/**
 * The shell's built-in node (lifo node-compat/fs.ts) reports a file's Stats
 * as the filesystem has them: its device and inode, its links, its owner,
 * its mode, and its access time apart from its modification time, as
 * Node's fs.statSync reports the inode's, and its mode with the file type's
 * format bits (S_IFREG, S_IFDIR) as Node's always has them. It used to
 * report device and inode 0, owner 1000:1000, two links for any directory
 * and one for a file, the modification time as the access time, and the
 * mode as the filesystem gave it, without format bits where it had none.
 */

import assert from 'node:assert/strict';
import { createFs } from '../../packages/core/src/substrate/lifo/node-compat/fs.ts';
import { synchronousFilesystem } from '../../packages/core/src/substrate/lifo/node-compat/filesystem.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
kernel.mkdir('t/dir/sub', { recursive: true });
kernel.writeFile('t/file', 'hello');
kernel.chown('t/file', 1234, 5678);
kernel.utimes('t/file', 1_000_000, 2_000_000);
const filesystem = synchronousFilesystem({ process: processBridge(rawVfs, CRED_KERNEL) })();
const fs = createFs(filesystem, '/t');
try {
  for (const path of ['/t/file', '/t/dir']) {
    const vfs = filesystem.stat(path);
    const node = fs.statSync(path);
    assert.deepEqual(
      { dev: node.dev, ino: node.ino, nlink: node.nlink, uid: node.uid, gid: node.gid, permissions: node.mode & 0o7777, atimeMs: node.atimeMs, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs, size: node.size },
      { dev: vfs.dev, ino: vfs.ino, nlink: vfs.nlink, uid: vfs.uid, gid: vfs.gid, permissions: vfs.mode & 0o7777, atimeMs: vfs.atime, mtimeMs: vfs.mtime, ctimeMs: vfs.ctime, size: vfs.size },
      `${path}: the filesystem's stat`,
    );
  }
  // The format bits Node's mode carries.
  assert.equal(fs.statSync('/t/file').mode & 0o170000, 0o100000, 'a file is S_IFREG');
  assert.equal(fs.statSync('/t/dir').mode & 0o170000, 0o040000, 'a directory is S_IFDIR');
  const file = fs.statSync('/t/file');
  assert.deepEqual([file.uid, file.gid], [1234, 5678], 'its owner');
  assert.notEqual(file.ino, 0, 'its inode');
  assert.equal(file.atimeMs, 1_000_000, 'its access time, not its modification time');
  assert.equal(file.mtimeMs, 2_000_000);
  assert.ok(fs.statSync('/t/dir').isDirectory());
} finally {
  harness.db.close();
}
console.log('lifo-node-fs-stats: Stats are the filesystem stat');
