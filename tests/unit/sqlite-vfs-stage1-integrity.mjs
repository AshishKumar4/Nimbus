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

function resolvedContentId(harness, path) {
  const rows = harness.sql.exec('SELECT path, content_id FROM inodes WHERE path = ?', path);
  assert.equal(rows.length, 1, `expected one inode for ${path}`);
  return rows[0].content_id ?? rows[0].path;
}

function durableChunkIds(harness, path) {
  const id = resolvedContentId(harness, path);
  return harness.sql.exec(
    'SELECT chunk_id FROM file_chunks WHERE content_id = ? ORDER BY chunk_id',
    id,
  );
}

function statementHasChunk(sql, params, contentId, chunkId) {
  if (!sql.startsWith('INSERT OR REPLACE INTO file_chunks')) return false;
  for (let index = 0; index < params.length; index += 3) {
    if (params[index] === contentId && (chunkId === undefined || params[index + 1] === chunkId)) {
      return true;
    }
  }
  return false;
}

function latestTransactionStatementCount(harness, transactionStart) {
  const transaction = harness.transactionCount;
  assert.ok(transaction > transactionStart, 'expected a new transaction');
  return harness.statements.filter((statement) => statement.transaction === transaction).length;
}

// Legacy boolean inode types must never be silently reinterpreted as symlinks,
// and upgraded schemas must enforce the expanded durable kind domain.
{
  const invalid = createSqliteVfsTestHarness();
  invalid.sql.exec(`CREATE TABLE inodes (
    path TEXT PRIMARY KEY, parent_path TEXT NOT NULL DEFAULT '',
    is_dir INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
    atime INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0,
    mode INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0,
    content_id TEXT NULL
  )`);
  invalid.sql.exec("INSERT INTO inodes (path, is_dir) VALUES ('ambiguous', 2)");
  assert.throws(() => new SqliteVFS(invalid.sql, invalid.ctx), /invalid legacy inode kind 2/);

  const upgraded = createSqliteVfsTestHarness();
  upgraded.sql.exec(`CREATE TABLE inodes (
    path TEXT PRIMARY KEY, parent_path TEXT NOT NULL DEFAULT '',
    is_dir INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
    atime INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0,
    mode INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0,
    content_id TEXT NULL
  )`);
  new SqliteVFS(upgraded.sql, upgraded.ctx);
  assert.throws(
    () => upgraded.sql.exec("INSERT INTO inodes (path, kind) VALUES ('invalid', 7)"),
    /invalid inode kind/,
  );

  const parentHarness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(parentHarness.sql, parentHarness.ctx);
  assert.throws(() => vfs.writeBatch({
    inodes: [{ ...fileInode('child', 0), parentPath: 'wrong-parent' }],
    chunks: [],
  }), /parentPath wrong-parent does not match/);
}

