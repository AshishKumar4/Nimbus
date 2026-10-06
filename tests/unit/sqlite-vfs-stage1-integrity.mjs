#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { CHUNK_SIZE } from '../../packages/platform/src/limits.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness, inodeTableScans } from './sqlite-vfs-test-harness.mjs';
import { bytes, fileChunks, fileInode, openVfs } from './lib/staged-import.mjs';

/** The chunk ids a path's content is stored in, in file order. */
function durableChunkIds(harness, path) {
  const [row] = harness.sql.exec('SELECT chunk_id, content_id FROM vfs_inodes WHERE path = ?', path);
  assert.ok(row, `expected one inode for ${path}`);
  if (row.chunk_id !== null) return [row.chunk_id];
  return harness.sql.exec(
    'SELECT chunk_id FROM vfs_content_chunks WHERE content_id = ? ORDER BY off',
    row.content_id,
  ).map((chunk) => chunk.chunk_id);
}

function chunkExists(harness, id) {
  return harness.sql.exec('SELECT 1 FROM vfs_chunks WHERE id = ?', id).length > 0;
}

function latestTransactionStatementCount(harness, transactionStart) {
  const transaction = harness.transactionCount;
  assert.ok(transaction > transactionStart, 'expected a new transaction');
  return harness.statements.filter((statement) => statement.transaction === transaction).length;
}

// The durable kind domain is enforced by the schema, and a batch entry's
// parent must match its path.
{
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  assert.throws(
    () => harness.sql.exec("INSERT INTO vfs_inodes (path, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, gen) VALUES ('invalid', '', 7, 0, 0, 0, 0, 0, 0, 0, 1, 1)"),
    /CHECK constraint/,
  );
  assert.throws(() => vfs.writeBatch({
    inodes: [{ ...fileInode('child', 0), parentPath: 'wrong-parent' }],
    chunks: [],
  }), /parentPath wrong-parent does not match/);
}

const strictCreateStatementCount = (() => {
  const { harness, rawVfs, vfs } = openVfs();
  const start = harness.transactionCount;
  const data = bytes(5, 1);
  vfs.writeBatch({
    inodes: [fileInode('strict-count.bin', data.length)],
    chunks: fileChunks('strict-count.bin', data),
  });
  return latestTransactionStatementCount(harness, start);
})();

// The strict full-file batch publishes staging ownership, inode pointer, and
// chunks in one transaction. A fault at every actual SQL position must leave
// both live and durable state unchanged.
for (let statement = 1; statement <= strictCreateStatementCount; statement++) {
  const { harness, vfs } = openVfs();
  const data = bytes(5, statement);
  const revision = vfs.revision();
  harness.failOnTransactionStatement(statement);
  assert.throws(() => vfs.writeBatch({
    inodes: [fileInode('rollback.bin', data.length)],
    chunks: fileChunks('rollback.bin', data),
  }), /injected SQL fault/);
  assert.equal(vfs.revision(), revision);
  assert.equal(vfs.exists('rollback.bin'), false);
  assert.deepEqual(harness.sql.exec("SELECT path FROM vfs_inodes WHERE path = 'rollback.bin'"), []);
  assert.deepEqual(harness.sql.exec('SELECT id FROM vfs_chunks'), []);
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.equal(reconstructed.exists('rollback.bin'), false);
}

// Schema initialization itself is atomic and fails before mutation when
// transactionSync is unavailable.
{
  const harness = createSqliteVfsTestHarness();
  assert.throws(() => new SqliteVFS(harness.sql), /requires transactionSync/);
  assert.deepEqual(
    harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inodes'"),
    [],
  );
}

const strictReplaceStatementCount = (() => {
  const { harness, vfs } = openVfs();
  vfs.writeFile('replace-count.bin', bytes(7, 1));
  const start = harness.transactionCount;
  const data = bytes(5, 2);
  vfs.writeBatch({
    inodes: [fileInode('replace-count.bin', data.length)],
    chunks: fileChunks('replace-count.bin', data),
  });
  return latestTransactionStatementCount(harness, start);
})();

