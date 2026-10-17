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
//   - a restore whose transaction ends between a directory and an entry of
//     it (a file the snapshot had, made a directory with an entry since):
//     the directory, stamped by its entry's removal, is still restored, at
//     each size about the boundary, and through restoreAsync's slices;
//   - a subtree restore leaves its root's parent and siblings;
//   - a restore reset after the transaction that noted such a directory,
//     finished by the reopened engine; and a write to that directory
//     before it resumes, which stands;
//   - a drop interrupted after its first transaction (the store refusing
//     the next): reopened, the engine finishes it, every dead row dropped
//     and those an older snapshot covers kept, interleaved with them in the
//     order the drop pages them;
//   - dropSnapshotAsync, in slices, the same.
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

// A file the snapshot had, a directory with an entry since, after the entry's own change.
async function directoryOverFile(files, async) {
  const h = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(h.sql, h.ctx);
  const fs = vfs.as(CRED_KERNEL);
  for (let i = 0; i < files; i++) fs.writeFile(`f${i}`, enc.encode(`before ${i}`));
  fs.writeFile('p', enc.encode('the file p'));
  vfs.snapshot('s');
  for (let i = 0; i < files; i++) fs.writeFile(`f${i}`, enc.encode(`after ${i}`));
  fs.unlink('p');
  fs.mkdir('p');
  fs.writeFile('p/new', enc.encode('new'));
  fs.chmod('p', 0o700);
  try { await (async ? vfs.restoreAsync('s') : vfs.restore('s')); }
  catch (error) { throw new Error(`the restore itself: ${error.message}`); }
  assert.equal(fs.stat('p')?.type, 'file', `${files} files${async ? ', async' : ''}: p is a file again`);
  assert.equal(text(fs.readFile('p')), 'the file p');
  assert.throws(() => fs.stat('p/new'), /ENOTDIR/, 'p/new is gone with the directory: p is a file');
  for (let i = 0; i < files; i++) assert.equal(text(fs.readFile(`f${i}`)), `before ${i}`);
  within(vfs, `${files} files`);
  h.db.close();
}
await check('a restore that ends between a directory and an entry of it', async () => {
  for (let files = 76; files <= 90; files++) await directoryOverFile(files, false);
  for (const files of [80, 82, 84]) await directoryOverFile(files, true);
});

await check('a subtree restore leaves its root\'s parent and siblings', () => {
  const h = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(h.sql, h.ctx);
  const fs = vfs.as(CRED_KERNEL);
  fs.writeFile('p', enc.encode('the file p'));
  vfs.snapshot('s');
  fs.unlink('p');
  fs.mkdir('p');
  fs.writeFile('p/x', enc.encode('x'));
  fs.writeFile('p/keep', enc.encode('keep'));
  fs.chmod('p', 0o700);
  vfs.restore('s', { subtree: 'p/x' });
  assert.throws(() => fs.stat('p/x'), /ENOENT/, 'p/x, which the snapshot had not, is gone');
  assert.equal(fs.stat('p')?.type, 'directory', 'p, outside the subtree, stays');
  assert.equal(fs.stat('p').mode & 0o777, 0o700, 'and keeps its mode');
  assert.equal(text(fs.readFile('p/keep')), 'keep', 'its sibling stays');
  h.db.close();
});

/** directoryOverFile's tree, its restore refused right after the transaction that noted p (the store failing the next). */
function restoreRefusedAfterNoting(files) {
  const h = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(h.sql, h.ctx);
  const fs = vfs.as(CRED_KERNEL);
  for (let i = 0; i < files; i++) fs.writeFile(`f${i}`, enc.encode(`before ${i}`));
  fs.writeFile('p', enc.encode('the file p'));
  vfs.snapshot('s');
  for (let i = 0; i < files; i++) fs.writeFile(`f${i}`, enc.encode(`after ${i}`));
  fs.unlink('p');
  fs.mkdir('p');
  fs.writeFile('p/new', enc.encode('new'));
  fs.chmod('p', 0o700);
  // The job row written with p in its note, the next transaction is refused.
  let noted = false;
  h.setFaultInjector((statement) => {
    if (/^\s*UPDATE vfs_jobs SET cursor/.test(statement.sql) && statement.params.some((param) => typeof param === 'string' && param.includes('\0p\0'))) {
      noted = true;
      return null;
    }
    if (!noted || statement.transaction === null || !/^\s*(INSERT|UPDATE|DELETE)/i.test(statement.sql)) return null;
    return Object.assign(new Error('the host went away'), { code: 'EIO' });
  });
  assert.throws(() => vfs.restore('s'), /went away/);
  h.clearFault();
  assert.ok(noted, 'a transaction noted p');
  return { h, vfs, fs };
}

