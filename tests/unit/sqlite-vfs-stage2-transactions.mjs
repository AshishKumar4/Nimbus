#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  CHUNK_SIZE,
  MAX_TX_BLOB_BYTES,
  MAX_TX_LOGICAL_ROWS,
  MAX_TX_SQL_EXECS,
} from '../../packages/worker/src/constants.ts';
import {
  SqliteVFS,
  SqliteVfsTransactionTooLargeError,
} from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

function openVfs() {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, vfs, baselineTransactions: harness.transactionCount };
}

function fileInode(path, size) {
  return {
    path,
    parentPath: '',
    isDir: false,
    size,
    mtime: 1,
    mode: 0o644,
    chunkCount: size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE),
  };
}

function dirInode(path) {
  return {
    path,
    parentPath: '',
    isDir: true,
    size: 0,
    mtime: 1,
    mode: 0o755,
    chunkCount: 0,
  };
}

function chunks(path, data) {
  const entries = [];
  for (let chunkId = 0; chunkId * CHUNK_SIZE < data.length; chunkId++) {
    entries.push({
      path,
      chunkId,
      data: data.slice(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE),
    });
  }
  return entries;
}

function assertE2Big(run, limit) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof SqliteVfsTransactionTooLargeError);
    assert.equal(error.code, 'E2BIG');
    assert.equal(error.limit, limit);
    return true;
  });
}

function assertBounded(stats) {
  const peak = stats.sql.transactions.boundedPeak;
  assert.ok(peak.blobBytes <= MAX_TX_BLOB_BYTES);
  assert.ok(peak.logicalRows <= MAX_TX_LOGICAL_ROWS);
  assert.ok(peak.sqlExecs <= MAX_TX_SQL_EXECS);
}

// Strict byte boundary remains one data transaction and one revision tick.
{
  const { harness, vfs, baselineTransactions } = openVfs();
  const exact = new Uint8Array(MAX_TX_BLOB_BYTES);
  const revision = vfs.revision();
  assert.deepEqual(vfs.writeBatch({
    inodes: [fileInode('exact-bytes.bin', exact.length)],
    chunks: chunks('exact-bytes.bin', exact),
  }), { inodes: 1, chunks: exact.length / CHUNK_SIZE });
  assert.equal(harness.transactionCount, baselineTransactions + 1);
  assert.equal(vfs.revision(), revision + 1);
  assert.equal(vfs.getStats().sql.transactions.blobBytes.last, MAX_TX_BLOB_BYTES);

  const over = new Uint8Array(MAX_TX_BLOB_BYTES + 1);
  const before = {
    transactions: harness.transactionCount,
    statements: harness.statementCount,
    revision: vfs.revision(),
  };
  assertE2Big(() => vfs.writeBatch({
    inodes: [fileInode('over-bytes.bin', over.length)],
    chunks: chunks('over-bytes.bin', over),
  }), 'blobBytes');
  assert.equal(harness.transactionCount, before.transactions);
  assert.equal(harness.statementCount, before.statements);
  assert.equal(vfs.revision(), before.revision);
  assert.equal(vfs.exists('over-bytes.bin'), false);
  assert.deepEqual(harness.sql.exec("SELECT path FROM inodes WHERE path = 'over-bytes.bin'"), []);
  assert.deepEqual(
    harness.sql.exec("SELECT content_id FROM content_lifecycle WHERE content_id LIKE 'content:%'"),
    [],
  );
}

// Metadata-only logical-row boundary is exact and fail-before-side-effect.
{
  const { harness, vfs, baselineTransactions } = openVfs();
  const exact = Array.from({ length: MAX_TX_LOGICAL_ROWS }, (_, index) => dirInode(`row-${index}`));
  assert.deepEqual(vfs.writeBatch({ inodes: exact, chunks: [] }), {
    inodes: MAX_TX_LOGICAL_ROWS,
    chunks: 0,
  });
  assert.equal(harness.transactionCount, baselineTransactions + 1);
  assert.equal(vfs.getStats().sql.transactions.logicalRows.last, MAX_TX_LOGICAL_ROWS);
}
{
  const { harness, vfs, baselineTransactions } = openVfs();
  const over = Array.from({ length: MAX_TX_LOGICAL_ROWS + 1 }, (_, index) => dirInode(`row-over-${index}`));
  assertE2Big(() => vfs.writeBatch({ inodes: over, chunks: [] }), 'logicalRows');
  assert.equal(harness.transactionCount, baselineTransactions);
  assert.equal(vfs.getStats().directories, 0);
}

