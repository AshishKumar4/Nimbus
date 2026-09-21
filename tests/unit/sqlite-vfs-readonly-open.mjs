#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// A SqliteVFS whose schema is already current opens over a readonly handle:
// every DDL step is conditional and the migration marker is written only
// when it is absent, so a reader never has to hold a writable database.
const dir = mkdtempSync(join(tmpdir(), 'sqlite-vfs-readonly-'));
const path = join(dir, 'vfs.sqlite');
try {
  {
    const db = new Database(path);
    const harness = createSqliteVfsTestHarness(db);
    const vfs = new SqliteVFS(harness.sql, harness.ctx);
    vfs.as(CRED_KERNEL).writeFile('/note.txt', 'kept');
    db.close();
  }
  const db = new Database(path, { readonly: true });
  const harness = createSqliteVfsTestHarness(db);
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  assert.equal(vfs.as(CRED_KERNEL).readFileString('/note.txt'), 'kept');
  db.close();
  console.log('sqlite-vfs-readonly-open: ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
