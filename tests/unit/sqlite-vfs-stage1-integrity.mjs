#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { CHUNK_SIZE } from '../../packages/worker/src/constants.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

function openVfs(harness = createSqliteVfsTestHarness()) {
  return { harness, vfs: new SqliteVFS(harness.sql, harness.ctx) };
}

function fileInode(path, size, mtime = Date.now()) {
  return {
    path,
    parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    isDir: false,
    size,
    mtime,
    mode: 0o644,
    chunkCount: size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE),
  };
}

function bytes(length, seed = 0) {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = (i + seed) % 251;
  return data;
}

function chunks(path, data) {
  const result = [];
  for (let chunkId = 0; chunkId * CHUNK_SIZE < data.length; chunkId++) {
    result.push({
      path,
      chunkId,
      data: data.slice(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE),
    });
  }
  return result;
}

// The strict full-file batch below executes exactly three statements:
// delete old chunks, publish the inode, and publish its chunk rows. A fault at
// every position must leave both live and durable state unchanged.
for (let statement = 1; statement <= 3; statement++) {
  const { harness, vfs } = openVfs();
  const data = bytes(5, statement);
  const revision = vfs.revision();
  harness.failOnTransactionStatement(statement);
  assert.throws(() => vfs.writeBatch({
    inodes: [fileInode('rollback.bin', data.length)],
    chunks: chunks('rollback.bin', data),
  }), /injected SQL fault/);
  assert.equal(vfs.revision(), revision);
  assert.equal(vfs.exists('rollback.bin'), false);
  assert.deepEqual(harness.sql.exec("SELECT path FROM inodes WHERE path = 'rollback.bin'"), []);
  assert.deepEqual(harness.sql.exec("SELECT path FROM file_chunks WHERE path = 'rollback.bin'"), []);
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.equal(reconstructed.exists('rollback.bin'), false);
}

// Atomic APIs fail before mutation when transactionSync is unavailable.
{
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql);
  const data = bytes(3, 7);
  assert.throws(() => vfs.writeBatch({
    inodes: [fileInode('no-transaction.bin', data.length)],
    chunks: chunks('no-transaction.bin', data),
  }), /requires transactionSync/);
  assert.deepEqual(harness.sql.exec("SELECT path FROM inodes WHERE path = 'no-transaction.bin'"), []);
}

// Full-file replacement remains complete-old on a fault after its old chunks
// have been deleted inside the transaction.
for (let statement = 1; statement <= 3; statement++) {
  const { harness, vfs } = openVfs();
  const oldData = bytes(CHUNK_SIZE + 7, 21);
  const newData = bytes(5, 81);
  vfs.writeFile('atomic-replace.bin', oldData);
  vfs.flushAll();
  const revision = vfs.revision();
  harness.failOnTransactionStatement(statement);
  assert.throws(() => vfs.writeBatch({
    inodes: [fileInode('atomic-replace.bin', newData.length)],
    chunks: chunks('atomic-replace.bin', newData),
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
    chunks: chunks('never-visible.bin', data),
  }), /SQLITE_NOMEM/);
  assert.equal(vfs.revision(), revision);
  assert.equal(vfs.exists('never-visible.bin'), false);
  assert.deepEqual(harness.sql.exec("SELECT path FROM inodes WHERE path = 'never-visible.bin'"), []);
  assert.deepEqual(harness.sql.exec("SELECT path FROM file_chunks WHERE path = 'never-visible.bin'"), []);
}