// Full-file replacement remains complete-old on a fault anywhere in the
// pointer-swap transaction; old chunks are queued for later bounded GC.
for (let statement = 1; statement <= strictReplaceStatementCount; statement++) {
  const { harness, vfs } = openVfs();
  const oldData = bytes(CHUNK_SIZE + 7, 21);
  const newData = bytes(5, 81);
  vfs.writeFile('atomic-replace.bin', oldData);
  const revision = vfs.revision();
  harness.failOnTransactionStatement(statement);
  assert.throws(() => vfs.writeBatch({
    inodes: [fileInode('atomic-replace.bin', newData.length)],
    chunks: fileChunks('atomic-replace.bin', newData),
  }), /injected SQL fault/);
  assert.equal(vfs.revision(), revision);
  assert.deepEqual(vfs.readFile('atomic-replace.bin'), oldData);
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('atomic-replace.bin'), oldData);
}

// Both attempts of a retryable strict batch can fail without publishing a
// prefix or moving the revision.
{
  const { harness, vfs } = openVfs();
  const data = bytes(5, 12);
  harness.failOnTransactionStatement(2, {
    transaction: null,
    repeat: true,
    error: new Error('SQLITE_NOMEM: persistent strict-batch failure'),
  });
  const revision = vfs.revision();
  assert.throws(() => vfs.writeBatch({
    inodes: [fileInode('never-visible.bin', data.length)],
    chunks: fileChunks('never-visible.bin', data),
  }), /SQLITE_NOMEM/);
  assert.equal(vfs.revision(), revision);
  assert.equal(vfs.exists('never-visible.bin'), false);
  assert.deepEqual(harness.sql.exec("SELECT path FROM vfs_inodes WHERE path = 'never-visible.bin'"), []);
  assert.deepEqual(harness.sql.exec('SELECT id FROM vfs_chunks'), []);
}

// #4: a SQLITE_NOMEM retry must rerun the same strict transaction, never
// commit a first half before a later half fails.
{
  const { harness, vfs } = openVfs();
  const a = bytes(3, 1);
  const b = bytes(3, 9);
  const transactionStart = harness.transactionCount;
  const firstAttempt = transactionStart + 1;
  harness.setFaultInjector(({ transaction, transactionStatement }) => {
    if (transaction === firstAttempt && transactionStatement === 2) {
      return new Error('SQLITE_NOMEM: injected whole-batch failure');
    }
    if (transaction === firstAttempt + 2 && transactionStatement === 1) {
      return new Error('injected second-half failure');
    }
    return null;
  });
  const revision = vfs.revision();
  const result = vfs.writeBatch({
    inodes: [fileInode('a.bin', a.length), fileInode('b.bin', b.length)],
    chunks: [...fileChunks('a.bin', a), ...fileChunks('b.bin', b)],
  });
  assert.deepEqual(result, { inodes: 2, chunks: 2 });
  assert.equal(vfs.revision(), revision + 1, 'successful strict retry must tick once');
  assert.deepEqual(vfs.readFile('a.bin'), a);
  assert.deepEqual(vfs.readFile('b.bin'), b);
  assert.equal(
    harness.transactionCount,
    transactionStart + 2,
    'strict retry must execute the same transaction once more',
  );
}

// #5: one inode with multiple chunks must never be split into orphan chunks.
{
  const { harness, vfs } = openVfs();
  const data = bytes(CHUNK_SIZE + 7, 17);
  harness.failOnTransactionStatement(2, {
    error: new Error('SQLITE_NOMEM: injected one-file failure'),
  });
  const revision = vfs.revision();
  assert.deepEqual(vfs.writeBatch({
    inodes: [fileInode('one.bin', data.length)],
    chunks: fileChunks('one.bin', data),
  }), { inodes: 1, chunks: 2 });
  assert.equal(vfs.revision(), revision + 1);
  assert.deepEqual(vfs.readFile('one.bin'), data);
  const durableInodes = harness.sql.exec("SELECT path FROM vfs_inodes WHERE path = 'one.bin'");
  assert.deepEqual(durableInodes, [{ path: 'one.bin' }]);
  assert.ok(durableChunkIds(harness, 'one.bin').every((id) => chunkExists(harness, id)));
}