// SQL-exec boundary accounts for exact-path deletes plus 11-row inode groups.
{
  const { harness, vfs, baselineTransactions } = openVfs();
  const inodes = Array.from({ length: 55 }, (_, index) => dirInode(`sql-${index}`));
  const deletePaths = Array.from({ length: 59 }, (_, index) => `absent-${index}`);
  vfs.writeBatch({ inodes, chunks: [], deletePaths });
  assert.equal(harness.transactionCount, baselineTransactions + 1);
  assert.equal(vfs.getStats().sql.transactions.sqlExecs.last, MAX_TX_SQL_EXECS);
}
{
  const { harness, vfs, baselineTransactions } = openVfs();
  const inodes = Array.from({ length: 55 }, (_, index) => dirInode(`sql-over-${index}`));
  const deletePaths = Array.from({ length: 60 }, (_, index) => `absent-over-${index}`);
  assertE2Big(() => vfs.writeBatch({ inodes, chunks: [], deletePaths }), 'sqlExecs');
  assert.equal(harness.transactionCount, baselineTransactions);
}

// Empty strict work remains a no-op after schema initialization.
{
  const { harness, vfs, baselineTransactions } = openVfs();
  assert.deepEqual(vfs.writeBatch({ inodes: [], chunks: [] }), { inodes: 0, chunks: 0 });
  assert.equal(harness.transactionCount, baselineTransactions);
  assert.equal(vfs.revision(), 0);
}

// An over-limit range edit uses bounded generation staging plus one pointer
// publish; the Stage 2 oversized-file exception is gone.
{
  const { harness, vfs } = openVfs();
  const data = new Uint8Array(MAX_TX_BLOB_BYTES * 2);
  vfs.writeFile('range.bin', data);
  const priorContentId = harness.sql.exec(
    "SELECT content_id FROM inodes WHERE path = 'range.bin'",
  )[0].content_id;
  const firstRangeTransaction = harness.transactionCount + 1;
  vfs.writeRange('range.bin', 0, new Uint8Array(data.length).fill(7));
  vfs.flushAll();
  const transactions = new Set(
    harness.statements
      .filter((statement) => statement.transaction >= firstRangeTransaction)
      .map((statement) => statement.transaction),
  );
  assert.ok(transactions.size >= 2);
  assert.notEqual(
    harness.sql.exec("SELECT content_id FROM inodes WHERE path = 'range.bin'")[0].content_id,
    priorContentId,
  );
  assertBounded(vfs.getStats());
  assert.equal(vfs.getStats().sql.transactions.overLimitFiles.count, 0);
}

// Streamed oversized files are staged across bounded transactions and exposed
// by one pointer publication, with typed committed progress.
{
  const { harness, vfs } = openVfs();
  const data = new Uint8Array(MAX_TX_BLOB_BYTES * 2 + 1).fill(19);
  const entries = chunks('stream.bin', data);
  const firstTransaction = harness.transactionCount + 1;
  const result = await vfs.writeStream({
    inodes: [fileInode('stream.bin', data.length)],
    chunkIter: (async function* () { yield* entries; })(),
  });
  assert.deepEqual(result, {
    ok: true,
    committedGroupSequence: 1,
    committedPathCount: 1,
    inodes: 1,
    chunks: entries.length,
  });
  assert.ok(harness.transactionCount - firstTransaction + 1 >= 4);
  assert.deepEqual(vfs.readFile('stream.bin'), data);
  assert.equal(vfs.getStats().sql.decoderRetainedBytes.current, 0);
  assert.equal(vfs.getStats().sql.phases.decodeDrainWaitMs.count, 1);
  assertBounded(vfs.getStats());
}

// A bounded existing-generation range edit commits its chunks and inode in
// one measured transaction; no deferred ownership survives the call.
{
  const { harness, vfs } = openVfs();
  const data = new Uint8Array(CHUNK_SIZE * 2);
  vfs.writeFile('telemetry.bin', data);
  let during = null;
  harness.setFaultInjector(({ transaction }) => {
    if (transaction !== null && during === null) during = vfs.getStats().sql;
    return null;
  });
  vfs.writeRange('telemetry.bin', 0, new Uint8Array(data.length).fill(4));
  harness.clearFault();
  assert.ok(during);
  assert.equal(during.transactions.active, true);
  const after = vfs.getStats().sql;
  assert.equal(after.queuedWriteBytes.current, 0);
  assert.equal(after.inFlightWriteBytes.current, 0);
  assert.equal(after.retainedWriteBytes.current, 0);
  assertBounded(vfs.getStats());
}

console.log('sqlite-vfs-stage2-transactions: all assertions passed');