// #4: a SQLITE_NOMEM retry must rerun the same strict transaction, never
// commit a first half before a later half fails.
{
  const { harness, vfs } = openVfs();
  const a = bytes(3, 1);
  const b = bytes(3, 9);
  harness.setFaultInjector(({ transaction, transactionStatement }) => {
    if (transaction === 1 && transactionStatement === 2) {
      return new Error('SQLITE_NOMEM: injected whole-batch failure');
    }
    if (transaction === 3 && transactionStatement === 1) {
      return new Error('injected second-half failure');
    }
    return null;
  });
  const revision = vfs.revision();
  const result = vfs.writeBatch({
    inodes: [fileInode('a.bin', a.length), fileInode('b.bin', b.length)],
    chunks: [...chunks('a.bin', a), ...chunks('b.bin', b)],
  });
  assert.deepEqual(result, { inodes: 2, chunks: 2 });
  assert.equal(vfs.revision(), revision + 1, 'successful strict retry must tick once');
  assert.deepEqual(vfs.readFile('a.bin'), a);
  assert.deepEqual(vfs.readFile('b.bin'), b);
  assert.equal(harness.transactionCount, 2, 'strict retry must execute the same transaction once more');
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
    chunks: chunks('one.bin', data),
  }), { inodes: 1, chunks: 2 });
  assert.equal(vfs.revision(), revision + 1);
  assert.deepEqual(vfs.readFile('one.bin'), data);
  const durableInodes = harness.sql.exec("SELECT path FROM inodes WHERE path = 'one.bin'");
  const durableChunks = harness.sql.exec("SELECT chunk_id FROM file_chunks WHERE path = 'one.bin' ORDER BY chunk_id");
  assert.deepEqual(durableInodes, [{ path: 'one.bin' }]);
  assert.deepEqual(durableChunks, [{ chunk_id: 0 }, { chunk_id: 1 }]);
}

// #6: a failed batch must preserve a previously accepted deferred write.
{
  const { harness, vfs } = openVfs();
  const accepted = bytes(CHUNK_SIZE + 5, 31);
  const replacement = bytes(2, 99);
  vfs.writeFile('race.bin', accepted);
  const pendingBefore = vfs.getStats().sql.pendingWriteBytes;
  harness.failOnTransactionStatement(1);
  assert.throws(() => vfs.writeBatch({
    inodes: [fileInode('race.bin', replacement.length)],
    chunks: chunks('race.bin', replacement),
  }), /injected SQL fault/);
  assert.deepEqual(vfs.readFile('race.bin'), accepted);
  assert.equal(vfs.getStats().sql.pendingWriteBytes, pendingBefore);
  vfs.flushAll();
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('race.bin'), accepted);
}

// The SQLITE_NOMEM retry evicts the disposable cache. A second failure must
// still leave the accepted pending bytes readable and retryable.
{
  const { harness, vfs } = openVfs();
  const accepted = bytes(CHUNK_SIZE + 5, 41);
  const replacement = bytes(2, 101);
  vfs.writeFile('race-nomem.bin', accepted);
  const pendingBefore = vfs.getStats().sql.pendingWriteBytes;
  harness.failOnTransactionStatement(2, {
    transaction: null,
    repeat: true,
    error: new Error('SQLITE_NOMEM: persistent overlapping batch failure'),
  });
  assert.throws(() => vfs.writeBatch({
    inodes: [fileInode('race-nomem.bin', replacement.length)],
    chunks: chunks('race-nomem.bin', replacement),
  }), /SQLITE_NOMEM/);
  assert.deepEqual(vfs.readFile('race-nomem.bin'), accepted);
  assert.equal(vfs.getStats().sql.pendingWriteBytes, pendingBefore);
  harness.clearFault();
  vfs.flushAll();
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('race-nomem.bin'), accepted);
}

// #7: a permanently failing row cannot commit the other chunks of its file;
// all bytes remain retryable and the durability boundary fails loudly.
{
  const { harness, vfs } = openVfs();
  const data = bytes(CHUNK_SIZE * 2 + 11, 47);
  vfs.writeFile('flush.bin', data);
  harness.setFaultInjector(({ sql, params }) => {
    if (sql.startsWith('INSERT OR REPLACE INTO file_chunks') && params[0] === 'flush.bin' && params[1] === 1) {
      return new Error('injected persistent chunk failure');
    }
    return null;
  });
  assert.throws(() => vfs.flushAll(), /flushAll: .*write\(s\) failed permanently/);
  assert.deepEqual(
    harness.sql.exec("SELECT chunk_id FROM file_chunks WHERE path = 'flush.bin' ORDER BY chunk_id"),
    [],
    'an indivisible file must have no durable chunk subset',
  );
  assert.equal(vfs.getStats().sql.pendingWriteBytes, data.length, 'failed file bytes must remain retryable');

  harness.clearFault();
  vfs.flushAll();
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('flush.bin'), data);
}