// #6: a failed strict batch must preserve a previously committed range edit.
{
  const { harness, vfs } = openVfs();
  const accepted = bytes(CHUNK_SIZE + 5, 31);
  const replacement = bytes(2, 99);
  vfs.writeFile('race.bin', bytes(accepted.length, 3));
  vfs.writeRange('race.bin', 0, accepted);
  harness.failOnTransactionStatement(1);
  assert.throws(() => vfs.writeBatch({
    inodes: [fileInode('race.bin', replacement.length)],
    chunks: fileChunks('race.bin', replacement),
  }), /injected SQL fault/);
  assert.deepEqual(vfs.readFile('race.bin'), accepted);
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('race.bin'), accepted);
}

// The SQLITE_NOMEM retry evicts the disposable cache. A second failure must
// still leave the prior range transaction readable and durable.
{
  const { harness, vfs } = openVfs();
  const accepted = bytes(CHUNK_SIZE + 5, 41);
  const replacement = bytes(2, 101);
  vfs.writeFile('race-nomem.bin', bytes(accepted.length, 5));
  vfs.writeRange('race-nomem.bin', 0, accepted);
  harness.failOnTransactionStatement(2, {
    transaction: null,
    repeat: true,
    error: new Error('SQLITE_NOMEM: persistent overlapping batch failure'),
  });
  assert.throws(() => vfs.writeBatch({
    inodes: [fileInode('race-nomem.bin', replacement.length)],
    chunks: fileChunks('race-nomem.bin', replacement),
  }), /SQLITE_NOMEM/);
  assert.deepEqual(vfs.readFile('race-nomem.bin'), accepted);
  harness.clearFault();
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('race-nomem.bin'), accepted);
}

// #7: a bounded range mutation is one atomic chunks+metadata transaction;
// a failing row cannot publish any of the edited chunks.
{
  const { harness, vfs } = openVfs();
  const data = bytes(CHUNK_SIZE * 2 + 11, 47);
  const durable = bytes(data.length, 7);
  vfs.writeFile('flush.bin', durable);
  const before = durableChunkIds(harness, 'flush.bin');
  harness.setFaultInjector(({ sql }) => (
    /^INSERT INTO vfs_content_chunks/.test(sql) ? new Error('injected persistent chunk failure') : null
  ));
  assert.throws(() => vfs.writeRange('flush.bin', 0, data), /injected persistent chunk failure/);
  assert.deepEqual(
    durableChunkIds(harness, 'flush.bin'),
    before,
    'failed range transaction must preserve the prior complete generation',
  );
  assert.deepEqual(vfs.readFile('flush.bin'), durable);

  harness.clearFault();
  vfs.writeRange('flush.bin', 0, data);
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('flush.bin'), data);
}

// Rename sees the already-durable range generation and moves only its inode.
{
  const { harness, vfs } = openVfs();
  const data = bytes(CHUNK_SIZE + 3, 53);
  vfs.writeFile('rename-pending.bin', bytes(data.length, 9));
  vfs.writeRange('rename-pending.bin', 0, data);
  vfs.rename('rename-pending.bin', 'renamed.bin');
  assert.equal(vfs.exists('rename-pending.bin'), false);
  assert.deepEqual(vfs.readFile('renamed.bin'), data);
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('renamed.bin'), data);
}

// File-to-directory replacement reclaims the old content generation.
{
  const { harness, vfs } = openVfs();
  vfs.writeFile('flip', bytes(7, 12));
  const [oldChunk] = durableChunkIds(harness, 'flip');
  vfs.writeBatch({
    inodes: [{
      path: 'flip', parentPath: '', isDir: true, size: 0,
      mtime: Date.now(), mode: 0o755, chunkCount: 0,
    }],
    chunks: [],
  });
  assert.equal(vfs.isDirectory('flip'), true);
  assert.equal(chunkExists(harness, oldChunk), false);
}

