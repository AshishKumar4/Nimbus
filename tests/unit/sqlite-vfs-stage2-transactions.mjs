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
  return { harness, vfs: new SqliteVFS(harness.sql, harness.ctx) };
}

function inode(path, size = 0) {
  return {
    path,
    parentPath: '',
    isDir: size === 0,
    size,
    mtime: 1,
    mode: size === 0 ? 0o755 : 0o644,
    chunkCount: size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE),
  };
}

function chunks(path, count, size = 0) {
  return Array.from({ length: count }, (_, chunkId) => ({
    path,
    chunkId,
    data: new Uint8Array(size),
  }));
}

function assertE2Big(run, limit) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof SqliteVfsTransactionTooLargeError);
    assert.equal(error.code, 'E2BIG');
    assert.equal(error.limit, limit);
    return true;
  });
}

function transactionWrites(harness, fromTransaction = 1) {
  const grouped = new Map();
  for (const statement of harness.statements) {
    if (statement.transaction === null || statement.transaction < fromTransaction) continue;
    let group = grouped.get(statement.transaction);
    if (!group) {
      group = { statements: 0, blobBytes: 0, rows: 0, paths: new Set() };
      grouped.set(statement.transaction, group);
    }
    group.statements++;
    if (!statement.sql.startsWith('INSERT OR REPLACE INTO file_chunks')) continue;
    for (let i = 0; i < statement.params.length; i += 3) {
      group.paths.add(String(statement.params[i]));
      group.rows++;
      group.blobBytes += statement.params[i + 2].byteLength;
    }
  }
  return [...grouped.values()];
}

function statementHasChunkPath(sql, params, path) {
  if (!sql.startsWith('INSERT OR REPLACE INTO file_chunks')) return false;
  for (let index = 0; index < params.length; index += 3) {
    if (params[index] === path) return true;
  }
  return false;
}

// Strict byte boundary: exactly 1 MiB remains one transaction; one byte over
// is rejected before SQLite or live VFS state changes.
{
  const { harness, vfs } = openVfs();
  const exactChunks = chunks('exact-bytes.bin', MAX_TX_BLOB_BYTES / CHUNK_SIZE, CHUNK_SIZE);
  const revision = vfs.revision();
  assert.deepEqual(vfs.writeBatch({
    inodes: [inode('exact-bytes.bin', MAX_TX_BLOB_BYTES)],
    chunks: exactChunks,
  }), { inodes: 1, chunks: exactChunks.length });
  assert.equal(harness.transactionCount, 1);
  assert.equal(vfs.revision(), revision + 1);
  assert.equal(vfs.getStats().sql.transactions.blobBytes.last, MAX_TX_BLOB_BYTES);

  const before = {
    transactions: harness.transactionCount,
    revision: vfs.revision(),
    stats: vfs.getStats(),
  };
  const overChunks = [...chunks('over-bytes.bin', MAX_TX_BLOB_BYTES / CHUNK_SIZE, CHUNK_SIZE), {
    path: 'over-bytes.bin', chunkId: MAX_TX_BLOB_BYTES / CHUNK_SIZE, data: new Uint8Array(1),
  }];
  assertE2Big(() => vfs.writeBatch({
    inodes: [inode('over-bytes.bin', MAX_TX_BLOB_BYTES + 1)],
    chunks: overChunks,
  }), 'blobBytes');
  assert.equal(harness.transactionCount, before.transactions);
  assert.equal(vfs.revision(), before.revision);
  assert.equal(vfs.exists('over-bytes.bin'), false);
  assert.deepEqual(vfs.getStats().cache, before.stats.cache);
  assert.equal(vfs.getStats().sql.pendingWrites, before.stats.sql.pendingWrites);
  assert.equal(vfs.getStats().sql.pendingWriteBytes, before.stats.sql.pendingWriteBytes);
  assert.deepEqual(harness.sql.exec("SELECT path FROM inodes WHERE path = 'over-bytes.bin'"), []);
  assert.deepEqual(harness.sql.exec("SELECT path FROM file_chunks WHERE path = 'over-bytes.bin'"), []);

  const preserved = new Uint8Array(17);
  vfs.writeFile('preserved-pending.bin', preserved);
  const pendingBefore = vfs.getStats();
  const transactionBefore = harness.transactionCount;
  const statementBefore = harness.statementCount;
  const revisionBefore = vfs.revision();
  assertE2Big(() => vfs.writeBatch({
    inodes: [inode('preserved-pending.bin', MAX_TX_BLOB_BYTES + 1)],
    chunks: overChunks.map((chunk) => ({ ...chunk, path: 'preserved-pending.bin' })),
  }), 'blobBytes');
  assert.equal(harness.transactionCount, transactionBefore);
  assert.equal(harness.statementCount, statementBefore);
  assert.equal(vfs.revision(), revisionBefore);
  assert.deepEqual(vfs.getStats().cache, pendingBefore.cache);
  assert.equal(vfs.getStats().sql.pendingWrites, pendingBefore.sql.pendingWrites);
  assert.equal(vfs.getStats().sql.pendingWriteBytes, pendingBefore.sql.pendingWriteBytes);
  assert.deepEqual(vfs.readFile('preserved-pending.bin'), preserved);
}