const strictCreateStatementCount = (() => {
  const { harness, vfs } = openVfs();
  const start = harness.transactionCount;
  const data = bytes(5, 1);
  vfs.writeBatch({
    inodes: [fileInode('strict-count.bin', data.length)],
    chunks: chunks('strict-count.bin', data),
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
    chunks: chunks('rollback.bin', data),
  }), /injected SQL fault/);
  assert.equal(vfs.revision(), revision);
  assert.equal(vfs.exists('rollback.bin'), false);
  assert.deepEqual(harness.sql.exec("SELECT path FROM inodes WHERE path = 'rollback.bin'"), []);
  assert.deepEqual(harness.sql.exec("SELECT content_id FROM file_chunks WHERE content_id LIKE '/content:%'"), []);
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
    chunks: chunks('replace-count.bin', data),
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
  assert.deepEqual(harness.sql.exec("SELECT content_id FROM file_chunks WHERE content_id LIKE '/content:%'"), []);
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
    chunks: [...chunks('a.bin', a), ...chunks('b.bin', b)],
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
    chunks: chunks('one.bin', data),
  }), { inodes: 1, chunks: 2 });
  assert.equal(vfs.revision(), revision + 1);
  assert.deepEqual(vfs.readFile('one.bin'), data);
  const durableInodes = harness.sql.exec("SELECT path FROM inodes WHERE path = 'one.bin'");
  const durableChunks = durableChunkIds(harness, 'one.bin');
  assert.deepEqual(durableInodes, [{ path: 'one.bin' }]);
  assert.deepEqual(durableChunks, [{ chunk_id: 0 }, { chunk_id: 1 }]);
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
    chunks: chunks('race.bin', replacement),
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
    chunks: chunks('race-nomem.bin', replacement),
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
  const id = resolvedContentId(harness, 'flush.bin');
  harness.setFaultInjector(({ sql, params }) => {
    if (statementHasChunk(sql, params, id, 1)) {
      return new Error('injected persistent chunk failure');
    }
    return null;
  });
  assert.throws(() => vfs.writeRange('flush.bin', 0, data), /injected persistent chunk failure/);
  assert.deepEqual(
    durableChunkIds(harness, 'flush.bin'),
    [{ chunk_id: 0 }, { chunk_id: 1 }, { chunk_id: 2 }],
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
  const oldContentId = resolvedContentId(harness, 'flip');
  vfs.writeBatch({
    inodes: [{
      path: 'flip', parentPath: '', isDir: true, size: 0,
      mtime: Date.now(), mode: 0o755, chunkCount: 0,
    }],
    chunks: [],
  });
  assert.equal(vfs.isDirectory('flip'), true);
  assert.deepEqual(
    harness.sql.exec('SELECT chunk_id FROM file_chunks WHERE content_id = ?', oldContentId),
    [],
  );
}

