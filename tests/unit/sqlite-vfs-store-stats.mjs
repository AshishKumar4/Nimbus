#!/usr/bin/env bun
/**
 * sqlite-vfs-store-stats — storeStats reads the database's size as admission
 * does: workerd's databaseSize. A Durable Object's SQLite refuses
 * page_count, freelist_count and auto_vacuum (SQLITE_AUTH, measured live);
 * only a host without databaseSize falls back to pragma_page_count. Red
 * before: storeStats queried the pragma itself, and threw on workerd.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const refused = [];
/** SQL as a Durable Object's: its size from databaseSize, the page pragmas refused. */
const sql = {
  exec(query, ...params) {
    if (/page_count|freelist_count|auto_vacuum/i.test(query)) {
      refused.push(query);
      throw new Error('not authorized: SQLITE_AUTH');
    }
    return harness.sql.exec(query, ...params);
  },
  get databaseSize() {
    return 7 * 4096 + harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_inodes')[0].n * 4096;
  },
};

const raw = new SqliteVFS(sql, harness.ctx);
const vfs = raw.as(CRED_KERNEL);
vfs.mkdir('d');
for (let i = 0; i < 5; i++) vfs.writeFile(`d/f${i}`, `file ${i}`);
const stats = raw.storeStats();
assert.deepEqual(refused, [], 'storeStats asked SQLite for its pages');
assert.equal(stats.databaseBytes, sql.databaseSize, 'storeStats did not report the size admission reads');
assert.equal(stats.databaseBytes, raw.databaseBytes());
assert.equal(stats.chunks, 5);

console.log('sqlite-vfs-store-stats: ok');
