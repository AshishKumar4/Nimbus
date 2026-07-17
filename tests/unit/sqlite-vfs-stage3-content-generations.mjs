#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  CHUNK_SIZE,
  MAX_TX_BLOB_BYTES,
  MAX_TX_LOGICAL_ROWS,
  MAX_TX_SQL_EXECS,
} from '../../packages/worker/src/constants.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { encodeWriteBatchStream } from '../../packages/worker/src/_shared/w7-frame.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

function openVfs(harness = createSqliteVfsTestHarness()) {
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, rawVfs, vfs: rawVfs.as(CRED_KERNEL) };
}

function reopenVfs(harness) {
  return openVfs(createSqliteVfsTestHarness(harness.db)).vfs;
}

function bytes(length, seed = 0) {
  const data = new Uint8Array(length);
  for (let index = 0; index < length; index++) data[index] = (index + seed) % 251;
  return data;
}

function fileInode(path, data, mtime = 1) {
  return {
    path,
    parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    isDir: false,
    size: data.length,
    mtime,
    mode: 0o644,
    chunkCount: data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE),
  };
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

function contentId(harness, path) {
  const rows = harness.sql.exec('SELECT content_id FROM inodes WHERE path = ?', path);
  assert.equal(rows.length, 1, `expected one inode for ${path}`);
  return rows[0].content_id;
}

function contentChunkIds(harness, id) {
  return harness.sql.exec(
    'SELECT chunk_id FROM file_chunks WHERE content_id = ? ORDER BY chunk_id',
    id,
  ).map((row) => Number(row.chunk_id));
}

function contentMaintenanceScanCount(harness, fromStatement = 0) {
  return harness.statements.slice(fromStatement).filter((statement) => (
    /FROM\s+file_chunks\s+AS\s+chunks/i.test(statement.sql)
    && /NOT\s+EXISTS/i.test(statement.sql)
  )).length;
}

function standaloneContentIdLookupCount(harness, fromStatement = 0) {
  return harness.statements.slice(fromStatement).filter((statement) => (
    /^\s*SELECT\s+(?:content_id|path)\s+FROM\s+(?:file_chunks|content_lifecycle|inodes)/i.test(statement.sql)
  )).length;
}

function contentIdAllocationGuardCount(harness, fromStatement = 0) {
  return harness.statements.slice(fromStatement).filter((statement) => (
    /SELECT\s+1\s+AS\s+collision\s+FROM\s+file_chunks/i.test(statement.sql)
    && /UNION\s+ALL[\s\S]+FROM\s+content_lifecycle/i.test(statement.sql)
    && /UNION\s+ALL[\s\S]+FROM\s+inodes/i.test(statement.sql)
  )).length;
}

function transactionGroups(harness, fromStatement = 0) {
  const groups = new Map();
  for (const statement of harness.statements.slice(fromStatement)) {
    if (statement.transaction === null) continue;
    const group = groups.get(statement.transaction) ?? [];
    group.push(statement);
    groups.set(statement.transaction, group);
  }
  return groups;
}

function createStage1Fixture(entries) {
  const harness = createSqliteVfsTestHarness();
  harness.sql.exec(`CREATE TABLE vfs_schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  harness.sql.exec(`CREATE TABLE inodes (
    path TEXT PRIMARY KEY,
    parent_path TEXT NOT NULL DEFAULT '',
    is_dir INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    atime INTEGER NOT NULL DEFAULT 0,
    mtime INTEGER NOT NULL DEFAULT 0,
    mode INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0
  )`);
  harness.sql.exec('CREATE INDEX idx_inodes_parent ON inodes(parent_path)');
  harness.sql.exec(`CREATE TABLE file_chunks (
    path TEXT NOT NULL,
    chunk_id INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (path, chunk_id)
  )`);
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array(0);
    const isDir = entry.isDir === true;
    const count = isDir || data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE);
    harness.sql.exec(
      `INSERT INTO inodes
       (path, parent_path, is_dir, size, atime, mtime, mode, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.path,
      entry.parentPath ?? (entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''),
      isDir ? 1 : 0,
      data.length,
      1,
      1,
      isDir ? 0o755 : 0o644,
      count,
    );
    for (const chunk of chunks(entry.path, data)) {
      harness.sql.exec(
        'INSERT INTO file_chunks (path, chunk_id, data) VALUES (?, ?, ?)',
        chunk.path,
        chunk.chunkId,
        chunk.data,
      );
    }
  }
  return harness;
}

function captureTransactionMetrics(rawVfs, harness, afterTransaction) {
  const captured = new Map();
  harness.setFaultInjector(({ transaction }) => {
    if (transaction !== null && transaction > afterTransaction && !captured.has(transaction)) {
      const tx = rawVfs.getStats().sql.transactions;
      captured.set(transaction, {
        blobBytes: tx.blobBytes.current,
        logicalRows: tx.logicalRows.current,
        sqlExecs: tx.sqlExecs.current,
      });
    }
    return null;
  });
  return captured;
}

function assertBounded(metrics, label) {
  assert.ok(metrics.blobBytes <= MAX_TX_BLOB_BYTES, `${label}: blob byte bound`);
  assert.ok(metrics.logicalRows <= MAX_TX_LOGICAL_ROWS, `${label}: logical row bound`);
  assert.ok(metrics.sqlExecs <= MAX_TX_SQL_EXECS, `${label}: SQL execution bound`);
}