// #9: recursive deletePaths publication must keep live and reconstructed
// metadata, counters, and directory visibility identical.
{
  const { harness, rawVfs, vfs } = openVfs();
  vfs.mkdir('tree/nested', { recursive: true });
  vfs.writeFile('tree/a.txt', bytes(3, 1));
  vfs.writeFile('tree/nested/b.txt', bytes(5, 2));
  vfs.writeBatch({ inodes: [], chunks: [], deletePaths: ['tree'] });
  assert.equal(vfs.exists('tree'), false);
  assert.equal(vfs.exists('tree/a.txt'), false);
  assert.equal(vfs.exists('tree/nested'), false);
  assert.equal(vfs.exists('tree/nested/b.txt'), false);
  assert.equal(rawVfs._verifyCounters(), null);
  const { rawVfs: reconstructedRawVfs, vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(
    {
      inodes: rawVfs.getStats().inodes,
      files: rawVfs.getStats().files,
      directories: rawVfs.getStats().directories,
      usedBytes: rawVfs.getStats().usedBytes,
    },
    {
      inodes: reconstructedRawVfs.getStats().inodes,
      files: reconstructedRawVfs.getStats().files,
      directories: reconstructedRawVfs.getStats().directories,
      usedBytes: reconstructedRawVfs.getStats().usedBytes,
    },
  );
  assert.equal(reconstructed.exists('tree/nested/b.txt'), false);
  assert.deepEqual(vfs.readdir(''), reconstructed.readdir(''));
}

const recursiveDeleteStatementCount = (() => {
  const { harness, vfs } = openVfs();
  vfs.mkdir('count-tree/nested', { recursive: true });
  vfs.writeFile('count-tree/a.txt', bytes(3, 1));
  vfs.writeFile('count-tree/nested/b.txt', bytes(5, 2));
  const statementStart = harness.statements.length;
  vfs.writeBatch({ inodes: [], chunks: [], deletePaths: ['count-tree'] });
  const transaction = new Map();
  for (const statement of harness.statements.slice(statementStart)) {
    if (statement.transaction === null || !/DELETE FROM vfs_inodes/i.test(statement.sql)) continue;
    transaction.set(statement.transaction, true);
  }
  assert.equal(transaction.size, 1);
  const [id] = transaction.keys();
  return harness.statements.filter((statement) => statement.transaction === id).length;
})();

// A fault at every SQL statement of recursive deletion leaves the complete
// old subtree visible both live and after reconstruction.
for (let statement = 1; statement <= recursiveDeleteStatementCount; statement++) {
  const { harness, vfs } = openVfs();
  vfs.mkdir('rollback-tree/nested', { recursive: true });
  vfs.writeFile('rollback-tree/a.txt', bytes(3, 4));
  vfs.writeFile('rollback-tree/nested/b.txt', bytes(5, 6));
  const before = vfs.revision();
  harness.failOnTransactionStatement(statement);
  assert.throws(
    () => vfs.writeBatch({ inodes: [], chunks: [], deletePaths: ['rollback-tree'] }),
    /injected SQL fault/,
  );
  assert.equal(vfs.revision(), before);
  assert.deepEqual(vfs.readdir('rollback-tree'), [
    { name: 'a.txt', type: 'file' },
    { name: 'nested', type: 'directory' },
  ]);
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readdir('rollback-tree'), vfs.readdir('rollback-tree'));
  assert.deepEqual(reconstructed.readFile('rollback-tree/nested/b.txt'), bytes(5, 6));
}

// #10: a full-file batch replacement leaves none of the old content behind.
{
  const { harness, vfs } = openVfs();
  const oldData = bytes(CHUNK_SIZE + 9, 7);
  const newData = bytes(4, 19);
  vfs.writeFile('replace.bin', oldData);
  const oldChunks = durableChunkIds(harness, 'replace.bin');
  vfs.writeBatch({
    inodes: [fileInode('replace.bin', newData.length)],
    chunks: fileChunks('replace.bin', newData),
  });
  assert.equal(durableChunkIds(harness, 'replace.bin').length, 1);
  assert.ok(oldChunks.every((id) => !chunkExists(harness, id)), 'the replaced content is collected');
  assert.deepEqual(harness.sql.exec('SELECT id FROM vfs_contents'), []);
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('replace.bin'), newData);
}