// Rename is a durability boundary: it must stop before changing paths when
// accepted source bytes cannot be flushed, then remain retryable.
{
  const { harness, vfs } = openVfs();
  const data = bytes(CHUNK_SIZE + 3, 53);
  vfs.writeFile('rename-pending.bin', data);
  harness.setFaultInjector(({ sql, params }) => (
    sql.startsWith('INSERT OR REPLACE INTO file_chunks') && params[0] === 'rename-pending.bin'
      ? new Error('injected rename flush failure')
      : null
  ));
  assert.throws(() => vfs.rename('rename-pending.bin', 'renamed.bin'), /flushAll: .*write\(s\) failed permanently/);
  assert.equal(vfs.exists('rename-pending.bin'), true);
  assert.equal(vfs.exists('renamed.bin'), false);
  assert.deepEqual(vfs.readFile('rename-pending.bin'), data);
  assert.ok(vfs.getStats().sql.pendingWriteBytes > 0);
  harness.clearFault();
  vfs.flushAll();
  vfs.rename('rename-pending.bin', 'renamed.bin');
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('renamed.bin'), data);
}

// A successful non-batch supersession owns and clears obsolete failure state.
{
  const { harness, vfs } = openVfs();
  vfs.writeFile('failed-then-removed.bin', bytes(7, 61));
  harness.setFaultInjector(({ sql, params }) => (
    sql.startsWith('INSERT OR REPLACE INTO file_chunks') && params[0] === 'failed-then-removed.bin'
      ? new Error('injected obsolete failure marker')
      : null
  ));
  assert.throws(() => vfs.flushAll(), /flushAll: .*write\(s\) failed permanently/);
  harness.clearFault();
  vfs.unlink('failed-then-removed.bin');
  assert.doesNotThrow(() => vfs.flushAll());

  vfs.writeFile('failed-then-empty.bin', bytes(7, 67));
  harness.setFaultInjector(({ sql, params }) => (
    sql.startsWith('INSERT OR REPLACE INTO file_chunks') && params[0] === 'failed-then-empty.bin'
      ? new Error('injected obsolete replacement marker')
      : null
  ));
  assert.throws(() => vfs.flushAll(), /flushAll: .*write\(s\) failed permanently/);
  harness.clearFault();
  vfs.writeFile('failed-then-empty.bin', new Uint8Array(0));
  assert.doesNotThrow(() => vfs.flushAll());
}

// A successful batch supersession clears retained pending bytes and their
// failure markers for the same path.
{
  const { harness, vfs } = openVfs();
  const first = bytes(CHUNK_SIZE + 3, 9);
  vfs.writeFile('recovered.bin', first);
  harness.setFaultInjector(({ sql, params }) => {
    if (sql.startsWith('INSERT OR REPLACE INTO file_chunks') && params[0] === 'recovered.bin') {
      return new Error('injected persistent recovery failure');
    }
    return null;
  });
  assert.throws(() => vfs.flushAll(), /failed permanently/);
  harness.clearFault();
  const replacement = bytes(4, 44);
  vfs.writeBatch({
    inodes: [fileInode('recovered.bin', replacement.length)],
    chunks: chunks('recovered.bin', replacement),
  });
  assert.doesNotThrow(() => vfs.flushAll());
  assert.deepEqual(vfs.readFile('recovered.bin'), replacement);
}

// File-to-directory replacement clears old chunks and pending ownership.
{
  const { harness, vfs } = openVfs();
  vfs.writeFile('flip', bytes(7, 12));
  vfs.writeBatch({
    inodes: [{
      path: 'flip', parentPath: '', isDir: true, size: 0,
      mtime: Date.now(), mode: 0o755, chunkCount: 0,
    }],
    chunks: [],
  });
  assert.equal(vfs.isDirectory('flip'), true);
  assert.equal(vfs.getStats().sql.pendingWrites, 0);
  vfs.flushAll();
  assert.deepEqual(harness.sql.exec("SELECT chunk_id FROM file_chunks WHERE path = 'flip'"), []);
}

