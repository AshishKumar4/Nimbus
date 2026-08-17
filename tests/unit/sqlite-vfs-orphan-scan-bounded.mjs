#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const PAGE_SIZE = 50;

function openVfs(harness = createSqliteVfsTestHarness()) {
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, rawVfs, vfs: rawVfs.as(CRED_KERNEL) };
}

function bytes(length, seed = 0) {
  const data = new Uint8Array(length);
  for (let index = 0; index < length; index++) data[index] = (index + seed) % 251;
  return data;
}

function seedReferencedContent(harness, count) {
  const insertInode = harness.db.prepare(
    `INSERT INTO inodes (path, parent_path, kind, size, mtime, mode, chunk_count, content_id)
     VALUES (?, 'bulk', 0, 4, 1, 420, 1, ?)`,
  );
  const insertChunk = harness.db.prepare(
    'INSERT INTO file_chunks (content_id, chunk_id, data) VALUES (?, 0, ?)',
  );
  const payload = bytes(4, 11);
  harness.db.transaction(() => {
    for (let index = 0; index < count; index++) {
      const generated = `/content:bulk-${String(index).padStart(8, '0')}`;
      insertInode.run(`bulk/file-${index}`, generated);
      insertChunk.run(generated, payload);
    }
  })();
}

function seedOrphan(harness, contentId) {
  harness.sql.exec(
    'INSERT INTO file_chunks (content_id, chunk_id, data) VALUES (?, 0, ?)',
    contentId,
    bytes(3, 29),
  );
}

function gcStates(harness) {
  return harness.sql
    .exec("SELECT content_id FROM content_lifecycle WHERE state = 'gc' ORDER BY content_id")
    .map((row) => String(row.content_id));
}

function orphanChunkCount(harness, contentId) {
  return harness.sql.exec(
    'SELECT COUNT(*) AS n FROM file_chunks WHERE content_id = ?',
    contentId,
  ).map((row) => Number(row.n))[0];
}

// One maintenance call scans exactly one keyset page of distinct content ids,
// no matter how large the chunk table is. A genuine orphan seeded beyond the
// first page (ids sort after every referenced generation) must therefore stay
// untouched after a single call — an unbounded scan would find it immediately.
{
  const { harness, rawVfs } = openVfs();
  seedReferencedContent(harness, PAGE_SIZE * 3);
  seedOrphan(harness, 'zzz:distant-orphan');

  rawVfs.runContentMaintenance(4);
  assert.deepEqual(gcStates(harness), [],
    'one bounded maintenance call must not reach an orphan beyond its keyset page');
  assert.equal(orphanChunkCount(harness, 'zzz:distant-orphan'), 1);
}

// The walk is complete over time: successive calls advance the persisted
// cursor page by page until the distant orphan is enqueued and collected.
{
  const { harness, rawVfs } = openVfs();
  const referenced = PAGE_SIZE * 3;
  seedReferencedContent(harness, referenced);
  seedOrphan(harness, 'zzz:distant-orphan');

  const maxCalls = Math.ceil((referenced + 1) / PAGE_SIZE) + 2;
  let collected = false;
  for (let call = 0; call < maxCalls && !collected; call++) {
    rawVfs.runContentMaintenance(4);
    collected = orphanChunkCount(harness, 'zzz:distant-orphan') === 0;
  }
  assert.ok(collected, `distant orphan still present after ${maxCalls} maintenance calls`);
  assert.deepEqual(gcStates(harness), [], 'collected orphan must not leave a lifecycle row');
}

// The cursor wraps: an orphan seeded behind an already-advanced cursor is
// found by later passes.
{
  const { harness, rawVfs } = openVfs();
  const referenced = PAGE_SIZE * 3;
  seedReferencedContent(harness, referenced);

  rawVfs.runContentMaintenance(4);
  rawVfs.runContentMaintenance(4);
  seedOrphan(harness, '/content:aaa-behind-cursor');

  const maxCalls = 2 * Math.ceil((referenced + 1) / PAGE_SIZE) + 2;
  let collected = false;
  for (let call = 0; call < maxCalls && !collected; call++) {
    rawVfs.runContentMaintenance(4);
    collected = orphanChunkCount(harness, '/content:aaa-behind-cursor') === 0;
  }
  assert.ok(collected, `behind-cursor orphan still present after ${maxCalls} maintenance calls`);
}

// Referenced content survives full passes of the walk, and a drained walk
// settles: once no work remains, maintenance runs no transactions.
{
  const { harness, rawVfs } = openVfs();
  const referenced = PAGE_SIZE * 2 + 7;
  seedReferencedContent(harness, referenced);
  seedOrphan(harness, 'zzz:distant-orphan');

  for (let call = 0; call < Math.ceil((referenced + 1) / PAGE_SIZE) + 2; call++) {
    rawVfs.runContentMaintenance(4);
  }
  assert.equal(orphanChunkCount(harness, 'zzz:distant-orphan'), 0);
  const total = harness.sql.exec('SELECT COUNT(*) AS n FROM file_chunks')
    .map((row) => Number(row.n))[0];
  assert.equal(total, referenced, 'referenced generations must survive the walk');
  assert.deepEqual(rawVfs.runContentMaintenance(4), { transactions: 0 });
}

console.log('sqlite-vfs orphan scan bounded: all tests passed');