// Logical row boundary reserves old chunks from inode metadata before delete,
// even when those rows are not currently present in SQLite.
{
  const { harness, vfs } = openVfs();
  vfs.writeBatch({
    inodes: [{ ...inode('old-row-boundary'), isDir: false, chunkCount: 250 }],
    chunks: [],
  });
  const exact = chunks('row-boundary', 5);
  assert.deepEqual(vfs.writeBatch({ inodes: [], chunks: exact, deletePaths: ['old-row-boundary'] }), {
    inodes: 0,
    chunks: 5,
  });
  assert.equal(harness.transactionCount, 2);
  assert.equal(vfs.getStats().sql.transactions.logicalRows.last, MAX_TX_LOGICAL_ROWS);
}
{
  const { harness, vfs } = openVfs();
  vfs.writeBatch({
    inodes: [{ ...inode('old-row-boundary-over'), isDir: false, chunkCount: 250 }],
    chunks: [],
  });
  assertE2Big(() => vfs.writeBatch({
    inodes: [],
    chunks: chunks('row-boundary-over', 6),
    deletePaths: ['old-row-boundary-over'],
  }), 'logicalRows');
  assert.equal(harness.transactionCount, 1);
  assert.equal(vfs.exists('old-row-boundary-over'), true);
}

// Metadata-only SQL execution boundary. Each inode plans one old-chunk delete,
// plus one grouped inode upsert per 12 rows: 59 + ceil(59 / 12) = 64.
{
  const { harness, vfs } = openVfs();
  const exact = Array.from({ length: 59 }, (_, index) => inode(`meta-${index}`));
  assert.deepEqual(vfs.writeBatch({ inodes: exact, chunks: [] }), { inodes: 59, chunks: 0 });
  assert.equal(harness.transactionCount, 1);
  assert.equal(transactionWrites(harness)[0].statements, MAX_TX_SQL_EXECS);
  assert.equal(vfs.getStats().sql.transactions.sqlExecs.last, MAX_TX_SQL_EXECS);
}
{
  const { harness, vfs } = openVfs();
  const over = Array.from({ length: 60 }, (_, index) => inode(`meta-over-${index}`));
  assertE2Big(() => vfs.writeBatch({ inodes: over, chunks: [] }), 'sqlExecs');
  assert.equal(harness.transactionCount, 0);
  assert.equal(vfs.getStats().files, 0);
  assert.equal(vfs.getStats().directories, 0);
}

// Empty work is explicit: it neither opens a transaction nor advances the
// revision. Metadata-only work above proves the non-empty counterpart.
{
  const { harness, vfs } = openVfs();
  assert.deepEqual(vfs.writeBatch({ inodes: [], chunks: [] }), { inodes: 0, chunks: 0 });
  assert.equal(harness.transactionCount, 0);
  assert.equal(vfs.revision(), 0);
}

