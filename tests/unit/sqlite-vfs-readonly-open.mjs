#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// A SqliteVFS whose store is already current opens without a single write
// statement, so an embedder may hand it a readonly handle: a replica, a
// snapshot, or a host that shares its Durable Object's SQLite. Every DDL
// step is `IF NOT EXISTS`, every seeded row is preceded by the read that
// decides it, and a migration marker is written only when the migration
// runs. Before this held, construction ran INSERT OR IGNORE for the identity
// row, the device row, the inode allocator and the content-schema marker,
// plus two backfill UPDATEs, on every open; a readonly handle died with
// SQLITE_READONLY at the first of them.
const WRITE_STATEMENT = /^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i;
const CREATE_STATEMENT = /^\s*CREATE\s+(TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\b/i;

const dir = mkdtempSync(join(tmpdir(), 'sqlite-vfs-readonly-'));
const path = join(dir, 'vfs.sqlite');
try {
  {
    const db = new Database(path);
    const harness = createSqliteVfsTestHarness(db);
    const vfs = new SqliteVFS(harness.sql, harness.ctx);
    const fs = vfs.as(CRED_KERNEL);
    fs.mkdir('/home/user', { recursive: true, mode: 0o755 });
    fs.writeFile('/home/user/note.txt', 'kept');
    fs.writeFile('/note.txt', 'kept');
    db.close();
  }

  // Reopened writable: the store is current, so construction issues reads
  // and conditional DDL only. This is the property; the readonly handle
  // below is one consequence of it.
  {
    const db = new Database(path);
    const harness = createSqliteVfsTestHarness(db);
    new SqliteVFS(harness.sql, harness.ctx);
    const writes = harness.statements
      .filter((s) => WRITE_STATEMENT.test(s.sql))
      .map((s) => s.sql.trim().slice(0, 80));
    assert.deepEqual(writes, [], `a current store is opened without write statements; saw:\n  ${writes.join('\n  ')}`);
    for (const s of harness.statements) {
      if (/^\s*CREATE\b/i.test(s.sql)) {
        assert.ok(CREATE_STATEMENT.test(s.sql), `every construction-time CREATE is IF NOT EXISTS: ${s.sql.trim().slice(0, 80)}`);
      }
    }
    db.close();
  }

  // Readonly handle: opens, reads, lists, stats; a write is refused by SQLite
  // itself, not by anything the VFS did earlier.
  {
    const db = new Database(path, { readonly: true });
    const harness = createSqliteVfsTestHarness(db);
    const vfs = new SqliteVFS(harness.sql, harness.ctx);
    const fs = vfs.as(CRED_KERNEL);
    assert.equal(fs.readFileString('/note.txt'), 'kept');
    assert.equal(fs.readFileString('/home/user/note.txt'), 'kept');
    assert.deepEqual(fs.readdir('/home/user').map((e) => e.name), ['note.txt']);
    assert.equal(fs.stat('/home/user/note.txt').type, 'file');
    assert.ok(Number.isInteger(fs.stat('/home/user/note.txt').ino), 'stat().ino is served from the stored column, no backfill needed');
    assert.throws(() => fs.writeFile('/other.txt', 'x'), /readonly/i, 'a write on the readonly handle is SQLite refusing it');
    db.close();
  }

  // An explicit namespace skips the identity lookup and still seeds nothing
  // when the device row exists.
  {
    const db = new Database(path, { readonly: true });
    const harness = createSqliteVfsTestHarness(db);
    const namespace = [...db.query('SELECT namespace FROM nimbus_filesystem_identity WHERE slot = 1').all()][0].namespace;
    const vfs = new SqliteVFS(harness.sql, harness.ctx, namespace);
    assert.equal(vfs.namespace, namespace);
    assert.equal(vfs.as(CRED_KERNEL).readFileString('/note.txt'), 'kept');
    db.close();
  }

  console.log('sqlite-vfs-readonly-open: ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