// Fresh/new schema creation is complete, constrained, and idempotent.
{
  const { harness, vfs } = openVfs();
  const inodeColumns = harness.sql.exec('PRAGMA table_info(inodes)');
  const contentColumn = inodeColumns.find((column) => column.name === 'content_id');
  assert.ok(contentColumn);
  assert.equal(contentColumn.notnull, 0);
  assert.deepEqual(
    harness.sql.exec('PRAGMA table_info(file_chunks)').map((column) => [column.name, column.pk]),
    [['content_id', 1], ['chunk_id', 2], ['data', 0]],
  );
  assert.deepEqual(
    harness.sql.exec('PRAGMA table_info(content_lifecycle)').map((column) => column.name),
    ['content_id', 'state', 'created_at'],
  );
  assert.throws(
    () => harness.sql.exec(
      "INSERT INTO content_lifecycle (content_id, state, created_at) VALUES ('bad', 'invalid', 1)",
    ),
    /CHECK constraint failed/,
  );
  assert.deepEqual(
    harness.sql.exec("SELECT id FROM vfs_schema_migrations WHERE id = 'content_generations_v1'"),
    [{ id: 'content_generations_v1' }],
  );

  vfs.writeFile('new-schema.txt', 'new-schema');
  const firstId = contentId(harness, 'new-schema.txt');
  assert.equal(typeof firstId, 'string');
  assert.match(firstId, /^\/content:/);
  // No flush/barrier is necessary: a fresh VFS must observe the write as soon
  // as the synchronous write call returns.
  const reopened = reopenVfs(harness);
  assert.equal(reopened.readFileString('new-schema.txt'), 'new-schema');
  assert.equal(contentId(harness, 'new-schema.txt'), firstId);
  reopenVfs(harness);
  assert.equal(
    harness.sql.exec("SELECT COUNT(*) AS count FROM vfs_schema_migrations WHERE id = 'content_generations_v1'")[0].count,
    1,
  );
}

// A non-empty Stage-1 path-keyed database migrates in place, remains readable,
// reopens idempotently, and converts lazily to an opaque generation on rewrite.
{
  const legacy = bytes(CHUNK_SIZE * 2 + 17, 11);
  const harness = createStage1Fixture([{ path: 'legacy.bin', data: legacy }]);
  const { vfs } = openVfs(harness);
  assert.equal(contentId(harness, 'legacy.bin'), null);
  assert.deepEqual(vfs.readFile('legacy.bin'), legacy);
  assert.deepEqual(contentChunkIds(harness, 'legacy.bin'), [0, 1, 2]);
  assert.deepEqual(reopenVfs(harness).readFile('legacy.bin'), legacy);

  const replacement = bytes(CHUNK_SIZE + 9, 31);
  vfs.writeFile('legacy.bin', replacement);
  const opaque = contentId(harness, 'legacy.bin');
  assert.equal(typeof opaque, 'string');
  assert.match(opaque, /^\/content:/);
  assert.notEqual(opaque, 'legacy.bin');
  assert.deepEqual(reopenVfs(harness).readFile('legacy.bin'), replacement);
  vfs.writeFile('legacy.bin', replacement);
  assert.notEqual(contentId(harness, 'legacy.bin'), opaque, 'every full rewrite gets a fresh generation');
}

// Clean writes do not run the orphan-maintenance scan. Content allocation uses
// one combined indexed uniqueness guard rather than three separate lookups.
// Replacing content enqueues GC, performs one maintenance pass, and reclaims
// the superseded generation before returning.
{
  const { harness, vfs } = openVfs();
  const cleanStart = harness.statements.length;
  for (let index = 0; index < 12; index++) {
    vfs.writeFile(`clean-${index}.txt`, `value-${index}`);
  }
  assert.equal(contentMaintenanceScanCount(harness, cleanStart), 0);
  assert.equal(contentIdAllocationGuardCount(harness, cleanStart), 12);
  assert.equal(standaloneContentIdLookupCount(harness, cleanStart), 0);
  const generatedIds = new Set(
    Array.from({ length: 12 }, (_, index) => contentId(harness, `clean-${index}.txt`)),
  );
  assert.equal(generatedIds.size, 12);

  const oldId = contentId(harness, 'clean-0.txt');
  const replacementStart = harness.statements.length;
  vfs.writeFile('clean-0.txt', 'replacement');
  assert.equal(contentMaintenanceScanCount(harness, replacementStart), 1);
  assert.deepEqual(contentChunkIds(harness, oldId), []);
  assert.deepEqual(
    harness.sql.exec('SELECT state FROM content_lifecycle WHERE content_id = ?', oldId),
    [],
  );
  const postGcStart = harness.statements.length;
  vfs.writeFile('post-gc-clean.txt', 'clean');
  assert.equal(contentMaintenanceScanCount(harness, postGcStart), 0);
  assert.equal(reopenVfs(harness).readFileString('clean-0.txt'), 'replacement');
}

// A repeated random UUID inside one multi-file plan is detected before staging
// can alias its generations. The allocator retries once and both files remain
// independently durable across reconstruction.
{
  const { harness, vfs } = openVfs();
  const firstUuid = '11111111-1111-4111-8111-111111111111';
  const secondUuid = '22222222-2222-4222-8222-222222222222';
  const generatedUuids = [firstUuid, firstUuid, secondUuid];
  const originalDescriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: () => {
      const next = generatedUuids.shift();
      assert.ok(next, 'unexpected extra content ID allocation attempt');
      return next;
    },
  });
  const statementStart = harness.statements.length;
  const firstData = bytes(9, 17);
  const secondData = bytes(11, 73);
  try {
    vfs.writeBatch({
      inodes: [
        fileInode('collision-first.bin', firstData),
        fileInode('collision-second.bin', secondData),
      ],
      chunks: [
        ...chunks('collision-first.bin', firstData),
        ...chunks('collision-second.bin', secondData),
      ],
    });
  } finally {
    if (originalDescriptor) Object.defineProperty(crypto, 'randomUUID', originalDescriptor);
    else delete crypto.randomUUID;
  }
  assert.equal(contentId(harness, 'collision-first.bin'), `/content:${firstUuid}`);
  assert.equal(contentId(harness, 'collision-second.bin'), `/content:${secondUuid}`);
  assert.equal(generatedUuids.length, 0, 'allocator must consume the retry UUID');
  assert.equal(contentIdAllocationGuardCount(harness, statementStart), 2);
  const reconstructed = reopenVfs(harness);
  assert.deepEqual(reconstructed.readFile('collision-first.bin'), firstData);
  assert.deepEqual(reconstructed.readFile('collision-second.bin'), secondData);
}

