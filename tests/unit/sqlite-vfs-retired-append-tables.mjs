#!/usr/bin/env bun
// The append protocol's tables (fsAppend/fsAppendAck, both generations) are
// retired: a process's write log carries its appends as numbered calls. A
// store that still has them, rows and all, loses them when it opens, and
// keeps everything else it held.

import assert from 'node:assert/strict';
import { SqliteVFS, STORE_TABLES } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const RETIRED = [
  'vfs_append_receipts_v2', 'vfs_append_writer_state_v2', 'vfs_append_module_state_v2',
  'vfs_append_pid_revocations_v2', 'vfs_append_acked_gaps_v2',
  'vfs_append_receipts', 'vfs_append_writer_state', 'vfs_append_module_state',
  'vfs_append_pid_revocations', 'vfs_append_acked_gaps',
];
const tables = (harness) => new Set([...harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'")].map((row) => String(row.name)));

const harness = createSqliteVfsTestHarness();
const first = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
first.mkdir('home/user', { recursive: true });
first.writeFile('home/user/kept.txt', 'kept');
// What an older store left: each table, with a row in it.
for (const table of RETIRED) {
  harness.sql.exec(`CREATE TABLE ${table} (namespace TEXT, pid INTEGER, writer_id TEXT, operation_id INTEGER)`);
  harness.sql.exec(`INSERT INTO ${table} VALUES ('', 7, 'w', 1)`);
}
assert.ok(RETIRED.every((table) => tables(harness).has(table)));

const reopened = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
const after = tables(harness);
for (const table of RETIRED) assert.equal(after.has(table), false, `${table} survived the store opening`);
assert.equal(reopened.readFileString('home/user/kept.txt'), 'kept', 'the store lost what it kept');
for (const table of STORE_TABLES) assert.equal(RETIRED.includes(table), false, `${table} is retired and kept`);

// A fresh store never makes them.
const fresh = createSqliteVfsTestHarness();
new SqliteVFS(fresh.sql, fresh.ctx);
assert.equal(RETIRED.some((table) => tables(fresh).has(table)), false);
console.log('sqlite-vfs-retired-append-tables: ok');
