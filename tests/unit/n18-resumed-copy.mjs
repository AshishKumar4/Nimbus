#!/usr/bin/env bun
// N18: a copyTree a reset interrupted resumes from vfs_jobs when the store
// reopens, and it resumes with a reservation for what is left to copy. A
// writer between its slices cannot leave it without room. When the room is
// not there at all, the job ends with ENOSPC and removes what it had copied:
// never half-applied.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// More rows than one resumed slice copies (200 pages of 250), so the rest
// runs after the open, in turns another writer can take.
const DIRS = 120_000;
const distinct = (n) => {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(bytes.subarray(i, Math.min(n, i + 65_536)));
  return bytes;
};

function interrupted() {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir('src');
  const names = [];
  for (let i = 0; i < DIRS; i++) names.push(`src/d${String(i).padStart(6, '0')}`);
  for (let i = 0; i < names.length; i += 250) root.mkdirBatch(names.slice(i, i + 250));
  // The copy's third transaction resets the object: its job row is recorded.
  harness.failAfterTransaction({ transaction: harness.transactionCount + 3, error: new Error('reset') });
  assert.throws(() => root.copyTree('src', 'dst'), /reset/);
  harness.clearFault();
  assert.equal(harness.sql.exec("SELECT COUNT(*) AS n FROM vfs_jobs WHERE kind = 'copyTree'")[0].n, 1);
  return { harness, base: vfs.databaseBytes() };
}
const reopen = (harness, limit) => new SqliteVFS(createSqliteVfsTestHarness(harness.db).sql, harness.ctx, undefined, { storageLimit: limit, storageKernelReserve: 0 });
const count = (harness, prefix) => harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_inodes WHERE path = ? OR path LIKE ?', prefix, `${prefix}/%`)[0].n;
const settle = async (vfs) => { for (let i = 0; i < 400 && vfs.jobs().length > 0; i++) await new Promise((r) => setTimeout(r, 0)); };

// Resumed with room: a writer taking every byte the ledger shows free, between
// the resumed slices, does not stop it.
{
  const { harness, base } = interrupted();
  const vfs = reopen(harness, base + (DIRS + 2_000) * 256 + 4_000_000);
  const view = vfs.ledger.view();
  assert.ok(view.reserved > 0, 'the resumed copy holds a reservation');
  const free = vfs.ledger.limit - view.used;
  assert.ok(free > 1_048_576);
  vfs.as(CRED_KERNEL).writeFile('big', distinct(free - 1_048_576));
  await settle(vfs);
  assert.deepEqual(vfs.jobs(), []);
  assert.equal(count(harness, 'dst'), DIRS + 1, 'the resumed copy completed');
  assert.equal(vfs.ledger.view().reserved, 0);
}

// Resumed without room: it ends with ENOSPC and nothing it copied is left.
{
  const { harness, base } = interrupted();
  const vfs = reopen(harness, base + 1_000_000);
  await settle(vfs);
  assert.deepEqual(vfs.jobs(), [], 'the job is over');
  assert.equal(count(harness, 'dst'), 0, 'and not half-applied');
  assert.equal(vfs.ledger.view().reserved, 0);
}

console.log('n18-resumed-copy: ok');
