#!/usr/bin/env bun
// writeStream publishes whole files in bounded groups rather than one file at
// a time. Publishing per file cost three transactions each — stage the content
// row, flush the chunks, publish the pointer — which at ~0.9 ms of commit
// apiece made writing an npm install's 19,429 files the dominant term of the
// install and stalled every download shard behind one Durable Object's
// storage queue.
//
// What must not change: a file is never visible with partial or foreign
// content, ownership and mode are inherited exactly as a solo publication
// inherits them, a bound is asserted rather than truncated, and any failure
// leaves a state the replay completes correctly.

import assert from 'node:assert/strict';
import {
  CHUNK_SIZE,
  MAX_TX_BLOB_BYTES,
  MAX_TX_LOGICAL_ROWS,
  MAX_TX_SQL_EXECS,
} from '../../packages/platform/src/limits.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
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

function fileInode(path, data, mode = 0o644) {
  return {
    path,
    parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    isDir: false,
    size: data.length,
    mtime: 1,
    mode,
    chunkCount: data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE),
  };
}

function chunksOf(path, data) {
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

function streamPayload(entries, directories = []) {
  return {
    inodes: [
      ...directories.map((path) => ({
        path,
        parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
        isDir: true,
        size: 0,
        mtime: 1,
        mode: 0o755,
        chunkCount: 0,
      })),
      ...entries.map(({ path, data, mode }) => fileInode(path, data, mode)),
    ],
    chunks: entries.flatMap(({ path, data }) => chunksOf(path, data)),
  };
}

async function collectStream(stream) {
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
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

/** Offset of the final record (batch-end), walking the 5-byte envelopes. */
function lastRecordOffset(frame) {
  let offset = 4;
  let last = offset;
  while (offset < frame.length) {
    const length = (
      frame[offset + 1]
      | (frame[offset + 2] << 8)
      | (frame[offset + 3] << 16)
      | (frame[offset + 4] << 24)
    ) >>> 0;
    last = offset;
    offset += 5 + length;
  }
  return last;
}

function assertBounded(stats) {
  assert.ok(stats.sql.transactions.boundedPeak.blobBytes <= MAX_TX_BLOB_BYTES);
  assert.ok(stats.sql.transactions.boundedPeak.logicalRows <= MAX_TX_LOGICAL_ROWS);
  assert.ok(stats.sql.transactions.boundedPeak.sqlExecs <= MAX_TX_SQL_EXECS);
  assert.equal(stats.sql.transactions.overLimitFiles.count, 0);
}

// A tree of small files costs far fewer transactions than it has files, and
// every byte of every file survives a reopen. 120 files plus two directories
// is one full W7 batch (the frame caps a stream at 128 owned paths, which is
// also the install facet's wave size).
{
  const { harness, rawVfs, vfs } = openVfs();
  const entries = Array.from({ length: 120 }, (_, index) => ({
    path: `pkg/lib/file-${index}.js`,
    data: bytes(200 + index, index),
  }));
  const before = harness.transactionCount;
  const result = await vfs.writeStream(
    encodeWriteBatchStream(streamPayload(entries, ['pkg', 'pkg/lib'])),
  );
  const transactions = harness.transactionCount - before;
  assert.equal(result.ok, true);
  assert.equal(result.committedPathCount, entries.length + 2);
  assert.equal(result.inodes, entries.length + 2);
  assert.equal(result.chunks, entries.length);

  // Per-file publication cost three transactions each. The row bound admits
  // dozens of these files per transaction, so the ceiling is a small fraction
  // of the file count; a regression to per-file commits breaks this.
  assert.ok(
    transactions <= entries.length / 4,
    `${transactions} transactions for ${entries.length} files`,
  );

  const reconstructed = reopenVfs(harness);
  for (const entry of entries) {
    assert.deepEqual(reconstructed.readFile(entry.path), entry.data);
  }
  assert.equal(reconstructed.readdir('pkg/lib').length, entries.length);
  assertBounded(rawVfs.getStats());
}

// Sharing a transaction changes nothing a caller can observe: publishing two
// files together produces the same ownership, mode and superseded-content
// bookkeeping as publishing each of them in a stream of its own.
{
  const replaced = { path: 'owned/kept.txt', data: bytes(9, 1) };
  const fresh = { path: 'owned/fresh.txt', data: bytes(9, 2) };
  const seed = (vfs) => {
    vfs.mkdir('owned', { recursive: true });
    vfs.writeFile('owned/kept.txt', 'v1');
    vfs.chown('owned/kept.txt', 1234, 5678);
    vfs.chmod('owned/kept.txt', 0o600);
  };
  const describe = (harness, vfs) => ({
    stats: [replaced, fresh].map((entry) => {
      const stat = vfs.stat(entry.path);
      return { uid: stat.uid, gid: stat.gid, mode: stat.mode, size: stat.size };
    }),
    liveContent: harness.sql
      .exec("SELECT COUNT(*) AS n FROM content_lifecycle WHERE state = 'staging'")[0].n,
  });

  const together = openVfs();
  seed(together.vfs);
  const priorContent = together.harness.sql.exec(
    "SELECT content_id FROM inodes WHERE path = 'owned/kept.txt'",
  )[0].content_id;
  assert.equal(
    (await together.vfs.writeStream(encodeWriteBatchStream(streamPayload([replaced, fresh])))).ok,
    true,
  );

  const apart = openVfs();
  seed(apart.vfs);
  for (const entry of [replaced, fresh]) {
    assert.equal(
      (await apart.vfs.writeStream(encodeWriteBatchStream(streamPayload([entry])))).ok,
      true,
    );
  }

  assert.deepEqual(
    describe(together.harness, reopenVfs(together.harness)),
    describe(apart.harness, reopenVfs(apart.harness)),
  );

  // The superseded generation is unreferenced rather than left pinned.
  const live = new Set(
    together.harness.sql
      .exec('SELECT content_id FROM inodes WHERE content_id IS NOT NULL')
      .map((row) => row.content_id),
  );
  assert.equal(live.has(priorContent), false);
}

// A file larger than one transaction is alone in its group: it stages across
// bounded transactions and publishes on the last of them.
{
  const { harness, rawVfs, vfs } = openVfs();
  const small = { path: 'before.bin', data: bytes(32, 3) };
  const large = { path: 'large.bin', data: bytes(MAX_TX_BLOB_BYTES * 2 + 1, 4) };
  const after = { path: 'after.bin', data: bytes(32, 5) };
  const result = await vfs.writeStream(
    encodeWriteBatchStream(streamPayload([small, large, after])),
  );
  assert.equal(result.ok, true);
  assert.equal(result.committedPathCount, 3);
  assert.equal(result.chunks, 1 + Math.ceil(large.data.length / CHUNK_SIZE) + 1);
  const reconstructed = reopenVfs(harness);
  for (const entry of [small, large, after]) {
    assert.deepEqual(reconstructed.readFile(entry.path), entry.data);
  }
  assertBounded(rawVfs.getStats());
  // Nothing is left staged: every content row the stream created is either
  // referenced by an inode or gone.
  assert.equal(
    harness.sql.exec("SELECT COUNT(*) AS n FROM content_lifecycle WHERE state = 'staging'")[0].n,
    0,
  );
}

// A fault at any statement of the group's transaction leaves nothing from
// that group visible, no file half-written, and a replay that converges.
{
  const entries = [
    { path: 'crash/a.txt', data: bytes(24, 1) },
    { path: 'crash/b.txt', data: bytes(24, 2) },
    { path: 'crash/c.txt', data: bytes(24, 3) },
  ];
  // How many statements the group's single transaction runs, so every one of
  // them can be faulted in turn.
  const { harness: probe, vfs: probeVfs } = openVfs();
  probeVfs.mkdir('crash', { recursive: true });
  const groupTransaction = probe.transactionCount + 1;
  await probeVfs.writeStream(encodeWriteBatchStream(streamPayload(entries)));
  const statementCount = probe.statements
    .filter((s) => s.transaction === groupTransaction).length;
  assert.ok(statementCount > 0, 'expected the group to commit in one transaction');

  for (let statement = 1; statement <= statementCount; statement++) {
    const { harness, vfs } = openVfs();
    vfs.mkdir('crash', { recursive: true });
    harness.failOnTransactionStatement(statement, {
      transaction: harness.transactionCount + 1,
      error: new Error(`injected group fault at ${statement}`),
    });
    const failed = await vfs.writeStream(encodeWriteBatchStream(streamPayload(entries)));
    harness.clearFault();
    assert.equal(failed.ok, false, `statement ${statement} should have faulted`);
    assert.equal(failed.committedPathCount, 0);

    const afterCrash = reopenVfs(harness);
    for (const entry of entries) {
      assert.equal(
        afterCrash.exists(entry.path),
        false,
        `${entry.path} visible after a fault at statement ${statement}`,
      );
    }

    const replay = await vfs.writeStream(encodeWriteBatchStream(streamPayload(entries)));
    assert.equal(replay.ok, true);
    assert.equal(replay.committedPathCount, entries.length);
    const converged = reopenVfs(harness);
    for (const entry of entries) {
      assert.deepEqual(converged.readFile(entry.path), entry.data);
    }
  }
}

// Replaying a stream that already committed is idempotent: the same paths,
// the same bytes, and no duplicate inodes.
{
  const { harness, vfs } = openVfs();
  const entries = Array.from({ length: 40 }, (_, index) => ({
    path: `idem/file-${index}.txt`,
    data: bytes(64 + index, index),
  }));
  const payload = () => streamPayload(entries, ['idem']);
  assert.equal((await vfs.writeStream(encodeWriteBatchStream(payload()))).ok, true);
  assert.equal((await vfs.writeStream(encodeWriteBatchStream(payload()))).ok, true);
  const reconstructed = reopenVfs(harness);
  for (const entry of entries) {
    assert.deepEqual(reconstructed.readFile(entry.path), entry.data);
  }
  assert.equal(
    harness.sql.exec("SELECT COUNT(*) AS n FROM inodes WHERE path LIKE 'idem/%'")[0].n,
    entries.length,
  );
  assert.equal(reconstructed.readdir('idem').length, entries.length);
}

// The mutation guard is re-checked where the group commits, not only where
// each file was accepted. A group commits after the records that follow it,
// and the loop awaits the decoder between them, so another request on this
// object can take an overlapping lease inside that window.
{
  const { harness, rawVfs, vfs } = openVfs();
  const entries = [
    { path: 'locked/a.txt', data: bytes(16, 1) },
    { path: 'locked/b.txt', data: bytes(16, 2) },
  ];
  vfs.mkdir('locked', { recursive: true });

  // Split immediately before batch-end: every file has been accepted and no
  // further authorisation happens, so only the group flush is left.
  const encoded = await collectStream(encodeWriteBatchStream(streamPayload(entries)));
  const batchEndOffset = lastRecordOffset(encoded);
  let lease = null;
  const paused = new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      if (this.sent === undefined) {
        this.sent = true;
        controller.enqueue(encoded.slice(0, batchEndOffset));
        return;
      }
      if (lease === null) {
        lease = rawVfs.acquireExclusiveMutation('locked');
        controller.enqueue(encoded.slice(batchEndOffset));
        return;
      }
      controller.close();
    },
  });

  const blocked = await vfs.writeStream(paused);
  assert.notEqual(lease, null, 'expected a lease to be taken before batch-end');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.phase, 'publish');
  assert.match(blocked.error.message, /EBUSY/);
  assert.equal(blocked.committedPathCount, 0);
  const duringLease = reopenVfs(harness);
  for (const entry of entries) assert.equal(duringLease.exists(entry.path), false);

  rawVfs.releaseExclusiveMutation(lease.owner);
  const replay = await vfs.writeStream(encodeWriteBatchStream(streamPayload(entries)));
  assert.equal(replay.ok, true);
  const converged = reopenVfs(harness);
  for (const entry of entries) assert.deepEqual(converged.readFile(entry.path), entry.data);
}

// A delete observes every write the stream made before it, even though those
// writes are now batched rather than committed one path at a time.
{
  const { harness, vfs } = openVfs();
  const result = await vfs.writeStream(encodeWriteBatchStream({
    ...streamPayload([
      { path: 'ordered/keep.txt', data: bytes(8, 1) },
    ], ['ordered']),
    deletePaths: ['stale'],
  }));
  assert.equal(result.ok, true);
  const reconstructed = reopenVfs(harness);
  assert.deepEqual(reconstructed.readFile('ordered/keep.txt'), bytes(8, 1));
  assert.equal(reconstructed.exists('stale'), false);
}

console.log('sqlite-vfs-write-stream-grouping: ok');