// Any inode-backed replacement owns the path's complete resolved generation,
// including a directory replacing a file.
{
  const { harness, vfs } = openVfs();
  vfs.writeFile('orphan-to-dir', bytes(3, 73));
  const [oldChunk] = durableChunkIds(harness, 'orphan-to-dir');
  vfs.writeBatch({
    inodes: [{
      path: 'orphan-to-dir', parentPath: '', isDir: true, size: 0,
      mtime: Date.now(), mode: 0o755, chunkCount: 0,
    }],
    chunks: [],
  });
  assert.equal(chunkExists(harness, oldChunk), false);
  assert.equal(vfs.isDirectory('orphan-to-dir'), true);
}

// #11: cache ownership is isolated from caller input and public output.
{
  const { rawVfs, vfs } = openVfs();
  const backing = new Uint8Array(CHUNK_SIZE * 4);
  backing.set(bytes(11, 33), CHUNK_SIZE);
  const input = backing.subarray(CHUNK_SIZE, CHUNK_SIZE + 11);
  const expected = input.slice();
  vfs.writeFile('owned.bin', input);
  input.fill(255);
  assert.deepEqual(vfs.readFile('owned.bin'), expected, 'caller input mutation must not change cached bytes');
  const output = vfs.readFile('owned.bin');
  output.fill(0);
  assert.deepEqual(vfs.readFile('owned.bin'), expected, 'public read results must be defensive copies');
  const cached = [...rawVfs.cache.values()];
  assert.ok(cached.every((entry) => entry.buffer.byteLength === entry.byteLength));
  assert.equal(rawVfs.getStats().cache.hotBytes, cached.reduce((sum, entry) => sum + entry.byteLength, 0));
}

// #12: every chunk declared by an inode is required; corruption is EIO,
// never shifted or silently empty content.
{
  const { harness, vfs } = openVfs();
  const data = bytes(CHUNK_SIZE * 2 + 5, 51);
  vfs.writeFile('corrupt.bin', data);
  vfs.writeFile('single.bin', bytes(7, 91));
  harness.sql.exec('DELETE FROM vfs_chunks WHERE id = ?', durableChunkIds(harness, 'corrupt.bin')[1]);
  harness.sql.exec('DELETE FROM vfs_chunks WHERE id = ?', durableChunkIds(harness, 'single.bin')[0]);
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.throws(() => reconstructed.readFile('corrupt.bin'), /EIO: .*corrupt\.bin.*missing chunk/);
  assert.throws(() => reconstructed.readFile('single.bin'), /EIO: .*single\.bin.*missing chunk/);
}