// #9: recursive deletePaths publication must keep live and reconstructed
// metadata, counters, and directory visibility identical.
{
  const { harness, vfs } = openVfs();
  vfs.mkdir('tree/nested', { recursive: true });
  vfs.writeFile('tree/a.txt', bytes(3, 1));
  vfs.writeFile('tree/nested/b.txt', bytes(5, 2));
  vfs.flushAll();
  harness.sql.exec(
    "INSERT INTO file_chunks (path, chunk_id, data) VALUES ('tree/orphan.bin', 0, ?)",
    bytes(2, 99),
  );
  vfs.writeBatch({ inodes: [], chunks: [], deletePaths: ['tree'] });
  assert.equal(vfs.exists('tree'), false);
  assert.equal(vfs.exists('tree/a.txt'), false);
  assert.equal(vfs.exists('tree/nested'), false);
  assert.equal(vfs.exists('tree/nested/b.txt'), false);
  assert.equal(vfs._verifyCounters(), null);
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(
    {
      inodes: vfs.getStats().inodes,
      files: vfs.getStats().files,
      directories: vfs.getStats().directories,
      usedBytes: vfs.getStats().usedBytes,
    },
    {
      inodes: reconstructed.getStats().inodes,
      files: reconstructed.getStats().files,
      directories: reconstructed.getStats().directories,
      usedBytes: reconstructed.getStats().usedBytes,
    },
  );
  assert.equal(reconstructed.exists('tree/nested/b.txt'), false);
  assert.deepEqual(
    harness.sql.exec("SELECT path FROM file_chunks WHERE path = 'tree/orphan.bin'"),
    [],
  );
  assert.deepEqual(vfs.readdir(''), reconstructed.readdir(''));
}


// A fault at every SQL statement of recursive deletion leaves the complete
// old subtree visible both live and after reconstruction.
for (let statement = 1; statement <= 8; statement++) {
  const { harness, vfs } = openVfs();
  vfs.mkdir('rollback-tree/nested', { recursive: true });
  vfs.writeFile('rollback-tree/a.txt', bytes(3, 4));
  vfs.writeFile('rollback-tree/nested/b.txt', bytes(5, 6));
  vfs.flushAll();
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

// #10: a full-file batch replacement must remove stale trailing chunk rows.
{
  const { harness, vfs } = openVfs();
  const oldData = bytes(CHUNK_SIZE + 9, 7);
  const newData = bytes(4, 19);
  vfs.writeFile('replace.bin', oldData);
  vfs.flushAll();
  vfs.writeBatch({
    inodes: [fileInode('replace.bin', newData.length)],
    chunks: chunks('replace.bin', newData),
  });
  assert.deepEqual(
    harness.sql.exec("SELECT chunk_id FROM file_chunks WHERE path = 'replace.bin' ORDER BY chunk_id"),
    [{ chunk_id: 0 }],
  );
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('replace.bin'), newData);
}

// A chunks-only batch is a range-style mutation and must preserve untouched
// rows; the full-file stale-row cleanup is inode-backed only.
{
  const { harness, vfs } = openVfs();
  const data = bytes(CHUNK_SIZE + 9, 14);
  vfs.writeFile('range-only.bin', data);
  vfs.flushAll();
  const first = bytes(CHUNK_SIZE, 88);
  vfs.writeBatch({
    inodes: [],
    chunks: [{ path: 'range-only.bin', chunkId: 0, data: first }],
  });
  assert.deepEqual(
    harness.sql.exec("SELECT chunk_id FROM file_chunks WHERE path = 'range-only.bin' ORDER BY chunk_id"),
    [{ chunk_id: 0 }, { chunk_id: 1 }],
  );
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('range-only.bin'), new Uint8Array([...first, ...data.slice(CHUNK_SIZE)]));
}

