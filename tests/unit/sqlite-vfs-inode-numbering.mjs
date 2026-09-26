#!/usr/bin/env bun
// `/` is inode 1 (it has no row) and every entry's number is above it, so no
// two entries of one device ever share a number: cp's into-itself check,
// find/du loop detection, tar and git's stat cache all compare (dev, ino).
// A store written before this numbering (schema 2, which gave its first
// entry 1) is not read: it resets, and the reset is told once.

import assert from 'node:assert/strict';
import { SqliteVFS, ROOT_INODE } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const inodes = (harness) => [...harness.sql.exec('SELECT path, ino FROM vfs_inodes')].map((row) => [row.path, Number(row.ino)]);

// The allocator never issues the root's number, and the store refuses it.
{
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  kernel.mkdir('home/user/a/b', { recursive: true });
  kernel.writeFile('home/user/a/b/f', 'x');
  kernel.writeBatch({ inodes: [{ path: '/opt', parentPath: '/', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 }], chunks: [] });
  kernel.symlink('/opt', 'l');
  kernel.rename('home/user/a/b/f', 'home/user/g');
  const numbers = inodes(harness).map(([, ino]) => ino);
  assert.ok(numbers.every((ino) => ino > ROOT_INODE), `every entry is above the root: ${numbers}`);
  assert.equal(new Set(numbers).size, numbers.length, 'no two entries share a number');
  const bridge = processBridge(vfs, CRED_KERNEL);
  assert.equal(bridge.stat('/').ino, ROOT_INODE);
  assert.throws(
    () => harness.sql.exec("INSERT INTO vfs_inodes (path, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, gen) VALUES ('x', '', 0, 0, 0, 0, 0, 33188, 0, 0, 1, 1)"),
    /CHECK constraint/,
    'the store refuses the root number itself',
  );
}

// A schema-2 store (its first entry is ino 1, the root's) resets, and says so.
{
  const harness = createSqliteVfsTestHarness();
  const old = new SqliteVFS(harness.sql, harness.ctx);
  old.as(CRED_KERNEL).mkdir('home');
  old.as(CRED_KERNEL).writeFile('home/app.js', 'old');
  // What schema 2 left: the marker, and its numbering from 1.
  harness.sql.exec('UPDATE vfs_state SET schema = 2 WHERE slot = 1');
  harness.sql.exec('DROP TABLE vfs_inodes');
  harness.sql.exec('CREATE TABLE vfs_inodes (path TEXT PRIMARY KEY, parent_path TEXT NOT NULL, ino INTEGER NOT NULL)');
  harness.sql.exec("INSERT INTO vfs_inodes VALUES ('home', '', 1), ('home/app.js', 'home', 2)");

  const reopened = new SqliteVFS(harness.sql, harness.ctx);
  assert.equal(reopened.legacyReset, true, 'the reset is owed to the session');
  assert.equal(reopened.as(CRED_KERNEL).exists('home/app.js'), false, 'the old store is not served');
  assert.equal(Number([...harness.sql.exec('SELECT schema FROM vfs_state')][0].schema), 3);
  reopened.as(CRED_KERNEL).mkdir('home');
  reopened.as(CRED_KERNEL).writeFile('home/new.js', 'new');
  const numbers = inodes(harness).map(([, ino]) => ino);
  assert.ok(numbers.every((ino) => ino > ROOT_INODE) && new Set(numbers).size === numbers.length, `${numbers}`);
  const bridge = processBridge(reopened, CRED_KERNEL);
  assert.notEqual(bridge.stat('/home').ino, bridge.stat('/').ino, '/ and /home are distinct');
  const restarted = new SqliteVFS(harness.sql, harness.ctx);
  assert.equal(restarted.legacyReset, true, 'a restart before the notice still owes it');
  restarted.acknowledgeLegacyReset();
  assert.equal(new SqliteVFS(harness.sql, harness.ctx).legacyReset, false, 'told once');
  assert.equal(new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL).readFileString('home/new.js'), 'new', 'the new store stays');
}

console.log('sqlite-vfs-inode-numbering: ok');
