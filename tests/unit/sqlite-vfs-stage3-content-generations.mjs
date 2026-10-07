#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  CHUNK_SIZE,
  MAX_TX_BLOB_BYTES,
  MAX_TX_LOGICAL_ROWS,
  MAX_TX_SQL_EXECS,
} from '../../packages/platform/src/limits.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { bytes, fileChunks, fileInode, openVfs, reopenVfs } from './lib/staged-import.mjs';

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

function contentId(harness, path) {
  const rows = harness.sql.exec('SELECT content_id FROM vfs_inodes WHERE path = ?', path);
  assert.equal(rows.length, 1, `expected one inode for ${path}`);
  return rows[0].content_id;
}

function createLargeReplacementFixture() {
  const opened = openVfs();
  const oldData = bytes(MAX_TX_BLOB_BYTES * 2 + CHUNK_SIZE, 7);
  const newData = bytes(MAX_TX_BLOB_BYTES * 2 + CHUNK_SIZE, 137);
  opened.vfs.writeFile('atomic-large.bin', oldData);
  return { ...opened, oldData, newData, transactionStart: opened.harness.transactionCount };
}

/** Classify a large write's transactions: staging (manifest rows, no inode), publish (the inode), gc. */
function replacementTransactions(harness, statementStart) {
  const groups = transactionGroups(harness, statementStart);
  const stage = [];
  let publish = null;
  let gc = null;
  for (const [transaction, statements] of groups) {
    const publishes = statements.some((statement) => /INTO vfs_inodes/i.test(statement.sql));
    if (!publishes && statements.some((statement) => /INSERT INTO vfs_content(s|_chunks)\b/i.test(statement.sql))) {
      stage.push({ transaction, statements });
    }
    if (publishes) publish = { transaction, statements };
    if (statements.some((statement) => /^\s*(DELETE FROM vfs_chunks|UPDATE vfs_contents SET state = 2)/i.test(statement.sql))) {
      gc = { transaction, statements };
    }
  }
  return { groups, stage, publish, gc };
}

function assertBounded(metrics, label) {
  assert.ok(metrics.blobBytes <= MAX_TX_BLOB_BYTES, `${label}: blob byte bound`);
  assert.ok(metrics.logicalRows <= MAX_TX_LOGICAL_ROWS, `${label}: logical row bound`);
  assert.ok(metrics.sqlExecs <= MAX_TX_SQL_EXECS, `${label}: SQL execution bound`);
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
  assert.ok(classified.stage.length >= 2, `large content spans bounded staging transactions (${classified.stage.length})`);
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
    inodes: entries.map(({ path, data }) => fileInode(path, data.length)),
    chunks: entries.flatMap(({ path, data }) => fileChunks(path, data)),
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

// Storage failure inside a publish group commits none of that group: files
// that had already been accepted stay absent, a replaced file keeps its old
// content, and replaying the whole stream converges to the requested bytes.
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
    /INSERT OR REPLACE INTO vfs_inodes/i.test(sql) && params.includes('prefix-b.bin')
      ? new Error('injected publish failure')
      : null
  ));
  const failed = await vfs.writeStream(encodeWriteBatchStream(payload));
  harness.clearFault();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.phase, 'publish');
  assert.equal(failed.committedGroupSequence, 0);
  assert.equal(failed.committedPathCount, 0);
  assert.equal(reopenVfs(harness).exists('prefix-a.bin'), false);
  assert.deepEqual(reopenVfs(harness).readFile('prefix-b.bin'), oldB);
  assert.equal(reopenVfs(harness).exists('prefix-c.bin'), false);

  const replay = await vfs.writeStream(encodeWriteBatchStream(streamPayload(entries)));
  assert.equal(replay.ok, true);
  assert.equal(replay.committedGroupSequence, 1);
  assert.equal(replay.committedPathCount, 3);
  const reconstructed = reopenVfs(harness);
  for (const entry of entries) assert.deepEqual(reconstructed.readFile(entry.path), entry.data);
}

// Groups that already committed are the committed prefix. A file larger than
// one transaction closes the group before it, so the failure that lands in the
// second group cannot unmake the first.
{
  const { harness, vfs } = openVfs();
  const entries = [
    { path: 'group-a.bin', data: bytes(5, 10) },
    { path: 'group-b.bin', data: bytes(MAX_TX_BLOB_BYTES + 1, 20) },
  ];
  harness.setFaultInjector(({ sql, params }) => (
    /INSERT OR REPLACE INTO vfs_inodes/i.test(sql) && params.includes('group-b.bin')
      ? new Error('injected second-group publish failure')
      : null
  ));
  const failed = await vfs.writeStream(encodeWriteBatchStream(streamPayload(entries)));
  harness.clearFault();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.phase, 'publish');
  assert.equal(failed.committedGroupSequence, 1);
  assert.equal(failed.committedPathCount, 1);
  const reconstructed = reopenVfs(harness);
  assert.deepEqual(reconstructed.readFile('group-a.bin'), entries[0].data);
  assert.equal(reconstructed.exists('group-b.bin'), false);

  const replay = await vfs.writeStream(encodeWriteBatchStream(streamPayload(entries)));
  assert.equal(replay.ok, true);
  const converged = reopenVfs(harness);
  for (const entry of entries) assert.deepEqual(converged.readFile(entry.path), entry.data);
}

// Decoder failure mid-file abandons the whole pending group: neither the
// complete path nor the incomplete one is durable, and the replay converges.
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
  assert.equal(failed.committedGroupSequence, 0);
  assert.equal(failed.committedPathCount, 0);
  const reconstructed = reopenVfs(harness);
  assert.equal(reconstructed.exists(first.path), false);
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
  const duplicate = fileInode('duplicate.bin', data.length);
  assert.throws(() => encodeWriteBatchStream({
    inodes: [duplicate, { ...duplicate, mtime: duplicate.mtime + 1 }],
    chunks: fileChunks(duplicate.path, data),
  }), /duplicate path ownership/);
  assert.equal(vfs.exists('duplicate.bin'), false);
}

console.log('sqlite-vfs-stage3-content-generations: all assertions passed');