// Any inode-backed replacement owns the path's complete content, including a
// directory inode replacing historical orphan chunk rows.
{
  const { harness, vfs } = openVfs();
  harness.sql.exec(
    "INSERT INTO file_chunks (path, chunk_id, data) VALUES (?, ?, ?)",
    'orphan-to-dir', 0, bytes(3, 73),
  );
  vfs.writeBatch({
    inodes: [{
      path: 'orphan-to-dir', parentPath: '', isDir: true, size: 0,
      mtime: Date.now(), mode: 0o755, chunkCount: 0,
    }],
    chunks: [],
  });
  assert.deepEqual(
    harness.sql.exec("SELECT chunk_id FROM file_chunks WHERE path = 'orphan-to-dir'"),
    [],
  );
  assert.equal(vfs.isDirectory('orphan-to-dir'), true);
}

// #11: cache ownership is isolated from caller input and public output.
{
  const { vfs } = openVfs();
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
  const cached = [...vfs.cache.values()];
  assert.ok(cached.every((entry) => entry.data.buffer.byteLength === entry.data.byteLength));
  assert.equal(vfs.getStats().cache.hotBytes, cached.reduce((sum, entry) => sum + entry.data.byteLength, 0));
}

// #12: every chunk declared by an inode is required; corruption is EIO,
// never shifted or silently empty content.
{
  const { harness, vfs } = openVfs();
  const data = bytes(CHUNK_SIZE * 2 + 5, 51);
  vfs.writeFile('corrupt.bin', data);
  vfs.writeFile('single.bin', bytes(7, 91));
  vfs.flushAll();
  harness.sql.exec("DELETE FROM file_chunks WHERE path = 'corrupt.bin' AND chunk_id = 1");
  harness.sql.exec("DELETE FROM file_chunks WHERE path = 'single.bin' AND chunk_id = 0");
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.throws(() => reconstructed.readFile('corrupt.bin'), /EIO: .*corrupt\.bin.*chunk 1/);
  assert.throws(() => reconstructed.readFile('single.bin'), /EIO: .*single\.bin.*chunk 0/);
}

// #13: a non-empty legacy database migrates only after the target schema
// exists, and records the migration atomically before dropping the source.
{
  const harness = createSqliteVfsTestHarness();
  harness.sql.exec(`CREATE TABLE fs_objects (
    path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    parent_path TEXT NOT NULL,
    data BLOB,
    is_dir INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    mode INTEGER NOT NULL,
    PRIMARY KEY (path, chunk_index)
  )`);
  const legacyBytes = bytes(9, 73);
  harness.sql.exec(
    'INSERT INTO fs_objects VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'legacy.txt', 0, '', legacyBytes, 0, legacyBytes.length, 1234, 0o644,
  );
  const { vfs } = openVfs(harness);
  assert.deepEqual(vfs.readFile('legacy.txt'), legacyBytes);
  assert.deepEqual(harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fs_objects'"), []);
  assert.deepEqual(
    harness.sql.exec("SELECT id FROM vfs_schema_migrations WHERE id = 'legacy_fs_objects_v1'"),
    [{ id: 'legacy_fs_objects_v1' }],
  );
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('legacy.txt'), legacyBytes);
}

// Legacy 1.8 MB row boundaries are reassembled before 64 KiB rechunking.
{
  const harness = createSqliteVfsTestHarness();
  harness.sql.exec(`CREATE TABLE fs_objects (
    path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    parent_path TEXT NOT NULL,
    data BLOB,
    is_dir INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    mode INTEGER NOT NULL,
    PRIMARY KEY (path, chunk_index)
  )`);
  const legacyChunkSize = 1_800_000;
  const data = bytes(legacyChunkSize + 10, 27);
  harness.sql.exec(
    'INSERT INTO fs_objects VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'legacy-large.bin', 0, '', data.slice(0, legacyChunkSize), 0, data.length, 4321, 0o644,
  );
  harness.sql.exec(
    'INSERT INTO fs_objects VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'legacy-large.bin', 1, '', data.slice(legacyChunkSize), 0, data.length, 4321, 0o644,
  );
  const { vfs } = openVfs(harness);
  assert.deepEqual(vfs.readFile('legacy-large.bin'), data);
}