// Pending flush packs whole files into bounded transactions. Four 512 KiB
// files become two exactly-1-MiB transactions and every recorded bounded
// transaction stays within all three limits.
{
  const { harness, vfs } = openVfs();
  const fileBytes = MAX_TX_BLOB_BYTES / 2;
  const firstTransaction = harness.transactionCount + 1;
  let duringSecondTransaction = null;
  harness.setFaultInjector(({ transaction }) => {
    if (transaction === firstTransaction + 1 && duringSecondTransaction === null) {
      duringSecondTransaction = vfs.getStats().sql;
    }
    return null;
  });
  for (let index = 0; index < 4; index++) {
    vfs.writeFile(`pending-${index}.bin`, new Uint8Array(fileBytes));
  }
  vfs.flushAll();
  const transactions = transactionWrites(harness, firstTransaction);
  assert.equal(transactions.length, 2);
  for (const transaction of transactions) {
    assert.equal(transaction.paths.size, 2);
    assert.ok(transaction.blobBytes <= MAX_TX_BLOB_BYTES);
    assert.ok(transaction.rows <= MAX_TX_LOGICAL_ROWS);
    assert.ok(transaction.statements <= MAX_TX_SQL_EXECS);
  }
  assert.ok(vfs.getStats().sql.transactions.boundedPeak.blobBytes <= MAX_TX_BLOB_BYTES);
  assert.ok(vfs.getStats().sql.transactions.boundedPeak.logicalRows <= MAX_TX_LOGICAL_ROWS);
  assert.ok(vfs.getStats().sql.transactions.boundedPeak.sqlExecs <= MAX_TX_SQL_EXECS);
  assert.ok(duringSecondTransaction);
  assert.equal(duringSecondTransaction.queuedWriteBytes.current, 0);
  assert.equal(duringSecondTransaction.inFlightWriteBytes.current, MAX_TX_BLOB_BYTES);
  assert.equal(
    duringSecondTransaction.retainedWriteBytes.current,
    MAX_TX_BLOB_BYTES,
    'committed prior groups must not remain retained outside telemetry',
  );
}

// Synchronous producers get backpressure only after a complete file has been
// queued. Byte and logical-row thresholds therefore bound the queue without
// reintroducing the old mid-file 500-entry split.
{
  const { harness, vfs } = openVfs();
  const firstTransaction = harness.transactionCount + 1;
  for (let index = 0; index < 40; index++) {
    vfs.writeFile(`sync-byte-${index}.bin`, new Uint8Array(CHUNK_SIZE));
  }
  assert.equal(harness.transactionCount - firstTransaction + 1, 2);
  assert.ok(vfs.getStats().sql.queuedWriteBytes.current < MAX_TX_BLOB_BYTES);
  vfs.flushAll();
  for (const transaction of transactionWrites(harness, firstTransaction)) {
    assert.ok(transaction.blobBytes <= MAX_TX_BLOB_BYTES);
  }
}
{
  const { harness, vfs } = openVfs();
  const firstTransaction = harness.transactionCount + 1;
  for (let index = 0; index < MAX_TX_LOGICAL_ROWS + 1; index++) {
    vfs.writeFile(`sync-row-${index}.bin`, new Uint8Array(1));
  }
  vfs.flushAll();
  assert.deepEqual(
    transactionWrites(harness, firstTransaction).map((transaction) => transaction.rows),
    [MAX_TX_LOGICAL_ROWS, 1],
  );
}