// Unlink enqueues GC through writeBatch and runs exactly one effective
// maintenance pass, which removes both the chunks and lifecycle row.
{
  const { harness, rawVfs, vfs } = openVfs();
  vfs.writeFile('unlink-once.txt', 'gone');
  const oldId = contentId(harness, 'unlink-once.txt');
  const runMaintenance = rawVfs.runContentMaintenanceSafely.bind(rawVfs);
  let maintenanceInvocations = 0;
  rawVfs.runContentMaintenanceSafely = (...args) => {
    maintenanceInvocations++;
    return runMaintenance(...args);
  };
  const unlinkStart = harness.statements.length;
  vfs.unlink('unlink-once.txt');
  assert.equal(maintenanceInvocations, 1);
  assert.equal(contentMaintenanceScanCount(harness, unlinkStart), 1);
  assert.deepEqual(contentChunkIds(harness, oldId), []);
  assert.deepEqual(
    harness.sql.exec('SELECT state FROM content_lifecycle WHERE content_id = ?', oldId),
    [],
  );
}

// The zero-copy migration may expose pre-existing orphan chunk keys. Boot
// maintenance discovers them without scanning/copying their BLOBs, enrolls
// them as GC, and reclaims them through the same bounded deletion path.
{
  const harness = createStage1Fixture([{ path: 'owned.bin', data: bytes(3, 2) }]);
  harness.sql.exec(
    'INSERT INTO file_chunks (path, chunk_id, data) VALUES (?, ?, ?)',
    'legacy-orphan',
    0,
    bytes(9, 17),
  );
  const transactionStart = harness.transactionCount;
  const { vfs } = openVfs(harness);
  assert.deepEqual(vfs.readFile('owned.bin'), bytes(3, 2));
  assert.deepEqual(contentChunkIds(harness, 'legacy-orphan'), []);
  assert.deepEqual(
    harness.sql.exec('SELECT state FROM content_lifecycle WHERE content_id = ?', 'legacy-orphan'),
    [],
  );
  for (const [transaction, statements] of transactionGroups(harness)) {
    if (transaction <= transactionStart || transaction === transactionStart + 1) continue;
    assert.ok(statements.length <= MAX_TX_SQL_EXECS, `legacy orphan transaction ${transaction}`);
  }
}

// Every SQL fault in the versioned Stage-1 schema migration rolls back the
// column rename, inode column, lifecycle table, indexes, and marker together.
const schemaMigrationStatementCount = (() => {
  const harness = createStage1Fixture([{ path: 'count-legacy.bin', data: bytes(3, 1) }]);
  openVfs(harness);
  return harness.statements.filter((statement) => statement.transaction === 1).length;
})();
for (let statement = 1; statement <= schemaMigrationStatementCount; statement++) {
  const legacy = bytes(CHUNK_SIZE + 2, statement);
  const harness = createStage1Fixture([{ path: 'rollback-legacy.bin', data: legacy }]);
  harness.failOnTransactionStatement(statement);
  assert.throws(() => openVfs(harness), /injected SQL fault/);
  assert.equal(
    harness.sql.exec('PRAGMA table_info(inodes)').some((column) => column.name === 'content_id'),
    false,
  );
  assert.deepEqual(
    harness.sql.exec('PRAGMA table_info(file_chunks)').map((column) => column.name),
    ['path', 'chunk_id', 'data'],
  );
  assert.deepEqual(
    harness.sql.exec("SELECT id FROM vfs_schema_migrations WHERE id = 'content_generations_v1'"),
    [],
  );
  harness.clearFault();
  const { vfs } = openVfs(harness);
  assert.deepEqual(vfs.readFile('rollback-legacy.bin'), legacy);
}

// A durable marker with the old shape is impossible after an atomic migration
// and therefore signals corruption; initialization must not silently heal it.
{
  const harness = createStage1Fixture([{ path: 'marker-mismatch.bin', data: bytes(3, 9) }]);
  harness.sql.exec(
    "INSERT INTO vfs_schema_migrations (id, applied_at) VALUES ('content_generations_v1', 1)",
  );
  assert.throws(
    () => openVfs(harness),
    /content generation marker does not match the durable schema/,
  );
  assert.deepEqual(
    harness.sql.exec('PRAGMA table_info(file_chunks)').map((column) => column.name),
    ['path', 'chunk_id', 'data'],
  );
}

// The loaded inode is the content-resolution cache: an uncached multi-chunk
// read performs chunk queries only, never an inode lookup per chunk.
{
  const data = bytes(CHUNK_SIZE * 3 + 5, 47);
  const harness = createStage1Fixture([{ path: 'cached-resolver.bin', data }]);
  const { vfs } = openVfs(harness);
  const offset = harness.statements.length;
  assert.deepEqual(vfs.readFile('cached-resolver.bin'), data);
  const reads = harness.statements.slice(offset);
  assert.equal(
    reads.filter((statement) => /FROM\s+inodes/i.test(statement.sql)).length,
    0,
    'chunk reads must not query inode content_id repeatedly',
  );
  assert.equal(
    reads.filter((statement) => /FROM\s+file_chunks/i.test(statement.sql)).length,
    4,
  );
  const hotOffset = harness.statements.length;
  assert.deepEqual(vfs.readFile('cached-resolver.bin'), data);
  assert.equal(
    harness.statements.slice(hotOffset).filter((statement) => /FROM\s+file_chunks/i.test(statement.sql)).length,
    0,
  );
}

// Range writes and truncate retain the inode generation and touch only the
// current generation's chunks.
{
  const { harness, vfs } = openVfs();
  const original = bytes(CHUNK_SIZE * 3 + 100, 59);
  vfs.writeFile('range.bin', original);
  const id = contentId(harness, 'range.bin');
  const patch = bytes(10, 91);
  vfs.writeRange('range.bin', CHUNK_SIZE - 5, patch);
  assert.equal(contentId(harness, 'range.bin'), id);
  const expected = original.slice();
  expected.set(patch, CHUNK_SIZE - 5);
  assert.deepEqual(reopenVfs(harness).readFile('range.bin'), expected);

  vfs.truncate('range.bin', CHUNK_SIZE + 23);
  assert.equal(contentId(harness, 'range.bin'), id);
  assert.deepEqual(contentChunkIds(harness, id), [0, 1]);
  assert.deepEqual(reopenVfs(harness).readFile('range.bin'), expected.slice(0, CHUNK_SIZE + 23));
}

