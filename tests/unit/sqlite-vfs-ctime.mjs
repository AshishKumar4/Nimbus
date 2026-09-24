#!/usr/bin/env bun
// stat's ctime is the inode's last change (POSIX stat(3type) st_ctim): every
// content or metadata change sets it to the current time, utimes included, and
// nothing can set it to a chosen value. It used to be reported as mtime, so a
// same-size rewrite whose mtime was put back was invisible (Kinu N12).

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

let clock = 1_000_000;
Date.now = () => clock;
const tick = () => (clock += 1000);

const db = new Database(':memory:');
const open = () => {
  const h = createSqliteVfsTestHarness(db);
  return new SqliteVFS(h.sql, h.ctx);
};
const raw = open();
const root = raw.as(CRED_KERNEL);
root.mkdir('home/main', { recursive: true });
root.chown('home/main', 1000, 1000);
const vfs = raw.as(CRED_SESSION_USER);
const f = '/home/main/f';

// ── The ask's repro ─────────────────────────────────────────────────────────
vfs.writeFile(f, 'aaaa');
const first = vfs.stat(f);
assert.equal(first.ctime, clock, 'creation sets ctime');
tick();
vfs.writeFile(f, 'bbbb');
tick();
vfs.utimes(f, first.mtime, first.mtime);
const after = vfs.stat(f);
assert.deepEqual([after.size, after.mtime, after.ino], [first.size, first.mtime, first.ino]);
assert.equal(after.ctime, clock, 'the rewrite and utimes are visible in ctime');
assert.notEqual(after.ctime, first.ctime);

// ── utimes sets ctime to now, never to the time it was given ────────────────
tick();
vfs.utimes(f, 5, 7);
assert.deepEqual([vfs.stat(f).mtime, vfs.stat(f).ctime], [7, clock]);

// ── A batch write cannot choose ctime either ────────────────────────────────
tick();
vfs.writeBatch({
  inodes: [{ path: 'home/main/batch', parentPath: 'home/main', isDir: false, size: 1, mtime: 3, ctime: 4, mode: 0o644, chunkCount: 1 }],
  chunks: [{ path: 'home/main/batch', chunkId: 0, data: new Uint8Array([1]) }],
});
assert.deepEqual([vfs.stat('/home/main/batch').mtime, vfs.stat('/home/main/batch').ctime], [3, clock]);

// ── Each mutation of the inode moves ctime; reads do not ────────────────────
const moves = (what, change, path = f, stat = () => vfs.stat(path)) => {
  const before = stat().ctime;
  tick();
  change();
  assert.equal(stat().ctime, clock, `${what} sets ctime`);
  assert.ok(stat().ctime > before);
};
moves('chmod', () => vfs.chmod(f, 0o600));
moves('chown', () => root.chown(f, 1000, 1000));
moves('truncate', () => vfs.truncate(f, 2));
moves('writeRange', () => vfs.writeRange(f, 0, new Uint8Array([1])));
tick();
vfs.readFile(f);
vfs.stat(f);
assert.notEqual(vfs.stat(f).ctime, clock, 'reading changes nothing');

// ── rename changes the moved inode, not the entries beneath it ──────────────
vfs.mkdir('/home/main/d');
vfs.writeFile('/home/main/d/child', 'c');
const childCtime = vfs.stat('/home/main/d/child').ctime;
const dir = vfs.stat('/home/main/d');
tick();
vfs.rename('/home/main/d', '/home/main/e');
assert.deepEqual([vfs.stat('/home/main/e').ino, vfs.stat('/home/main/e').ctime], [dir.ino, clock], 'rename sets ctime');
assert.equal(vfs.stat('/home/main/e/child').ctime, childCtime, 'a descendant keeps its ctime');

// ── Dropping the last link is a change to the inode still held open ─────────
const authority = new SqliteFilesystemAuthority(raw);
const fs = authority.bind({ pid: 1, cred: CRED_SESSION_USER });
vfs.writeFile('/home/main/held', 'h');
const held = fs.open('/home/main/held', { read: true, write: true });
moves('unlink of an open file', () => vfs.unlink('/home/main/held'), null, () => fs.fstat(held.id));
moves('fchmod on an unlinked file', () => fs.fchmod(held.id, 0o600), null, () => fs.fstat(held.id));
fs.close(held.id);

// ── The runtime bridge (WASI filestat, node's fs.stat) reports the same ─────
vfs.utimes(f, 1, 2);
assert.deepEqual([fs.stat(f).mtime, fs.stat(f).ctime], [2, vfs.stat(f).ctime]);

// ── Durable: a reopened filesystem reads ctime back from the row ────────────
const reopened = open().as(CRED_SESSION_USER);
assert.equal(reopened.stat(f).ctime, vfs.stat(f).ctime);
assert.equal(reopened.stat('/home/main/e/child').ctime, childCtime);

// ── Rows written before the column existed report their mtime ───────────────
db.run('ALTER TABLE inodes DROP COLUMN ctime');
const upgraded = open().as(CRED_SESSION_USER);
assert.equal(upgraded.stat(f).ctime, upgraded.stat(f).mtime);
tick();
upgraded.chmod(f, 0o644);
assert.equal(upgraded.stat(f).ctime, clock, 'and track changes from then on');

console.log('sqlite-vfs-ctime: all assertions passed');