// An indivisible oversized file remains one transaction in Stage 2, is never
// split into a partial durable file, and is recorded for Stage 3 targeting.
{
  const { harness, vfs } = openVfs();
  const largeSize = MAX_TX_BLOB_BYTES + CHUNK_SIZE;
  const firstTransaction = harness.transactionCount + 1;
  vfs.writeFile('pending-over-limit.bin', new Uint8Array(largeSize));
  vfs.writeFile('pending-small.bin', new Uint8Array(CHUNK_SIZE));
  vfs.flushAll();
  const transactions = transactionWrites(harness, firstTransaction);
  assert.equal(transactions.length, 2);
  const largeTransactions = transactions.filter((transaction) => transaction.paths.has('pending-over-limit.bin'));
  assert.equal(largeTransactions.length, 1, 'an indivisible file must never span transactions');
  assert.equal(largeTransactions[0].blobBytes, largeSize);
  assert.deepEqual(
    harness.sql.exec("SELECT COUNT(*) AS count FROM file_chunks WHERE path = 'pending-over-limit.bin'"),
    [{ count: largeSize / CHUNK_SIZE }],
  );
  const overLimit = vfs.getStats().sql.transactions.overLimitFiles;
  assert.equal(overLimit.count, 1);
  assert.equal(overLimit.last.path, 'pending-over-limit.bin');
  assert.equal(overLimit.last.blobBytes, largeSize);
  assert.equal(overLimit.last.limit, 'blobBytes');
}

// A permanently failing over-limit file still executes as one indivisible
// transaction: no prefix is durable and all bytes remain retryable.
{
  const { harness, vfs } = openVfs();
  const data = new Uint8Array(CHUNK_SIZE * 34);
  harness.failOnTransactionStatement(2, {
    transaction: null,
    repeat: true,
    error: new Error('persistent oversized-file failure'),
  });
  vfs.writeFile('pending-over-limit-failure.bin', data);
  assert.deepEqual(
    harness.sql.exec("SELECT chunk_id FROM file_chunks WHERE path = 'pending-over-limit-failure.bin'"),
    [],
  );
  assert.equal(vfs.getStats().sql.queuedWriteBytes.current, data.length);
  assert.equal(vfs.getStats().sql.inFlightWriteBytes.current, 0);
  harness.clearFault();
  vfs.flushAll();
}

// A poisoned file does not starve later independent bounded plans. The
// durability boundary still reports the retained failure after good work lands.
{
  const { harness, vfs } = openVfs();
  harness.setFaultInjector(({ sql, params }) => (
    statementHasChunkPath(sql, params, 'bad-pending.bin')
      ? new Error('persistent bad path')
      : null
  ));
  vfs.writeFile('bad-pending.bin', new Uint8Array(MAX_TX_BLOB_BYTES));
  vfs.writeFile('good-pending.bin', new Uint8Array(MAX_TX_BLOB_BYTES));
  assert.deepEqual(
    harness.sql.exec("SELECT COUNT(*) AS count FROM file_chunks WHERE path = 'good-pending.bin'"),
    [{ count: MAX_TX_BLOB_BYTES / CHUNK_SIZE }],
  );
  assert.throws(() => vfs.flushAll(), /failed permanently/);
  assert.deepEqual(
    harness.sql.exec("SELECT chunk_id FROM file_chunks WHERE path = 'bad-pending.bin'"),
    [],
  );
  harness.clearFault();
  vfs.clearWriteFailures();
  vfs.flushAll();
}

// Existing writeBatchStream callers deliberately retain their Stage 2 v1
// spool-then-one-transaction behavior. Strict E2BIG is never silently routed
// here, but an already-streaming caller remains compatible until Stage 4.
{
  const { harness, vfs } = openVfs();
  const size = MAX_TX_BLOB_BYTES + 1;
  const streamedChunks = [
    ...chunks('stream-v1-over.bin', MAX_TX_BLOB_BYTES / CHUNK_SIZE, CHUNK_SIZE),
    { path: 'stream-v1-over.bin', chunkId: MAX_TX_BLOB_BYTES / CHUNK_SIZE, data: new Uint8Array(1) },
  ];
  const chunkIter = async function* () { yield* streamedChunks; };
  let duringStreamTransaction = null;
  harness.setFaultInjector(({ transaction }) => {
    if (transaction !== null && duringStreamTransaction === null) {
      duringStreamTransaction = vfs.getStats().sql;
    }
    return null;
  });
  assert.deepEqual(await vfs.writeStream({
    inodes: [inode('stream-v1-over.bin', size)],
    chunkIter: chunkIter(),
  }), { inodes: 1, chunks: streamedChunks.length });
  assert.equal(harness.transactionCount, 1);
  assert.equal(vfs.getStats().sql.transactions.last.limitMode, 'stage2-stream-unbounded');
  assert.equal(vfs.getStats().sql.phases.decodeDrainWaitMs.count, 1);
  assert.ok(duringStreamTransaction);
  assert.equal(duringStreamTransaction.decoderRetainedBytes.current, size);
  assert.equal(duringStreamTransaction.transactions.active, true);
  assert.equal(vfs.getStats().sql.decoderRetainedBytes.current, 0);
  assert.equal(vfs.getStats().sql.decoderRetainedBytes.peak, size);
}