// Rename changes only the logical inode namespace. Legacy-null files
// materialize their old resolved key before their path changes.
{
  const data = bytes(CHUNK_SIZE + 3, 73);
  const harness = createStage1Fixture([
    { path: 'legacy-dir', isDir: true },
    { path: 'legacy-dir/file.bin', parentPath: 'legacy-dir', data },
  ]);
  const { vfs } = openVfs(harness);
  const offset = harness.statements.length;
  vfs.rename('legacy-dir', 'renamed-dir');
  assert.equal(contentId(harness, 'renamed-dir/file.bin'), 'legacy-dir/file.bin');
  assert.deepEqual(contentChunkIds(harness, 'legacy-dir/file.bin'), [0, 1]);
  assert.deepEqual(vfs.readFile('renamed-dir/file.bin'), data);
  assert.equal(vfs.exists('legacy-dir/file.bin'), false);
  assert.equal(
    harness.statements.slice(offset).filter((statement) => (
      /(?:INSERT|UPDATE|DELETE).*file_chunks/i.test(statement.sql)
    )).length,
    0,
    'rename must not rewrite immutable chunk rows',
  );
  assert.deepEqual(reopenVfs(harness).readFile('renamed-dir/file.bin'), data);
}

// Rename fails before mutation when an inconsistent target subtree would
// collide with a moved descendant; INSERT OR REPLACE must never hide the
// collision or leak the overwritten generation from counters/GC ownership.
{
  const { harness, vfs } = openVfs();
  vfs.mkdir('source', { recursive: true });
  vfs.writeFile('source/file.txt', 'source');
  vfs.mkdir('target');
  vfs.writeFile('target/file.txt', 'target');
  // Remove only the target root to model durable corruption while retaining
  // a descendant that must not be silently overwritten.
  harness.sql.exec("DELETE FROM inodes WHERE path = 'target'");
  const reconstructed = reopenVfs(harness);
  assert.throws(
    () => reconstructed.rename('source', 'target'),
    /rename target subtree conflicts/,
  );
  assert.equal(reconstructed.exists('source/file.txt'), true);
  assert.deepEqual(
    harness.sql.exec("SELECT path FROM inodes WHERE path = 'target/file.txt'"),
    [{ path: 'target/file.txt' }],
  );
}

// Referenced lifecycle rows are never GC authority. Unreferenced staging is
// reclaimed in bounded windows, independently of age.
{
  const { harness, rawVfs, vfs } = openVfs();
  const live = bytes(CHUNK_SIZE + 1, 101);
  vfs.writeFile('referenced.bin', live);
  const liveId = contentId(harness, 'referenced.bin');
  harness.sql.exec(
    "INSERT OR REPLACE INTO content_lifecycle (content_id, state, created_at) VALUES (?, 'gc', ?)",
    liveId,
    -1,
  );
  rawVfs.runContentMaintenance(8);
  assert.deepEqual(vfs.readFile('referenced.bin'), live);
  assert.deepEqual(contentChunkIds(harness, liveId), [0, 1]);

  const abandoned = 'test:abandoned';
  harness.sql.exec(
    "INSERT INTO content_lifecycle (content_id, state, created_at) VALUES (?, 'staging', ?)",
    abandoned,
    Number.MAX_SAFE_INTEGER,
  );
  for (let chunkId = 0; chunkId < MAX_TX_LOGICAL_ROWS + 44; chunkId++) {
    harness.sql.exec(
      'INSERT INTO file_chunks (content_id, chunk_id, data) VALUES (?, ?, ?)',
      abandoned,
      chunkId,
      new Uint8Array([chunkId % 251]),
    );
  }
  const transactionStart = harness.transactionCount;
  const captured = captureTransactionMetrics(rawVfs, harness, transactionStart);
  const result = rawVfs.runContentMaintenance(16);
  harness.clearFault();
  assert.ok(result.transactions >= 10, 'GC must use SQL-bind-safe bounded windows');
  assert.deepEqual(contentChunkIds(harness, abandoned), []);
  assert.deepEqual(
    harness.sql.exec('SELECT state FROM content_lifecycle WHERE content_id = ?', abandoned),
    [],
  );
  assert.ok(captured.size >= 3);
  for (const [transaction, metrics] of captured) {
    assertBounded(metrics, `GC transaction ${transaction}`);
  }
}

// A directory at the same logical path is not a content reference. This is
// essential when a legacy-null file (whose resolved ID is its path) is
// replaced by a directory.
{
  const harness = createStage1Fixture([{ path: 'legacy-flip', data: bytes(7, 4) }]);
  const { rawVfs, vfs } = openVfs(harness);
  vfs.writeBatch({
    inodes: [{
      path: 'legacy-flip', parentPath: '', isDir: true, size: 0,
      mtime: 2, mode: 0o755, chunkCount: 0,
    }],
    chunks: [],
  });
  rawVfs.runContentMaintenance(4);
  assert.equal(vfs.isDirectory('legacy-flip'), true);
  assert.deepEqual(contentChunkIds(harness, 'legacy-flip'), []);
}

