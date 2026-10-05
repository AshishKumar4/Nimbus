#!/usr/bin/env bun
// A W7 stream into the SQLite VFS answers with each published file's stat
// (the receipts a producer builds a warm git index from), and admits each
// new file with one inode lookup, not five.
//
// Red before: the result carried no receipts, and a new file was looked up at
// file-begin twice (normalisation, then the replace check), at file-end twice
// (normalisation, then the entry), and once more by the committing
// transaction: five SELECTs of a row that does not exist.

import assert from 'node:assert/strict';

import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const kernel = raw.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', 1000, 1000);
const vfs = raw.as(USER);

const FILES = 120;
const enc = new TextEncoder();
const inodes = [
  { path: 'home/user/repo', parentPath: 'home/user', kind: 'directory', isDir: true, size: 0, mtime: 1_000, mode: 0o755, chunkCount: 0 },
  { path: 'home/user/repo/src', parentPath: 'home/user/repo', kind: 'directory', isDir: true, size: 0, mtime: 1_000, mode: 0o755, chunkCount: 0 },
];
const chunks = [];
for (let index = 0; index < FILES; index++) {
  const data = enc.encode(`file ${index}\n`);
  const path = `home/user/repo/src/f${index}.txt`;
  inodes.push({ path, parentPath: 'home/user/repo/src', kind: 'file', isDir: false, size: data.byteLength, mtime: 2_000 + index, mode: index % 2 ? 0o755 : 0o644, chunkCount: 1 });
  chunks.push({ path, chunkId: 0, data });
}
const target = enc.encode('src/f0.txt');
inodes.push({ path: 'home/user/repo/link', parentPath: 'home/user/repo', kind: 'symlink', isDir: false, size: target.byteLength, mtime: 3_000, mode: 0o777, chunkCount: 1 });
chunks.push({ path: 'home/user/repo/link', chunkId: 0, data: target });

const selectsBefore = harness.statements.filter((statement) => statement.sql.startsWith('SELECT path, parent_path')).length;
const result = await vfs.writeStream(encodeWriteBatchStream({ inodes, chunks }));
const inodeSelects = harness.statements.filter((statement) => statement.sql.startsWith('SELECT path, parent_path')).length - selectsBefore;
assert.equal(result.ok, true, result.error?.message);

assert.ok(Array.isArray(result.receipts), 'writeStream answered without receipts');
assert.equal(result.receipts.length, FILES + 1, 'not every published file has a receipt');
for (const receipt of result.receipts) {
  const stat = vfs.lstat(receipt.path);
  assert.deepEqual(
    { ino: receipt.ino, mode: receipt.mode, size: receipt.size, mtimeMs: receipt.mtimeMs, ctimeMs: receipt.ctimeMs, uid: receipt.uid, gid: receipt.gid, dev: receipt.dev },
    { ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtime, ctimeMs: stat.ctime, uid: stat.uid, gid: stat.gid, dev: stat.dev },
    `receipt for ${receipt.path} disagrees with its stat`,
  );
}
assert.deepEqual(result.receipts.map((receipt) => receipt.path).slice(0, 3),
  ['home/user/repo/src/f0.txt', 'home/user/repo/src/f1.txt', 'home/user/repo/src/f2.txt']);

// One lookup per new file, plus the stream's directories.
assert.ok(inodeSelects <= FILES + 1 + 10,
  `${inodeSelects} inode lookups published ${FILES + 1} new files`);

console.log('sqlite vfs write stream receipts: ok');