await check('a restore reset after a transaction that noted a directory', () => {
  const { h } = restoreRefusedAfterNoting(82);
  const reopened = new SqliteVFS(h.sql, h.ctx);
  const fs = reopened.as(CRED_KERNEL);
  assert.equal(fs.stat('p')?.type, 'file', 'reopened, the restore finished: p is a file again');
  assert.equal(text(fs.readFile('p')), 'the file p');
  for (let i = 0; i < 82; i++) assert.equal(text(fs.readFile(`f${i}`)), `before ${i}`);
  h.db.close();
});

await check('a write to a noted directory before the restore resumes wins', () => {
  const { h, fs } = restoreRefusedAfterNoting(82);
  fs.chmod('p', 0o750);
  const reopened = new SqliteVFS(h.sql, h.ctx);
  const after = reopened.as(CRED_KERNEL);
  assert.equal(after.stat('p')?.type, 'directory', 'the write after the restore began stands');
  assert.equal(after.stat('p').mode & 0o777, 0o750);
  h.db.close();
});

/**
 * A snapshot to drop whose rows interleave, in the order a drop pages them
 * (gen_to, path), with rows an older kept snapshot holds too: odd files
 * changed between the two snapshots (their versions at the dropped one are
 * its alone), even ones not (an older snapshot covers theirs). Half the
 * files' rows are dead, more than one transaction's worth.
 */
function interleavedDrop() {
  const h = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(h.sql, h.ctx);
  const fs = vfs.as(CRED_KERNEL);
  for (let i = 0; i < FILES; i++) fs.writeFile(`f${i}`, enc.encode(`first ${i}`));
  vfs.snapshot('older');
  for (let i = 1; i < FILES; i += 2) fs.writeFile(`f${i}`, enc.encode(`second ${i}`));
  vfs.snapshot('dropped');
  // In file order: the rows the dropped snapshot covers end alternately dead and kept.
  for (let i = 0; i < FILES; i++) fs.writeFile(`f${i}`, enc.encode(`live ${i}`));
  const history = () => Number([...h.sql.exec('SELECT COUNT(*) AS n FROM vfs_inode_history')][0].n);
  const keptReads = (view) => { for (let i = 0; i < FILES; i++) assert.equal(text(view.readFile(`f${i}`)), `first ${i}`, `the older snapshot's f${i}`); };
  return { h, vfs, fs, history, keptReads, dead: Math.floor(FILES / 2) };
}

await check('a drop interrupted after its first transaction', () => {
  const { h, vfs, history, keptReads, dead } = interleavedDrop();
  const before = history();
  // The first transaction's deletes are in, the next one's first is refused.
  let deletes = 0;
  let firstTransaction = null;
  h.setFaultInjector((statement) => {
    if (!/^\s*DELETE FROM vfs_inode_history/.test(statement.sql)) return null;
    deletes++;
    firstTransaction ??= statement.transaction;
    return statement.transaction !== firstTransaction ? Object.assign(new Error('the host went away'), { code: 'EIO' }) : null;
  });
  assert.throws(() => vfs.dropSnapshot('dropped'), /went away/);
  h.clearFault();
  assert.ok(history() < before && history() > before - dead, `the first transaction's rows are gone, not the rest: ${history()} of ${before}`);
  const reopened = new SqliteVFS(h.sql, h.ctx);
  assert.equal(history(), before - dead, 'reopened, the engine finished the drop: every dead row, no kept one');
  assert.deepEqual(reopened.snapshots().map((snap) => snap.name), ['older']);
  keptReads(reopened.at('older'));
  within(reopened, 'the resumed drop');
  h.db.close();
});

await check('dropSnapshotAsync', async () => {
  const { h, vfs, history, keptReads, dead } = interleavedDrop();
  const before = history();
  const { dropped } = await vfs.dropSnapshotAsync('dropped');
  assert.equal(dropped, dead);
  assert.equal(history(), before - dead);
  keptReads(vfs.at('older'));
  within(vfs, 'the async drop');
  h.db.close();
});

assert.deepEqual(failed, [], 'every job stays within the budget and keeps its work');
console.log('sqlite-vfs-snapshot-job-budget: ok');