// Opportunistic maintenance in the same isolate skips an actively streamed
// generation. The durable lifecycle row remains the ownership source and a
// reset would intentionally lose only this in-memory liveness exemption.
{
  const { harness, vfs } = openVfs();
  const data = bytes(CHUNK_SIZE + 3, 21);
  const entries = chunks('active-stage.bin', data);
  const result = await vfs.writeStream(encodeWriteBatchStream({
    inodes: [fileInode('active-stage.bin', data)],
    chunks: entries,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(reopenVfs(harness).readFile('active-stage.bin'), data);
}

// A full discovery page of active staging rows cannot hide a later abandoned
// generation and clear the dirty flag. Once the active rows finish, subsequent
// hot-path maintenance converts and reclaims the abandoned generation.
{
  const { harness, rawVfs, vfs } = openVfs();
  vfs.writeFile('maintenance-trigger.txt', 'old');
  const activeIds = Array.from(
    { length: 50 },
    (_, index) => `/test:active:${String(index).padStart(2, '0')}`,
  );
  for (const [index, activeId] of activeIds.entries()) {
    harness.sql.exec(
      "INSERT INTO content_lifecycle (content_id, state, created_at) VALUES (?, 'staging', ?)",
      activeId,
      index,
    );
    rawVfs.activeStagingContentIds.add(activeId);
  }
  const abandonedId = '/test:abandoned-after-active-page';
  harness.sql.exec(
    "INSERT INTO content_lifecycle (content_id, state, created_at) VALUES (?, 'staging', ?)",
    abandonedId,
    100,
  );
  harness.sql.exec(
    'INSERT INTO file_chunks (content_id, chunk_id, data) VALUES (?, ?, ?)',
    abandonedId,
    0,
    bytes(7, 83),
  );

  vfs.writeFile('maintenance-trigger.txt', 'new');
  assert.deepEqual(
    harness.sql.exec('SELECT state FROM content_lifecycle WHERE content_id = ?', abandonedId),
    [{ state: 'staging' }],
  );
  for (const activeId of activeIds) {
    harness.sql.exec('DELETE FROM content_lifecycle WHERE content_id = ?', activeId);
    rawVfs.activeStagingContentIds.delete(activeId);
  }

  const cleanupStart = harness.statements.length;
  vfs.writeFile('maintenance-progress-1.txt', 'one');
  vfs.writeFile('maintenance-progress-2.txt', 'two');
  assert.ok(contentMaintenanceScanCount(harness, cleanupStart) >= 2);
  assert.deepEqual(contentChunkIds(harness, abandonedId), []);
  assert.deepEqual(
    harness.sql.exec('SELECT state FROM content_lifecycle WHERE content_id = ?', abandonedId),
    [],
  );
}

function createLargeReplacementFixture() {
  const opened = openVfs();
  const oldData = bytes(MAX_TX_BLOB_BYTES * 2 + CHUNK_SIZE, 7);
  const newData = bytes(MAX_TX_BLOB_BYTES * 2 + CHUNK_SIZE, 137);
  opened.vfs.writeFile('atomic-large.bin', oldData);
  return { ...opened, oldData, newData, transactionStart: opened.harness.transactionCount };
}

function replacementTransactions(harness, statementStart) {
  const groups = transactionGroups(harness, statementStart);
  const stage = [];
  let publish = null;
  let gc = null;
  for (const [transaction, statements] of groups) {
    if (
      statements.some((statement) => /INSERT OR REPLACE INTO file_chunks/i.test(statement.sql))
      || (
        statements.some((statement) => /INSERT INTO content_lifecycle/i.test(statement.sql))
        && statements.some((statement) => /staging/i.test(statement.sql))
        && !statements.some((statement) => /INSERT OR REPLACE INTO inodes/i.test(statement.sql))
      )
    ) {
      stage.push({ transaction, statements });
    }
    if (
      statements.some((statement) => /INSERT OR REPLACE INTO inodes/i.test(statement.sql))
      && statements.some((statement) => /DELETE FROM content_lifecycle/i.test(statement.sql))
    ) {
      publish = { transaction, statements };
    }
    if (statements.some((statement) => (
      /DELETE FROM file_chunks/i.test(statement.sql) && /NOT EXISTS/i.test(statement.sql)
    ))) {
      gc = { transaction, statements };
    }
  }
  return { groups, stage, publish, gc };
}

// Establish the exact Stage-3 transaction shape without assuming constructor
// transaction numbering, and prove every transaction is bounded.
let replacementBaseline;
{
  const fixture = createLargeReplacementFixture();
  const statementStart = fixture.harness.statements.length;
  const captured = captureTransactionMetrics(fixture.rawVfs, fixture.harness, fixture.transactionStart);
  fixture.vfs.writeFile('atomic-large.bin', fixture.newData);
  fixture.harness.clearFault();
  const classified = replacementTransactions(fixture.harness, statementStart);
  assert.ok(classified.stage.length >= 4, 'large content must have a marker and span bounded chunk transactions');
  assert.ok(classified.publish, 'replacement must have one inode-pointer publish transaction');
  assert.ok(classified.gc, 'replacement must schedule bounded old-content GC');
  for (const [transaction, metrics] of captured) {
    assertBounded(metrics, `replacement transaction ${transaction}`);
  }
  assert.deepEqual(reopenVfs(fixture.harness).readFile('atomic-large.bin'), fixture.newData);
  replacementBaseline = {
    stageRelative: classified.stage.map(({ transaction, statements }) => ({
      transaction: transaction - fixture.transactionStart,
      statementCount: statements.length,
    })),
    publishRelative: {
      transaction: classified.publish.transaction - fixture.transactionStart,
      statementCount: classified.publish.statements.length,
    },
    gcRelative: {
      transaction: classified.gc.transaction - fixture.transactionStart,
      statementCount: classified.gc.statements.length,
    },
  };
}

// Fault every statement of every staging/publish transaction. Fresh durable
// state must always expose complete-old bytes, including failures after prior
// chunk transactions committed.
for (const phase of [...replacementBaseline.stageRelative, replacementBaseline.publishRelative]) {
  for (let statement = 1; statement <= phase.statementCount; statement++) {
    const fixture = createLargeReplacementFixture();
    fixture.harness.failOnTransactionStatement(statement, {
      transaction: fixture.transactionStart + phase.transaction,
      error: new Error(`injected replacement fault at ${phase.transaction}:${statement}`),
    });
    assert.throws(
      () => fixture.vfs.writeFile('atomic-large.bin', fixture.newData),
      /injected replacement fault/,
    );
    assert.deepEqual(
      reopenVfs(fixture.harness).readFile('atomic-large.bin'),
      fixture.oldData,
      `fault ${phase.transaction}:${statement} exposed mixed or new bytes before publish`,
    );
  }
}

// A reset after the publish transaction commits but before live-map/revision
// publication reconstructs as complete-new. This seam is distinct from an
// in-transaction SQL fault: durable metadata has already won.
{
  const fixture = createLargeReplacementFixture();
  fixture.harness.failAfterTransaction({
    transaction: fixture.transactionStart + replacementBaseline.publishRelative.transaction,
    error: new Error('injected reset after durable publish'),
  });
  assert.throws(
    () => fixture.vfs.writeFile('atomic-large.bin', fixture.newData),
    /injected reset after durable publish/,
  );
  assert.deepEqual(reopenVfs(fixture.harness).readFile('atomic-large.bin'), fixture.newData);
}

// Fault every GC statement after the pointer publish. GC is maintenance and
// may fail independently; complete-new bytes remain authoritative.
for (let statement = 1; statement <= replacementBaseline.gcRelative.statementCount; statement++) {
  const fixture = createLargeReplacementFixture();
  fixture.harness.failOnTransactionStatement(statement, {
    transaction: fixture.transactionStart + replacementBaseline.gcRelative.transaction,
    error: new Error(`injected GC fault at statement ${statement}`),
  });
  fixture.vfs.writeFile('atomic-large.bin', fixture.newData);
  assert.deepEqual(fixture.vfs.readFile('atomic-large.bin'), fixture.newData);
  assert.deepEqual(reopenVfs(fixture.harness).readFile('atomic-large.bin'), fixture.newData);
}

function createLargeRangeFixture() {
  const opened = openVfs();
  const oldData = bytes(MAX_TX_BLOB_BYTES * 2, 41);
  const newData = bytes(oldData.length, 173);
  opened.vfs.writeFile('atomic-range.bin', oldData);
  return { ...opened, oldData, newData, transactionStart: opened.harness.transactionCount };
}

// An over-limit range edit copies chunks into an invisible generation. Faults
// after any prior stage transaction still reconstruct the complete old file;
// the one pointer publish is the only old/new visibility boundary.
let rangeBaseline;
{
  const fixture = createLargeRangeFixture();
  const oldContentId = contentId(fixture.harness, 'atomic-range.bin');
  const statementStart = fixture.harness.statements.length;
  fixture.vfs.writeRange('atomic-range.bin', 0, fixture.newData);
  const classified = replacementTransactions(fixture.harness, statementStart);
  assert.ok(classified.stage.length >= 3);
  assert.ok(classified.publish);
  assertBounded(fixture.rawVfs.getStats().sql.transactions.boundedPeak, 'large range transaction peak');
  assert.notEqual(contentId(fixture.harness, 'atomic-range.bin'), oldContentId);
  assert.deepEqual(reopenVfs(fixture.harness).readFile('atomic-range.bin'), fixture.newData);
  rangeBaseline = {
    phases: [...classified.stage, classified.publish].map(({ transaction, statements }) => ({
      transaction: transaction - fixture.transactionStart,
      statementCount: statements.length,
    })),
    publishTransaction: classified.publish.transaction - fixture.transactionStart,
  };
}
for (const phase of rangeBaseline.phases) {
  for (let statement = 1; statement <= phase.statementCount; statement++) {
    const fixture = createLargeRangeFixture();
    fixture.harness.failOnTransactionStatement(statement, {
      transaction: fixture.transactionStart + phase.transaction,
      error: new Error(`injected range fault at ${phase.transaction}:${statement}`),
    });
    assert.throws(
      () => fixture.vfs.writeRange('atomic-range.bin', 0, fixture.newData),
      /injected range fault/,
    );
    assert.deepEqual(reopenVfs(fixture.harness).readFile('atomic-range.bin'), fixture.oldData);
  }
}
{
  const fixture = createLargeRangeFixture();
  fixture.harness.failAfterTransaction({
    transaction: fixture.transactionStart + rangeBaseline.publishTransaction,
    error: new Error('injected range reset after publish'),
  });
  assert.throws(
    () => fixture.vfs.writeRange('atomic-range.bin', 0, fixture.newData),
    /injected range reset after publish/,
  );
  assert.deepEqual(reopenVfs(fixture.harness).readFile('atomic-range.bin'), fixture.newData);
}

// A bounded truncate commits its boundary chunk, tail deletion, and inode
// metadata in one transaction. Every SQL fault rolls the complete shrink back.
const truncateStatementCount = (() => {
  const { harness, vfs } = openVfs();
  vfs.writeFile('truncate-atomic.bin', bytes(CHUNK_SIZE * 3, 5));
  const transactionStart = harness.transactionCount;
  vfs.truncate('truncate-atomic.bin', 10);
  const transactions = transactionGroups(harness)
  return transactions.get(transactionStart + 1).length;
})();
for (let statement = 1; statement <= truncateStatementCount; statement++) {
  const { harness, vfs } = openVfs();
  const original = bytes(CHUNK_SIZE * 3, 5);
  vfs.writeFile('truncate-atomic.bin', original);
  harness.failOnTransactionStatement(statement, {
    transaction: harness.transactionCount + 1,
    error: new Error(`injected truncate fault at ${statement}`),
  });
  assert.throws(() => vfs.truncate('truncate-atomic.bin', 10), /injected truncate fault/);
  const reconstructed = reopenVfs(harness);
  assert.equal(reconstructed.stat('truncate-atomic.bin').size, original.length);
  assert.deepEqual(reconstructed.readFile('truncate-atomic.bin'), original);
}
{
  const { harness, rawVfs, vfs } = openVfs();
  const original = bytes(MAX_TX_BLOB_BYTES * 2, 29);
  vfs.writeFile('truncate-cow.bin', original);
  const oldContentId = contentId(harness, 'truncate-cow.bin');
  vfs.truncate('truncate-cow.bin', 10);
  assertBounded(rawVfs.getStats().sql.transactions.boundedPeak, 'large truncate transaction peak');
  assert.notEqual(contentId(harness, 'truncate-cow.bin'), oldContentId);
  assert.deepEqual(reopenVfs(harness).readFile('truncate-cow.bin'), original.slice(0, 10));
}

function streamPayload(entries) {
  return {
    inodes: entries.map(({ path, data }) => fileInode(path, data)),
    chunks: entries.flatMap(({ path, data }) => chunks(path, data)),
  };
}

async function collectStream(stream) {
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
    total += next.value.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function nthRecordOffset(bytes, tag, occurrence) {
  let seen = 0;
  let offset = 4;
  while (offset < bytes.length) {
    const length = (
      bytes[offset + 1]
      | (bytes[offset + 2] << 8)
      | (bytes[offset + 3] << 16)
      | (bytes[offset + 4] << 24)
    ) >>> 0;
    if (bytes[offset] === tag && ++seen === occurrence) return offset;
    offset += 5 + length;
  }
  throw new Error(`missing record tag ${tag} occurrence ${occurrence}`);
}

function streamFromBytes(bytes) {
  return new ReadableStream({
    type: 'bytes',
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// Storage failure after one published stream path returns exact typed progress;
// replaying the whole stream is idempotent and converges to the requested bytes.
{
  const { harness, vfs } = openVfs();
  const oldB = bytes(4, 3);
  vfs.writeFile('prefix-b.bin', oldB);
  const entries = [
    { path: 'prefix-a.bin', data: bytes(5, 10) },
    { path: 'prefix-b.bin', data: bytes(6, 20) },
    { path: 'prefix-c.bin', data: bytes(7, 30) },
  ];
  const payload = streamPayload(entries);
  harness.setFaultInjector(({ sql, params }) => (
    /INSERT OR REPLACE INTO inodes/i.test(sql) && params.includes('prefix-b.bin')
      ? new Error('injected second publish failure')
      : null
  ));
  const failed = await vfs.writeStream(encodeWriteBatchStream(payload));
  harness.clearFault();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.phase, 'publish');
  assert.equal(failed.committedGroupSequence, 1);
  assert.equal(failed.committedPathCount, 1);
  assert.deepEqual(reopenVfs(harness).readFile('prefix-a.bin'), entries[0].data);
  assert.deepEqual(reopenVfs(harness).readFile('prefix-b.bin'), oldB);
  assert.equal(reopenVfs(harness).exists('prefix-c.bin'), false);

  const replay = await vfs.writeStream(encodeWriteBatchStream(streamPayload(entries)));
  assert.equal(replay.ok, true);
  assert.equal(replay.committedGroupSequence, 3);
  assert.equal(replay.committedPathCount, 3);
  const reconstructed = reopenVfs(harness);
  for (const entry of entries) assert.deepEqual(reconstructed.readFile(entry.path), entry.data);
}

// Decoder failure after one complete path is the committed-prefix boundary:
// the complete path remains durable and reported; the incomplete path is not.
{
  const { harness, vfs } = openVfs();
  const first = { path: 'decode-a.bin', data: bytes(3, 1) };
  const second = { path: 'decode-b.bin', data: bytes(CHUNK_SIZE + 1, 2) };
  const payload = streamPayload([first, second]);
  const encoded = await collectStream(encodeWriteBatchStream(payload));
  const secondChunkOffset = nthRecordOffset(encoded, 5, 2);
  const failed = await vfs.writeStream(streamFromBytes(encoded.slice(0, secondChunkOffset + 9)));
  assert.equal(failed.ok, false);
  assert.equal(failed.error.phase, 'decode');
  assert.equal(failed.committedGroupSequence, 1);
  assert.equal(failed.committedPathCount, 1);
  const reconstructed = reopenVfs(harness);
  assert.deepEqual(reconstructed.readFile(first.path), first.data);
  assert.equal(reconstructed.exists(second.path), false);

  const replay = await vfs.writeStream(encodeWriteBatchStream(streamPayload([first, second])));
  assert.equal(replay.ok, true);
  const converged = reopenVfs(harness);
  assert.deepEqual(converged.readFile(first.path), first.data);
  assert.deepEqual(converged.readFile(second.path), second.data);
}

// Directory upserts and present/absent deletes remain idempotent when the
// complete logical stream is replayed after committed-prefix semantics.
{
  const { harness, vfs } = openVfs();
  vfs.mkdir('remove/sub', { recursive: true });
  vfs.writeFile('remove/sub/old.txt', 'old');
  const file = { path: 'kept/new.txt', data: bytes(9, 77) };
  const directory = {
    path: 'kept', parentPath: '', isDir: true, size: 0,
    mtime: 1, mode: 0o755, chunkCount: 0,
  };
  const payload = streamPayload([file]);
  const apply = () => vfs.writeStream(encodeWriteBatchStream({
    inodes: [directory, ...payload.inodes],
    chunks: streamPayload([file]).chunks,
    deletePaths: ['remove', 'already-absent'],
  }));
  assert.equal((await apply()).ok, true);
  assert.equal((await apply()).ok, true);
  const reconstructed = reopenVfs(harness);
  assert.equal(reconstructed.exists('remove'), false);
  assert.equal(reconstructed.isDirectory('kept'), true);
  assert.deepEqual(reconstructed.readFile(file.path), file.data);
}

// Duplicate header paths are malformed, not last-writer-wins aliases. Reject
// them before publishing any header-only or chunk-backed mutation.
{
  const { vfs } = openVfs();
  const data = bytes(3, 91);
  const duplicate = fileInode('duplicate.bin', data);
  assert.throws(() => encodeWriteBatchStream({
    inodes: [duplicate, { ...duplicate, mtime: duplicate.mtime + 1 }],
    chunks: chunks(duplicate.path, data),
  }), /duplicate path ownership/);
  assert.equal(vfs.exists('duplicate.bin'), false);
}

// Every durable content-reference probe must SEEK inodes. SQLite cannot seek
// an expression index from a correlated subquery, so the historical
// COALESCE(content_id, path) predicate degraded to a per-outer-row SCAN of
// inodes and made the orphan scan O(chunks × inodes).
{
  const { harness, rawVfs, vfs } = openVfs();
  const probeStart = harness.statements.length;
  vfs.mkdir('plan');
  vfs.writeFile('plan/live.bin', bytes(8, 3));
  harness.sql.exec(
    `INSERT INTO inodes (path, parent_path, kind, size, mtime, mode, chunk_count)
     VALUES ('plan/legacy.bin', 'plan', 0, 3, 1, 420, 1)`,
  );
  harness.sql.exec(
    "INSERT INTO file_chunks (content_id, chunk_id, data) VALUES ('plan/legacy.bin', 0, ?)",
    bytes(3, 5),
  );
  harness.sql.exec(
    "INSERT INTO file_chunks (content_id, chunk_id, data) VALUES ('orphan:plan-a', 0, ?)",
    bytes(3, 6),
  );
  harness.sql.exec(
    "INSERT INTO file_chunks (content_id, chunk_id, data) VALUES ('orphan:plan-b', 0, ?)",
    bytes(3, 7),
  );
  harness.sql.exec(
    "INSERT INTO content_lifecycle (content_id, state, created_at) VALUES ('stale:plan', 'staging', 0)",
  );
  // maximum=2 consumes the orphan-insert and staging-convert transactions and
  // leaves a GC backlog, so the backlog probe executes; the follow-up drain
  // covers the GC pick, chunk-delete, and lifecycle-delete probes.
  rawVfs.runContentMaintenance(2);
  rawVfs.runContentMaintenance(16);
  const probeStatements = harness.statements.slice(probeStart).filter((statement) => (
    statement.sql.includes('inodes')
    && (/NOT\s+EXISTS/i.test(statement.sql) || statement.sql.includes('AS collision'))
  ));
  assert.ok(probeStatements.length >= 9,
    `expected all reference-probe shapes to execute, saw ${probeStatements.length}`);
  for (const statement of probeStatements) {
    const plan = harness.db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
      .all(...statement.params)
      .map((row) => String(row.detail));
    assert.ok(
      plan.every((detail) => !/SCAN inodes/.test(detail)),
      `reference probe scans inodes instead of seeking:\n${statement.sql}\n${plan.join('\n')}`,
    );
  }
}

// The orphan scan and the forced cold-start maintenance run stay flat in VFS
// size: 15k fully referenced generations (worst case — every candidate must
// be proven referenced) complete within a strict bound, and the run is
// visible in getStats().sql.phases.maintenanceMs.
{
  const { harness, rawVfs } = openVfs();
  const insertInode = harness.db.prepare(
    `INSERT INTO inodes (path, parent_path, kind, size, mtime, mode, chunk_count, content_id)
     VALUES (?, 'perf', 0, 4, 1, 420, 1, ?)`,
  );
  const insertChunk = harness.db.prepare(
    'INSERT INTO file_chunks (content_id, chunk_id, data) VALUES (?, 0, ?)',
  );
  const payload = bytes(4, 9);
  harness.db.transaction(() => {
    for (let index = 0; index < 15_000; index++) {
      const generated = `/content:perf-${String(index).padStart(8, '0')}`;
      insertInode.run(`perf/file-${index}`, generated);
      insertChunk.run(generated, payload);
    }
  })();
  const scanStart = performance.now();
  rawVfs.runContentMaintenance(4);
  const scanMs = performance.now() - scanStart;
  assert.ok(scanMs < 50, `orphan scan over 15k referenced generations took ${scanMs}ms`);

  const reopened = openVfs(createSqliteVfsTestHarness(harness.db));
  const maintenance = reopened.rawVfs.getStats().sql.phases.maintenanceMs;
  assert.equal(maintenance.count, 1, 'constructor must run exactly one forced maintenance pass');
  assert.ok(maintenance.last < 50,
    `forced cold-start maintenance took ${maintenance.last}ms at 15k generations`);
}

// The seekable scan flags exactly the set the historical COALESCE predicate
// defined: content referenced by content_id or by a legacy path-keyed
// non-directory inode is never an orphan, lifecycle-owned content is never
// scanned, and directory paths are not references.
{
  const { harness, rawVfs, vfs } = openVfs();
  const live = bytes(6, 31);
  vfs.mkdir('equiv');
  vfs.writeFile('equiv/referenced.bin', live);
  const liveId = contentId(harness, 'equiv/referenced.bin');
  harness.sql.exec(
    `INSERT INTO inodes (path, parent_path, kind, size, mtime, mode, chunk_count)
     VALUES ('equiv/legacy.bin', 'equiv', 0, 3, 1, 420, 1)`,
  );
  harness.sql.exec(
    "INSERT INTO file_chunks (content_id, chunk_id, data) VALUES ('equiv/legacy.bin', 0, ?)",
    bytes(3, 32),
  );
  harness.sql.exec(
    `INSERT INTO inodes (path, parent_path, kind, size, mtime, mode, chunk_count)
     VALUES ('equiv/dir-flip', 'equiv', 1, 0, 1, 493, 0)`,
  );
  harness.sql.exec(
    "INSERT INTO file_chunks (content_id, chunk_id, data) VALUES ('equiv/dir-flip', 0, ?)",
    bytes(3, 33),
  );
  harness.sql.exec(
    "INSERT INTO file_chunks (content_id, chunk_id, data) VALUES ('orphan:equiv', 0, ?)",
    bytes(3, 34),
  );
  harness.sql.exec(
    `INSERT INTO inodes (path, parent_path, kind, size, mtime, mode, chunk_count, content_id)
     VALUES ('equiv/staged.bin', 'equiv', 0, 3, 1, 420, 1, 'stg:equiv')`,
  );
  harness.sql.exec(
    "INSERT INTO content_lifecycle (content_id, state, created_at) VALUES ('stg:equiv', 'staging', 1)",
  );
  harness.sql.exec(
    "INSERT INTO file_chunks (content_id, chunk_id, data) VALUES ('stg:equiv', 0, ?)",
    bytes(3, 35),
  );
  const referenceOrphans = harness.db.prepare(
    `SELECT chunks.content_id
     FROM file_chunks AS chunks
     WHERE NOT EXISTS (
         SELECT 1 FROM content_lifecycle AS lifecycle
         WHERE lifecycle.content_id = chunks.content_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM inodes
         WHERE inodes.kind != 1
           AND COALESCE(inodes.content_id, inodes.path) = chunks.content_id
       )
     GROUP BY chunks.content_id
     ORDER BY chunks.content_id`,
  ).all().map((row) => String(row.content_id));
  assert.deepEqual(referenceOrphans, ['equiv/dir-flip', 'orphan:equiv']);
  rawVfs.runContentMaintenance(1);
  const scheduled = harness.sql
    .exec("SELECT content_id FROM content_lifecycle WHERE state = 'gc' ORDER BY content_id")
    .map((row) => String(row.content_id));
  assert.deepEqual(scheduled, referenceOrphans,
    'seekable orphan scan diverged from the reference COALESCE predicate');
  rawVfs.runContentMaintenance(16);
  assert.deepEqual(vfs.readFile('equiv/referenced.bin'), live);
  assert.deepEqual(contentChunkIds(harness, liveId), [0]);
  assert.deepEqual(contentChunkIds(harness, 'equiv/legacy.bin'), [0]);
  assert.deepEqual(contentChunkIds(harness, 'stg:equiv'), [0]);
  assert.deepEqual(contentChunkIds(harness, 'equiv/dir-flip'), []);
  assert.deepEqual(contentChunkIds(harness, 'orphan:equiv'), []);
}

console.log('sqlite-vfs-stage3-content-generations: all assertions passed');