// Retention telemetry transfers bytes from queued to in-flight ownership while
// SQLite holds the snapshot, then releases both after commit.
{
  const { harness, vfs } = openVfs();
  const data = new Uint8Array(CHUNK_SIZE * 2);
  vfs.writeFile('telemetry.bin', data);
  assert.equal(vfs.getStats().sql.queuedWriteBytes.current, data.length);
  let during = null;
  harness.setFaultInjector(({ transaction }) => {
    if (transaction !== null && during === null) during = vfs.getStats().sql;
    return null;
  });
  vfs.flushAll();
  assert.ok(during);
  assert.equal(during.queuedWriteBytes.current, 0);
  assert.equal(during.inFlightWriteBytes.current, data.length);
  assert.equal(during.retainedWriteBytes.current, data.length);
  assert.equal(during.transactions.active, true);
  assert.equal(during.transactions.blobBytes.current, data.length);
  assert.equal(during.transactions.logicalRows.current, 2);
  assert.equal(during.transactions.sqlExecs.current, 1);
  const after = vfs.getStats().sql;
  assert.equal(after.queuedWriteBytes.current, 0);
  assert.equal(after.inFlightWriteBytes.current, 0);
  assert.equal(after.retainedWriteBytes.current, 0);
  assert.ok(after.queuedWriteBytes.peak >= data.length);
  assert.ok(after.inFlightWriteBytes.peak >= data.length);
  assert.ok(after.retainedWriteBytes.peak >= data.length);
  assert.equal(after.transactions.durationMs.count, 1);
  assert.equal(after.transactions.postCommitDurationMs.count, 1);
  assert.equal(after.transactions.boundedPeak.blobBytes, data.length);
  assert.equal(after.transactions.boundedPeak.logicalRows, 2);
  assert.equal(after.transactions.boundedPeak.sqlExecs, 1);

  assert.deepEqual(after.creditRetainedBytes, { current: 0, peak: 0 });
  assert.deepEqual(after.stagedBytes, { current: 0, peak: 0 });
  assert.deepEqual(after.gcBytes, { current: 0, peak: 0 });
  assert.deepEqual(after.phases.creditWaitMs, {
    current: 0, count: 0, total: 0, last: 0, max: 0,
  });
}

// A failed transaction releases local in-flight ownership and restores the
// retryable queue without understating or double-counting retained bytes.
{
  const { harness, vfs } = openVfs();
  const data = new Uint8Array(CHUNK_SIZE);
  vfs.writeFile('telemetry-error.bin', data);
  harness.setFaultInjector(({ transaction }) => (
    transaction === null ? null : new Error('persistent telemetry failure')
  ));
  assert.throws(() => vfs.flushAll(), /failed permanently/);
  const failed = vfs.getStats().sql;
  assert.equal(failed.inFlightWriteBytes.current, 0);
  assert.equal(failed.queuedWriteBytes.current, data.length);
  assert.equal(failed.retainedWriteBytes.current, data.length);
  harness.clearFault();
  vfs.flushAll();
}

console.log('sqlite-vfs-stage2-transactions: all assertions passed');
