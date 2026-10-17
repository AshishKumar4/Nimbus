#!/usr/bin/env bun
// A snapshot's restore and its drop write in transactions the shared budget
// admits (MAX_TX_LOGICAL_ROWS, MAX_TX_SQL_EXECS), however many paths a page
// reads, and lose nothing doing so:
//   - restore of 300 root files, each changed since the snapshot, and 60
//     the snapshot had that were removed since: every one is the
//     snapshot's again;
//   - drop of a snapshot whose 300 history rows each hold a reference no
//     one else does: every row is gone, every reference queued, and the
//     space comes back once collected.
// The engine's transaction peaks (getStats) stay within the budget.
//
// Red before: one page of 200 paths was one transaction, 600 logical rows
// for a restore and 401 for a drop, past the 256 the envelope allows.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { MAX_TX_LOGICAL_ROWS, MAX_TX_SQL_EXECS } from '../../packages/platform/src/limits.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const text = (bytes) => new TextDecoder().decode(bytes);
const FILES = 300;
const GONE = 60;

function within(vfs, label) {
  const { logicalRows, sqlExecs } = vfs.getStats().sql.transactions.boundedPeak;
  assert.ok(logicalRows <= MAX_TX_LOGICAL_ROWS, `${label}: ${logicalRows} logical rows in one transaction`);
  assert.ok(sqlExecs <= MAX_TX_SQL_EXECS, `${label}: ${sqlExecs} statements in one transaction`);
}

const failed = [];
async function check(name, run) {
  try {
    await run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}: ${String(error?.message ?? error).split('\n').slice(0, 3).join(' | ')}`);
    failed.push(name);
  }
}

await check('restore', () => {
  const h = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(h.sql, h.ctx);
  const fs = vfs.as(CRED_KERNEL);
  for (let i = 0; i < FILES + GONE; i++) fs.writeFile(`f${i}`, enc.encode(`before ${i}`));
  vfs.snapshot('s');
  for (let i = 0; i < FILES; i++) fs.writeFile(`f${i}`, enc.encode(`after ${i}`));
  for (let i = FILES; i < FILES + GONE; i++) fs.unlink(`f${i}`);
  within(vfs, 'the writes');
  const { restored } = vfs.restore('s');
  assert.equal(restored, FILES + GONE, 'every path restored');
  for (let i = 0; i < FILES + GONE; i++) assert.equal(text(fs.readFile(`f${i}`)), `before ${i}`, `f${i}`);
  within(vfs, 'the restore');
  h.db.close();
});

await check('drop', async () => {
  const h = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(h.sql, h.ctx);
  const fs = vfs.as(CRED_KERNEL);
  for (let i = 0; i < FILES; i++) fs.writeFile(`f${i}`, enc.encode(`only the snapshot holds ${i}`));
  vfs.snapshot('s');
  for (let i = 0; i < FILES; i++) fs.writeFile(`f${i}`, enc.encode(`live ${i}`));
  const history = () => Number([...h.sql.exec('SELECT COUNT(*) AS n FROM vfs_inode_history')][0].n);
  assert.equal(history(), FILES, 'each file has its snapshot\'s row');
  const { dropped } = vfs.dropSnapshot('s');
  assert.equal(dropped, FILES, 'every history row dropped');
  assert.equal(history(), 0, 'none left');
  vfs.runContentMaintenance(64);
  const kept = [...h.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')][0].n;
  assert.equal(Number(kept), FILES, 'only the live files\' chunks remain once collected');
  for (let i = 0; i < FILES; i++) assert.equal(text(fs.readFile(`f${i}`)), `live ${i}`);
  within(vfs, 'the drop');
  h.db.close();
});

assert.deepEqual(failed, [], 'every job stays within the budget and keeps its work');
console.log('sqlite-vfs-snapshot-job-budget: ok');