// #14: overwrite-rename removes the overwritten file's bytes from counters.
{
  const { harness, rawVfs, vfs } = openVfs();
  const source = bytes(5, 1);
  vfs.writeFile('source.bin', source);
  vfs.writeFile('destination.bin', bytes(19, 2));
  vfs.rename('source.bin', 'destination.bin');
  assert.equal(rawVfs.getStats().usedBytes, source.length);
  assert.equal(rawVfs.getStats().files, 1);
  assert.equal(rawVfs._verifyCounters(), null);
  const { rawVfs: reconstructedRawVfs, vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.equal(reconstructedRawVfs.getStats().usedBytes, source.length);
  assert.deepEqual(reconstructed.readFile('destination.bin'), source);
}

// #16: synchronous path watchers observe the new revision during an event.
{
  const { rawVfs, vfs } = openVfs();
  const before = vfs.revision();
  let observedRevision = null;
  rawVfs.events.onPath('watched.bin', () => {
    observedRevision = vfs.revision('watched.bin');
  });
  const data = bytes(3, 5);
  vfs.writeBatch({
    inodes: [fileInode('watched.bin', data.length)],
    chunks: fileChunks('watched.bin', data),
  });
  assert.equal(vfs.revision(), before + 1);
  assert.equal(observedRevision, vfs.revision('watched.bin'));
}

// #21: nested limit reductions take effect immediately and every cache
// mutation leaves the cache within the current cap.
{
  const { rawVfs, vfs } = openVfs();
  for (let i = 0; i < 4; i++) {
    vfs.writeFile(`cache-${i}.bin`, bytes(3, i));
    vfs.readFile(`cache-${i}.bin`);
  }
  assert.equal(rawVfs.getStats().cache.entries, 4);
  rawVfs.shrinkForInstall(4);
  rawVfs.shrinkForInstall(1);
  assert.equal(rawVfs.getStats().cache.maxEntries, 1);
  assert.ok(rawVfs.getStats().cache.entries <= 1);
  assert.ok(rawVfs.getStats().cache.hotBytes <= CHUNK_SIZE);
}

// Pin the existing-entry update branch independently: an update must repair
// an already-over-cap cache instead of returning before eviction.
{
  const { rawVfs, vfs } = openVfs();
  for (let i = 0; i < 3; i++) {
    vfs.writeFile(`cache-update-${i}.bin`, bytes(3, i));
    vfs.readFile(`cache-update-${i}.bin`);
  }
  rawVfs._lruMaxEntries = 1;
  vfs.writeFile('cache-update-2.bin', bytes(4, 9));
  vfs.readFile('cache-update-2.bin');
  assert.ok(rawVfs.getStats().cache.entries <= 1);
}

// Renaming a directory carries its whole subtree and nothing else. Both the
// set that moves and the destination-conflict check are resolved from the
// children index, so a sibling whose name merely starts with the source or
// destination path must stay exactly where it is.
{
  const { harness, rawVfs, vfs } = openVfs();
  vfs.mkdir('src/lib/deep', { recursive: true });
  vfs.writeFile('src/lib/deep/a.txt', 'a');
  vfs.writeFile('src/top.txt', 'top');
  vfs.writeFile('srcfile.txt', 'sibling');
  vfs.mkdir('src-other', { recursive: true });
  vfs.writeFile('src-other/b.txt', 'b');
  vfs.writeFile('destfile.txt', 'dest sibling');

  vfs.rename('src', 'dest');

  const reconstructed = openVfs(createSqliteVfsTestHarness(harness.db)).vfs;
  assert.equal(reconstructed.exists('src'), false);
  assert.equal(reconstructed.readFileString('dest/lib/deep/a.txt'), 'a');
  assert.equal(reconstructed.readFileString('dest/top.txt'), 'top');
  assert.equal(reconstructed.readFileString('srcfile.txt'), 'sibling');
  assert.equal(reconstructed.readFileString('src-other/b.txt'), 'b');
  assert.equal(reconstructed.readFileString('destfile.txt'), 'dest sibling');
  assert.deepEqual(
    reconstructed.readdir('dest').map((entry) => entry.name).sort(),
    ['lib', 'top.txt'],
  );
  assert.equal(rawVfs._verifyCounters(), null);
}

// A destination whose subtree is already occupied is refused, and refused
// without mutating anything.
{
  const { rawVfs, vfs } = openVfs();
  vfs.mkdir('from/inner', { recursive: true });
  vfs.writeFile('from/inner/a.txt', 'a');
  vfs.mkdir('onto/inner', { recursive: true });
  vfs.writeFile('onto/inner/b.txt', 'b');

  assert.throws(() => vfs.rename('from', 'onto'), /ENOTEMPTY/);
  assert.equal(vfs.readFileString('from/inner/a.txt'), 'a');
  assert.equal(vfs.readFileString('onto/inner/b.txt'), 'b');
  assert.equal(rawVfs._verifyCounters(), null);
}

// Resolving those two subtrees must cost the subtrees, not the filesystem:
// an atomic write is `write temp; rename temp final`, and a whole-inode scan
// per call made every one of them cost the size of the tree it wrote into.
{
  const { harness, rawVfs, vfs } = openVfs();
  vfs.mkdir('bulk', { recursive: true });
  for (let i = 0; i < 400; i++) vfs.writeFile(`bulk/file-${i}.js`, 'x');
  vfs.writeFile('atomic.tmp', 'payload');

  const from = harness.statements.length;
  vfs.rename('atomic.tmp', 'bulk/final.js');
  assert.deepEqual(inodeTableScans(harness, from), [], 'rename read the whole inode table');
  assert.equal(vfs.readFileString('bulk/final.js'), 'payload');
  assert.equal(vfs.exists('atomic.tmp'), false);
  assert.equal(rawVfs._verifyCounters(), null);
}

console.log('sqlite-vfs-stage1-integrity: all assertions passed');
