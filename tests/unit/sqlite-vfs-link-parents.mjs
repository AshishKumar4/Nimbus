#!/usr/bin/env bun
// Kinu N22: an entry made, removed or versioned through a directory link
// is keyed on the link's target, its resolved parent plus its own name, the
// way writeFile, unlink and rename already are. /home/user -> /home/main is
// what settleWorkspaceRoot leaves, and every old path names /home/user.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/main', { recursive: true });
kernel.chown('home/main', 1000, 1000);
kernel.symlink('/home/main', 'home/user');
const user = vfs.as(USER);
const enc = new TextEncoder();

user.mkdir('home/user/a/b', { recursive: true });
assert.ok(user.isDirectory('home/main/a/b'), 'mkdir -p through the link');
user.mkdir('home/user/c');
assert.ok(user.isDirectory('home/main/c'), 'mkdir lands on the target');
user.symlink('/tmp/t', 'home/user/s');
assert.equal(user.readlink('home/main/s'), '/tmp/t', 'symlink lands on the target');
user.mkdir('home/main/e');
user.rmdir('home/user/e');
assert.equal(user.exists('home/main/e'), false, 'rmdir through the link');

user.mkdirBatch(['/home/user/pkg/lib']);
assert.ok(user.isDirectory('home/main/pkg/lib'), 'mkdirBatch through the link');
assert.equal(kernel.lstat('home/user').type, 'symlink', 'and the link stays a link');

user.writeBatch({
  inodes: [
    { path: '/home/user/mod', parentPath: '/home/user', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 },
    { path: '/home/user/mod/index.js', parentPath: '/home/user/mod', isDir: false, size: 1, mtime: 1, mode: 0o644, chunkCount: 1 },
  ],
  chunks: [{ path: '/home/user/mod/index.js', chunkId: 0, data: enc.encode('x') }],
});
assert.equal(user.readFileString('home/main/mod/index.js'), 'x', 'writeBatch (a directory, an inode and its chunk) through the link');
user.writeBatch({ inodes: [], chunks: [], deletePaths: ['/home/user/mod/index.js'] });
assert.equal(user.exists('home/main/mod/index.js'), false, 'a batch deletion through the link');

user.writeFile('home/main/w.txt', '1');
const before = user.revision('home/user/w.txt');
user.writeFile('home/main/w.txt', '22');
assert.ok(user.revision('home/user/w.txt') > before, 'revision through the link follows writes to the target');
assert.equal(user.revision('home/user/w.txt'), user.revision('home/main/w.txt'));

console.log('sqlite-vfs-link-parents: ok');
