#!/usr/bin/env bun
/**
 * sqlite-vfs-chunk-rollback — compacted chunks under a release before their
 * reader. Production rolls back with `wrangler versions deploy <previous>`,
 * which runs that release's engine over the database this one wrote. The
 * reader ships a release before anything writes a compacted chunk, so one
 * rollback never meets one; this pins the case two rollbacks would: a release
 * before the reader (recorded in tests/fixtures/released-engine) must fail on
 * a deflated or tried chunk, never return what the row stores. Its own writes
 * stay readable, and rolled forward, this engine reads everything.
 */

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteVFS as ReleasedVFS, CRED_KERNEL as RELEASED_KERNEL } from '../fixtures/released-engine/sqlite-vfs-882d546fac16.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const DEFLATED = 3;
const KEPT = 4;

function source(length, seed) {
  let text = '';
  for (let i = 0; text.length < length; i++) text += `export const value_${(seed * 31 + i) % 997} = await load(${i});\n`;
  return new TextEncoder().encode(text.slice(0, length));
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function chunkIds(db, path) {
  return db.query(`
    SELECT c.id FROM vfs_inodes i JOIN vfs_chunks c ON c.id = i.chunk_id WHERE i.path = ?1
    UNION ALL
    SELECT m.chunk_id FROM vfs_inodes i JOIN vfs_content_chunks m ON m.content_id = i.content_id WHERE i.path = ?1`).all(path).map((row) => row.id);
}

const db = new Database(':memory:');
const files = {
  'p/deflated.js': source(8_000, 1),
  'p/kept.js': source(8_000, 2),
  'p/large.js': source(300_000, 3),
  'p/raw.js': source(8_000, 4),
};

// This engine writes; its rows are then compacted as the background pass will.
{
  const harness = createSqliteVfsTestHarness(db);
  const vfs = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  vfs.mkdir('p');
  for (const [path, bytes] of Object.entries(files)) vfs.writeFile(path, bytes);
  const compact = (id, state) => {
    const [row] = db.query('SELECT data FROM vfs_chunks WHERE id = ?').all(id);
    db.query('UPDATE vfs_chunks SET data = ?, state = ? WHERE id = ?')
      .run(state === DEFLATED ? new Uint8Array(deflateRawSync(row.data)) : row.data, state, id);
  };
  for (const id of chunkIds(db, 'p/deflated.js')) compact(id, DEFLATED);
  for (const id of chunkIds(db, 'p/kept.js')) compact(id, KEPT);
  for (const id of chunkIds(db, 'p/large.js')) compact(id, DEFLATED);
}

// The release before the reader reads the same database.
{
  const harness = createSqliteVfsTestHarness(db);
  const raw = new ReleasedVFS(harness.sql, harness.ctx);
  const vfs = raw.as(RELEASED_KERNEL);
  assert.deepEqual(vfs.readFile('p/raw.js'), files['p/raw.js'], 'it opens this database and reads a chunk stored as written');
  const refused = (error) => error.code === 'ENODATA';
  for (const path of ['p/deflated.js', 'p/kept.js', 'p/large.js']) {
    assert.throws(() => vfs.readFile(path), refused, `${path}: a whole read did not fail`);
    assert.throws(() => vfs.readRange(path, 100, 50), refused, `${path}: a ranged read did not fail`);
    assert.throws(() => vfs.readRangeUncached(path, 100, 50), refused, `${path}: an uncached read did not fail`);
  }
  assert.throws(() => vfs.writeRange('p/deflated.js', 10, new Uint8Array([65])), refused, 'a rewrite read nothing first');
  assert.throws(() => raw.exportChunks([sha(files['p/deflated.js'])]), refused, 'an export did not fail');
  // Its write of bytes a compacted chunk names stores them as written, for both names.
  vfs.writeFile('p/copy.js', files['p/deflated.js']);
  assert.deepEqual(vfs.readFile('p/copy.js'), files['p/deflated.js']);
  assert.deepEqual(vfs.readFile('p/deflated.js'), files['p/deflated.js']);
  vfs.writeFile('p/new.js', source(9_000, 5));
}

// Rolled forward, this engine reads what both wrote.
{
  const harness = createSqliteVfsTestHarness(db);
  const vfs = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  for (const [path, bytes] of Object.entries(files)) assert.deepEqual(vfs.readFile(path), bytes, path);
  assert.deepEqual(vfs.readFile('p/copy.js'), files['p/deflated.js']);
  assert.deepEqual(vfs.readFile('p/new.js'), source(9_000, 5));
}

console.log('sqlite-vfs-chunk-rollback: ok');
