#!/usr/bin/env bun
/**
 * sqlite-vfs-legacy-reset-notice — a session whose database a v1 Nimbus
 * wrote opens empty under schema v2 (no migration, as agreed). The loss is
 * told, once, and the session starts clean: the VFS records the reset
 * durably at its first v2 open, so a restart before any terminal attaches
 * still owes the notice; the session layer drops the persisted shell state
 * (a cwd that pointed into the lost tree) and hands back the notice once.
 */

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { LEGACY_RESET_NOTICE, takeLegacyResetNotice } from '../../packages/worker/src/session/legacy-reset.ts';
import { ensureSessionStateSchema, loadShellState, persistShellState } from '../../packages/worker/src/session/state-store.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

/** A database as a v1 Nimbus left it: its tables, and a user's file in them. */
function v1Database() {
  const harness = createSqliteVfsTestHarness();
  harness.sql.exec('CREATE TABLE inodes (path TEXT PRIMARY KEY, parent_path TEXT, size INTEGER, mode INTEGER, content_id TEXT)');
  harness.sql.exec('CREATE TABLE file_chunks (content_id TEXT, chunk_id INTEGER, data BLOB)');
  harness.sql.exec("INSERT INTO inodes VALUES ('home/user/project/app.js', 'home/user/project', 5, 420, 'c1')");
  harness.sql.exec("INSERT INTO file_chunks VALUES ('c1', 0, x'68656c6c6f')");
  return harness;
}

const ctxFor = (harness) => ({ storage: { sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync } });

// ── The VFS records the reset, durably, until acknowledged ────────────────
{
  const harness = v1Database();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  assert.equal(vfs.legacyReset, true, 'a v1 database is reported');
  assert.equal(vfs.as(CRED_KERNEL).exists('home/user/project/app.js'), false, 'its files are not served half-read');
  // The janitor may take the old tables before anyone is told.
  for (let pass = 0; vfs.runContentMaintenance(64).transactions > 0; pass++) assert.ok(pass < 100);
  const restarted = new SqliteVFS(harness.sql, harness.ctx);
  assert.equal(restarted.legacyReset, true, 'a restart before the notice still owes it');
  restarted.acknowledgeLegacyReset();
  assert.equal(new SqliteVFS(harness.sql, harness.ctx).legacyReset, false, 'told once');
}

{
  const harness = createSqliteVfsTestHarness();
  assert.equal(new SqliteVFS(harness.sql, harness.ctx).legacyReset, false, 'a new database lost nothing');
  assert.equal(new SqliteVFS(harness.sql, harness.ctx).legacyReset, false);
}

// ── The session drops the shell state that pointed into the lost tree ────
{
  const harness = v1Database();
  const ctx = ctxFor(harness);
  ensureSessionStateSchema(ctx);
  persistShellState(ctx, { cwd: '/home/user/project', env: { HOME: '/home/user' } });
  assert.equal(loadShellState(ctx).hasPersistedState, true);
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const notice = takeLegacyResetNotice(vfs, ctx);
  assert.equal(notice, LEGACY_RESET_NOTICE);
  assert.match(notice, /created by an older Nimbus/);
  assert.match(notice, /reset/);
  assert.equal(loadShellState(ctx).hasPersistedState, false, 'the session starts cold, in the fresh tree');
  assert.equal(takeLegacyResetNotice(vfs, ctx), null, 'the notice is given once');
  assert.equal(takeLegacyResetNotice(new SqliteVFS(harness.sql, harness.ctx), ctx), null, 'and not again after a restart');
}

{
  const harness = createSqliteVfsTestHarness();
  const ctx = ctxFor(harness);
  ensureSessionStateSchema(ctx);
  persistShellState(ctx, { cwd: '/tmp', env: null });
  assert.equal(takeLegacyResetNotice(new SqliteVFS(harness.sql, harness.ctx), ctx), null);
  assert.equal(loadShellState(ctx).cwd, '/tmp', 'a v2 session keeps its state');
}

console.log('sqlite-vfs-legacy-reset-notice: all assertions passed');
