#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const source = createSqliteVfsTestHarness(), target = createSqliteVfsTestHarness(), abandoned = createSqliteVfsTestHarness();
const names = (h) => h.sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('vfs_inodes_ino', 'vfs_history_ino') ORDER BY name").map(row => row.name);
try {
  const src = new SqliteVFS(source.sql, source.ctx), s = src.as(CRED_KERNEL);
  s.writeFile('first', ''); s.writeFile('second', ''); s.writeFile('third', ''); src.snapshot('image');
  const first = src.exportPage({ at: 'image', limit: 1 });
  const rest = src.exportPage({ at: 'image', after: first.next });
  let dst = new SqliteVFS(target.sql, target.ctx);
  assert.deepEqual(names(target), [], 'ordinary stores pay no per-inode import-index tax');
  assert.equal(dst.importPage('', first).done, false);
  assert.deepEqual(names(target), ['vfs_history_ino', 'vfs_inodes_ino']);
  const probe = [...target.statements].reverse().find(({ sql }) => sql.includes('JOIN vfs_inodes v ON v.ino'));
  assert.ok(probe);
  // bun:sqlite caches prepared EXPLAIN statements, which lock the index against DDL; finalize ours.
  const usesIndex = () => {
    const plan = target.db.query(`EXPLAIN QUERY PLAN ${probe.sql}`);
    try { return plan.all(...probe.params).some(row => /USING (?:COVERING )?INDEX /.test(row.detail)); }
    finally { plan.finalize(); }
  };
  assert.equal(usesIndex(), true, 'active identity probes use a persistent index, not a rebuilt automatic index');
  dst = new SqliteVFS(target.sql, target.ctx);
  assert.equal(usesIndex(), true, 'a paused job retains its indexed probe after reopen');
  const bad = structuredClone(rest); bad.rows[0].ino = first.rows[0].ino;
  assert.throws(() => dst.importPage('', bad), error => error.code === 'EEXIST');
  assert.deepEqual(names(target), ['vfs_history_ino', 'vfs_inodes_ino'], 'rejected frames do not abort a resumable import');
  const cleanupFailure = new Error('cleanup interrupted');
  target.setFaultInjector(({ sql }) => sql === 'DROP INDEX IF EXISTS vfs_history_ino' ? cleanupFailure : undefined);
  assert.throws(() => dst.importPage('', rest), error => error === cleanupFailure);
  target.clearFault();
  assert.deepEqual(names(target), ['vfs_history_ino', 'vfs_inodes_ino'], 'job/index cleanup rolls back together');
  assert.equal(target.sql.exec("SELECT COUNT(*) AS n FROM vfs_jobs WHERE kind = 'import'")[0].n, 1);
  assert.equal(dst.importPage('', rest).done, true);
  assert.deepEqual(names(target), []);
  assert.equal(dst.as(CRED_KERNEL).stat('third').ino, s.stat('third').ino);

  const raw = new SqliteVFS(abandoned.sql, abandoned.ctx);
  raw.importPage('', first);
  assert.equal(names(abandoned).length, 2);
  const workspace = await NimbusWorkspace.create({ sql: abandoned.sql, transactions: abandoned.ctx, vfs: raw });
  workspace.destroy();
  assert.deepEqual(names(abandoned), [], 'the existing whole-workspace abort drops import tables and indexes');
} finally { source.db.close(); target.db.close(); abandoned.db.close(); }
console.log('sqlite-vfs-import-index-lifecycle: active/reopened indexed probes, rejection/rollback, completion and destroy pass');
