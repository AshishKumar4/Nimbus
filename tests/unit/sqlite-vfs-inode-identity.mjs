#!/usr/bin/env bun
// Inode identity lives on the inode row: stable across writes and renames,
// reissued on unlink+recreate, shared by every descriptor that opened it,
// and allocated inside the same transaction that publishes the row. The
// retired vfs_inode_identity side table answered the same questions a day
// late — stat() allocated numbers lazily and unlink deleted them — so an
// interrupted rename could resurrect a file with a different number.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const bytes = (s) => new TextEncoder().encode(s);
const text = (d) => new TextDecoder().decode(d);

// ── stat().ino is durable: write keeps it, recreate reissues it ─────────────
{
  const h = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(h.sql, h.ctx);
  const kfs = vfs.as(CRED_KERNEL);
  kfs.writeFile('/file', 'one');
  const ino = kfs.stat('/file').ino;
  assert.ok(ino > 0, 'publication allocates an inode number');
  kfs.writeFile('/file', 'two');
  assert.equal(kfs.stat('/file').ino, ino, 'a content write preserves identity');
  kfs.mkdir('/dir');
  const dirIno = kfs.stat('/dir').ino;
  assert.notEqual(dirIno, ino, 'a sibling gets its own number');
  kfs.rename('/file', '/renamed');
  assert.equal(kfs.stat('/renamed').ino, ino, 'rename moves the inode, not a copy');
  kfs.unlink('/renamed');
  kfs.writeFile('/renamed', 'three');
  const reino = kfs.stat('/renamed').ino;
  assert.notEqual(reino, ino, 'unlink+recreate is a new identity');
  assert.ok(reino > ino, 'recreated ino is monotonic');
  h.db.close();
}

// ── ino survives a process restart: the column, not the cache, is durable ───
{
  const h = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(h.sql, h.ctx);
  const kfs = vfs.as(CRED_KERNEL);
  kfs.writeFile('/durable', 'x');
  const ino = kfs.stat('/durable').ino;
  const reopened = new SqliteVFS(h.sql, h.ctx);
  assert.equal(reopened.as(CRED_KERNEL).stat('/durable').ino, ino,
    'a fresh VFS over the same DB reads the same inode numbers');
  h.db.close();
}

// ── every descriptor shares one inode object: fchmod/fchown/futimes are ─────
// ── immediately visible on the sibling descriptor, attached or detached ─────
{
  const h = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(h.sql, h.ctx);
  const authority = new SqliteFilesystemAuthority(raw);
  const fs = authority.bind({ pid: 1, cred: CRED_KERNEL });
  fs.writeFile('/shared', 'data');
  const first = fs.open('/shared', { read: true, write: true });
  const second = fs.open('/shared', { read: true });
  fs.fchmod(first.id, 0o640);
  assert.equal(fs.fstat(second.id).mode & 0o777, 0o640,
    'a sibling descriptor sees the chmod without reopening');
  fs.fchown(first.id, 4242, 4343);
  const seen = fs.fstat(second.id);
  assert.equal(seen.uid, 4242);
  assert.equal(seen.gid, 4343);
  fs.futimes(first.id, 1000, 2000);
  assert.equal(fs.fstat(second.id).mtime, 2000);
  // Unlink detaches both descriptions onto the same retired inode; metadata
  // writes through one still show up on the other.
  const retiredIno = fs.fstat(second.id).ino;
  fs.unlink('/shared');
  fs.fchmod(first.id, 0o600);
  assert.equal(fs.fstat(second.id).mode & 0o777, 0o600,
    'detached chmod is visible across descriptors on the retired inode');
  assert.equal(fs.fstat(second.id).ino, retiredIno, 'retired ino is stable');
  fs.close(first.id);
  fs.close(second.id);
  h.db.close();
}

// ── detached writes commit atomically: a fault mid-resize leaves either ─────
// ── the old chunks or the new chunks, never a torn half-write ────────────────
{
  const h = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(h.sql, h.ctx);
  const authority = new SqliteFilesystemAuthority(raw);
  const fs = authority.bind({ pid: 1, cred: CRED_KERNEL });
  fs.writeFile('/atomic', bytes('A'.repeat(200 * 1024)));
  const detached = fs.open('/atomic', { read: true, write: true });
  fs.unlink('/atomic');
  const before = fs.fstat(detached.id).size;
  // Fault every file_chunks write: the resize must roll back wholesale.
  h.setFaultInjector((statement) => statement.sql.startsWith('INSERT OR REPLACE INTO file_chunks')
    ? new Error('injected detached-resize failure') : null);
  assert.throws(() => fs.write(detached.id, 0, bytes('B'.repeat(150 * 1024))), /injected/);
  h.clearFault();
  assert.equal(fs.fstat(detached.id).size, before, 'torn resize leaves the original size');
  const head = fs.read(detached.id, 0, 4);
  assert.equal(text(head), 'AAAA', 'torn resize leaves the original chunks');
  // And with no fault the resize still commits.
  fs.write(detached.id, 0, bytes('B'.repeat(150 * 1024)));
  assert.equal(text(fs.read(detached.id, 0, 4)), 'BBBB');
  fs.close(detached.id);
  h.db.close();
}

// ── orphan GC skips held content and still collects what follows it ──────────
{
  const h = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(h.sql, h.ctx);
  const authority = new SqliteFilesystemAuthority(raw);
  const fs = authority.bind({ pid: 1, cred: CRED_KERNEL });
  fs.writeFile('/held', 'held-content');
  fs.writeFile('/free', 'free-content');
  const held = fs.open('/held', { read: true });
  // Retire both contents; only /free is collectable while /held is open.
  fs.unlink('/held');
  fs.unlink('/free');
  const collectable = [...h.sql.exec(
    `SELECT COUNT(*) AS n FROM file_chunks c
     WHERE NOT EXISTS (SELECT 1 FROM inodes i WHERE i.content_id = c.content_id)`,
  )][0].n;
  assert.ok(collectable > 0, 'both retired contents await collection');
  const { entries } = fs.list();
  void entries;
  // Trigger maintenance through the public path: a batch mutation runs the
  // collector before returning.
  fs.writeFile('/trigger', 'x');
  fs.writeFile('/trigger', 'y');
  const remaining = [...h.sql.exec(
    `SELECT c.content_id, COUNT(*) AS n FROM file_chunks c
     WHERE NOT EXISTS (SELECT 1 FROM inodes i WHERE i.content_id = c.content_id)
     GROUP BY c.content_id`,
  )];
  const heldChunks = remaining.filter((row) => row.n > 0);
  // /held stays (an open descriptor pins it); /free must have been collected
  // even though it queued behind the held one — a halted scan used to starve
  // every orphan behind the first pinned candidate.
  fs.close(held.id);
  assert.ok(heldChunks.length <= 1, 'only the held content may remain uncollected');
  h.db.close();
}

// ── a failed rename leaves the inode identity intact for the reopen ─────────
{
  const h = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(h.sql, h.ctx);
  const kfs = vfs.as(CRED_KERNEL);
  kfs.mkdir('/tree', { recursive: true });
  kfs.writeFile('/tree/leaf', 'content');
  const ino = kfs.stat('/tree/leaf').ino;
  h.setFaultInjector(() => new Error('injected rename fault'));
  assert.throws(() => kfs.rename('/tree', '/moved'), /injected/);
  h.clearFault();
  assert.equal(kfs.stat('/tree/leaf').ino, ino,
    'a rolled-back rename republishes the source under its original number');
  h.db.close();
}

console.log('sqlite-vfs-inode-identity: all assertions passed');