// #9: recursive deletePaths publication must keep live and reconstructed
// metadata, counters, and directory visibility identical.
{
  const { harness, vfs } = openVfs();
  vfs.mkdir('tree/nested', { recursive: true });
  vfs.writeFile('tree/a.txt', bytes(3, 1));
  vfs.writeFile('tree/nested/b.txt', bytes(5, 2));
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
    if (statement.transaction === null || !/DELETE FROM inodes/i.test(statement.sql)) continue;
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

// #10: a full-file batch replacement must remove stale trailing chunk rows.
{
  const { harness, vfs } = openVfs();
  const oldData = bytes(CHUNK_SIZE + 9, 7);
  const newData = bytes(4, 19);
  vfs.writeFile('replace.bin', oldData);
  vfs.writeBatch({
    inodes: [fileInode('replace.bin', newData.length)],
    chunks: chunks('replace.bin', newData),
  });
  assert.deepEqual(
    durableChunkIds(harness, 'replace.bin'),
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
  const first = bytes(CHUNK_SIZE, 88);
  vfs.writeBatch({
    inodes: [],
    chunks: [{ path: 'range-only.bin', chunkId: 0, data: first }],
  });
  assert.deepEqual(
    durableChunkIds(harness, 'range-only.bin'),
    [{ chunk_id: 0 }, { chunk_id: 1 }],
  );
  const { vfs: reconstructed } = openVfs(createSqliteVfsTestHarness(harness.db));
  assert.deepEqual(reconstructed.readFile('range-only.bin'), new Uint8Array([...first, ...data.slice(CHUNK_SIZE)]));
}

// Any inode-backed replacement owns the path's complete resolved generation,
// including a directory replacing a file.
{
  const { harness, vfs } = openVfs();
  vfs.writeFile('orphan-to-dir', bytes(3, 73));
  const oldContentId = resolvedContentId(harness, 'orphan-to-dir');
  vfs.writeBatch({
    inodes: [{
      path: 'orphan-to-dir', parentPath: '', isDir: true, size: 0,
      mtime: Date.now(), mode: 0o755, chunkCount: 0,
    }],
    chunks: [],
  });
  assert.deepEqual(
    harness.sql.exec('SELECT chunk_id FROM file_chunks WHERE content_id = ?', oldContentId),
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
  harness.sql.exec(
    'DELETE FROM file_chunks WHERE content_id = ? AND chunk_id = 1',
    resolvedContentId(harness, 'corrupt.bin'),
  );
  harness.sql.exec(
    'DELETE FROM file_chunks WHERE content_id = ? AND chunk_id = 0',
    resolvedContentId(harness, 'single.bin'),
  );
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

// Legacy migration now uses bounded staging + publish transactions. A reset at
// each durable phase may leave invisible staging or an already-complete inode,
// but reopening must deterministically converge before the source is dropped.
for (const faultCase of [
  {
    name: 'stage marker',
    matches: ({ sql, params }) => /INSERT OR IGNORE INTO content_lifecycle/i.test(sql)
      && params.includes('atomic.txt'),
  },
  {
    name: 'chunk stage',
    matches: ({ sql, params }) => /INSERT OR REPLACE INTO file_chunks/i.test(sql)
      && params.includes('atomic.txt'),
  },
  {
    name: 'inode publish',
    matches: ({ sql, params }) => /INSERT OR REPLACE INTO inodes/i.test(sql)
      && params.includes('atomic.txt'),
  },
  {
    name: 'migration marker',
    matches: ({ sql }) => /INSERT INTO vfs_schema_migrations/i.test(sql)
      && /legacy_fs_objects_v1/i.test(sql),
  },
  {
    name: 'source drop',
    matches: ({ sql }) => /DROP TABLE fs_objects/i.test(sql),
  },
]) {
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
  const data = bytes(4, faultCase.name.length);
  harness.sql.exec(
    'INSERT INTO fs_objects VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'atomic.txt', 0, '', data, 0, data.length, 1234, 0o644,
  );
  let injected = false;
  harness.setFaultInjector((statement) => {
    if (!injected && faultCase.matches(statement)) {
      injected = true;
      return new Error(`injected legacy migration reset at ${faultCase.name}`);
    }
    return null;
  });
  assert.throws(() => openVfs(harness), /injected legacy migration reset/);
  assert.equal(injected, true, `fault seam not reached: ${faultCase.name}`);
  assert.deepEqual(
    harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fs_objects'"),
    [{ name: 'fs_objects' }],
  );
  harness.clearFault();
  const { vfs } = openVfs(harness);
  assert.deepEqual(vfs.readFile('atomic.txt'), data);
  assert.deepEqual(
    harness.sql.exec("SELECT id FROM vfs_schema_migrations WHERE id = 'legacy_fs_objects_v1'"),
    [{ id: 'legacy_fs_objects_v1' }],
  );
  assert.deepEqual(
    harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fs_objects'"),
    [],
  );
  assert.deepEqual(openVfs(createSqliteVfsTestHarness(harness.db)).vfs.readFile('atomic.txt'), data);
}

// #14: overwrite-rename removes the overwritten file's bytes from counters.
{
  const { harness, vfs } = openVfs();
  const source = bytes(5, 1);
  vfs.writeFile('source.bin', source);
  vfs.writeFile('destination.bin', bytes(19, 2));
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
  for (let i = 0; i < 4; i++) {
    vfs.writeFile(`cache-${i}.bin`, bytes(3, i));
    vfs.readFile(`cache-${i}.bin`);
  }
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
  for (let i = 0; i < 3; i++) {
    vfs.writeFile(`cache-update-${i}.bin`, bytes(3, i));
    vfs.readFile(`cache-update-${i}.bin`);
  }
  vfs._lruMaxEntries = 1;
  vfs.writeFile('cache-update-2.bin', bytes(4, 9));
  vfs.readFile('cache-update-2.bin');
  assert.ok(vfs.getStats().cache.entries <= 1);
}

console.log('sqlite-vfs-stage1-integrity: all assertions passed');