// Every statement in the legacy migration transaction rolls back together.
for (let statement = 1; statement <= 6; statement++) {
  const harness = createSqliteVfsTestHarness();
  harness.sql.exec(`CREATE TABLE fs_objects (
    path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    parent_path TEXT NOT NULL,
    data BLOB,
    is_dir INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    mode INTEGER NOT NULL,
    PRIMARY KEY (path, chunk_index)
  )`);
  const data = bytes(4, statement);
  harness.sql.exec(
    'INSERT INTO fs_objects VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'atomic.txt', 0, '', data, 0, data.length, 1234, 0o644,
  );
  harness.failOnTransactionStatement(statement);
  assert.throws(() => openVfs(harness), /injected SQL fault/);
  assert.deepEqual(harness.sql.exec("SELECT path FROM inodes WHERE path = 'atomic.txt'"), []);
  assert.deepEqual(harness.sql.exec("SELECT path FROM file_chunks WHERE path = 'atomic.txt'"), []);
  assert.deepEqual(
    harness.sql.exec("SELECT id FROM vfs_schema_migrations WHERE id = 'legacy_fs_objects_v1'"),
    [],
  );
  assert.deepEqual(
    harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fs_objects'"),
    [{ name: 'fs_objects' }],
  );
  harness.clearFault();
  const { vfs } = openVfs(harness);
  assert.deepEqual(vfs.readFile('atomic.txt'), data);
}

// #14: overwrite-rename removes the overwritten file's bytes from counters.
{
  const { harness, vfs } = openVfs();
  const source = bytes(5, 1);
  vfs.writeFile('source.bin', source);
  vfs.writeFile('destination.bin', bytes(19, 2));
  vfs.flushAll();
  vfs.rename('source.bin', 'destination.bin');
  assert.equal(vfs.getStats().usedBytes, source.length);
  assert.equal(vfs.getStats().files, 1);
  assert.equal(vfs._verifyCounters(), null);
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.equal(reconstructed.getStats().usedBytes, source.length);
  assert.deepEqual(reconstructed.readFile('destination.bin'), source);
}

// #16: synchronous path watchers observe the new revision during an event.
{
  const { vfs } = openVfs();
  const before = vfs.revision();
  let observedRevision = null;
  vfs.events.onPath('watched.bin', () => {
    observedRevision = vfs.revision('watched.bin');
  });
  const data = bytes(3, 5);
  vfs.writeBatch({
    inodes: [fileInode('watched.bin', data.length)],
    chunks: chunks('watched.bin', data),
  });
  assert.equal(vfs.revision(), before + 1);
  assert.equal(observedRevision, vfs.revision('watched.bin'));
}

// #21: nested limit reductions take effect immediately and every cache
// mutation leaves the cache within the current cap.
{
  const { vfs } = openVfs();
  for (let i = 0; i < 4; i++) vfs.writeFile(`cache-${i}.bin`, bytes(3, i));
  assert.equal(vfs.getStats().cache.entries, 4);
  vfs.shrinkForInstall(4);
  vfs.shrinkForInstall(1);
  assert.equal(vfs.getStats().cache.maxEntries, 1);
  assert.ok(vfs.getStats().cache.entries <= 1);
  assert.ok(vfs.getStats().cache.hotBytes <= CHUNK_SIZE);
}

// Pin the existing-entry update branch independently: an update must repair
// an already-over-cap cache instead of returning before eviction.
{
  const { vfs } = openVfs();
  for (let i = 0; i < 3; i++) vfs.writeFile(`cache-update-${i}.bin`, bytes(3, i));
  vfs._lruMaxEntries = 1;
  vfs.writeFile('cache-update-2.bin', bytes(4, 9));
  assert.ok(vfs.getStats().cache.entries <= 1);
}

console.log('sqlite-vfs-stage1-integrity: all assertions passed');
