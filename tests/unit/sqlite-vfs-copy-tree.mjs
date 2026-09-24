#!/usr/bin/env bun
/**
 * sqlite-vfs-copy-tree — copy-on-write copies (SPEC P2): copyFile and
 * copyTree copy inode rows, never bytes; a write to either side copies on
 * write; an interrupted copy resumes to the complete tree; watchers and the
 * coherence log see the destination.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

function open(harness = createSqliteVfsTestHarness()) {
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, raw, vfs: raw.as(CRED_KERNEL), user: raw.as(CRED_SESSION_USER) };
}

function random(length, seed) {
  const out = new Uint8Array(length);
  let s = (seed * 2654435761 + 1) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = s & 255;
  }
  return out;
}

function databaseBytes(harness) {
  return harness.sql.exec('PRAGMA page_count')[0].page_count * harness.sql.exec('PRAGMA page_size')[0].page_size;
}

/** Every entry under `root`, relative, with its kind, mode and bytes. */
function snapshot(vfs, root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of vfs.readdir(dir)) {
      const path = `${dir}/${entry.name}`;
      const stat = vfs.lstat(path);
      const rel = path.slice(root.length);
      if (entry.type === 'directory') { out[rel] = ['dir', stat.mode]; walk(path); }
      else if (entry.type === 'symlink') out[rel] = ['link', vfs.readlink(path)];
      else out[rel] = ['file', stat.mode, [...vfs.readFile(path)].join(',')];
    }
  };
  walk(root);
  return out;
}

function seed(vfs, root, dirs, files) {
  vfs.mkdir(root, { recursive: true });
  for (let d = 0; d < dirs; d++) {
    vfs.mkdir(`${root}/d${d}`);
    for (let f = 0; f < files; f++) vfs.writeFile(`${root}/d${d}/f${f}.js`, random(100 + ((d * files + f) * 37) % 4000, d * files + f));
  }
  vfs.writeFile(`${root}/big.bin`, random(300_000, 99));
  vfs.symlink('d0/f0.js', `${root}/link`);
}

// ── A 10k-file copy costs rows, not bytes ─────────────────────────────────
{
  const { harness, vfs } = open();
  seed(vfs, 'src', 100, 100);
  const chunks = harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n;
  const before = databaseBytes(harness);
  assert.equal(vfs.copyTree('src', 'dst'), 10_103);
  const perRow = (databaseBytes(harness) - before) / 10_103;
  assert.ok(perRow <= 300, `copy added ${perRow} B per entry`);
  assert.equal(harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n, chunks, 'no chunk written');
  assert.deepEqual(snapshot(vfs, 'dst'), snapshot(vfs, 'src'));
  assert.equal(vfs.contentKey('dst/big.bin'), vfs.contentKey('src/big.bin'));
  assert.notEqual(vfs.stat('dst/d3/f3.js').ino, vfs.stat('src/d3/f3.js').ino, 'a copy is a new inode');

  // ── An edit after the copy leaves the source intact ────────────────────
  const source = snapshot(vfs, 'src');
  vfs.writeRange('dst/big.bin', 1000, new Uint8Array(10).fill(1));
  vfs.writeFile('dst/d1/f1.js', 'changed');
  vfs.truncate('dst/d2/f2.js', 3);
  vfs.unlink('dst/d4/f4.js');
  assert.deepEqual(snapshot(vfs, 'src'), source);
  assert.equal(vfs.readFileString('dst/d1/f1.js'), 'changed');
}

// ── Interrupted at page k, the reopened store finishes the copy ───────────
{
  const baseline = open();
  seed(baseline.vfs, 'src', 6, 200);
  const start = baseline.harness.transactionCount;
  baseline.vfs.copyTree('src', 'dst');
  const transactions = baseline.harness.transactionCount - start;
  const expected = snapshot(baseline.vfs, 'dst');
  assert.ok(transactions >= 5, `the copy spans ${transactions} transactions`);
  for (let k = 1; k <= transactions; k++) {
    const { harness, vfs } = open();
    seed(vfs, 'src', 6, 200);
    harness.failAfterTransaction({ transaction: harness.transactionCount + k, error: new Error(`reset at ${k}`) });
    assert.throws(() => vfs.copyTree('src', 'dst'), new RegExp(`reset at ${k}`));
    harness.clearFault();
    const reopened = open(createSqliteVfsTestHarness(harness.db));
    assert.deepEqual(snapshot(reopened.vfs, 'dst'), expected, `resumed after transaction ${k}`);
    assert.deepEqual(harness.sql.exec('SELECT id FROM vfs_jobs'), [], 'the job row is gone once complete');
    assert.equal(reopened.raw._verifyCounters(), null);
  }
}

// ── Watchers and the coherence log see the destination ────────────────────
{
  const { raw, vfs } = open();
  seed(vfs, 'src', 2, 3);
  const events = [];
  raw.events.onPath('dst', (event) => events.push(`${event.type} ${event.path}`));
  const cursor = raw.revision();
  const before = raw.revision('dst');
  vfs.copyTree('src', 'dst');
  assert.ok(raw.revision('dst') > before, 'the destination subtree revision moved');
  assert.ok(raw.revision('dst/d1/f2.js') > cursor);
  const delta = raw.invalidatedSince(raw.epoch, cursor);
  assert.equal(delta.poison, false);
  const paths = new Set(delta.paths.map((entry) => entry.path));
  for (const path of ['dst', 'dst/d0', 'dst/d1/f2.js', 'dst/big.bin', 'dst/link']) assert.ok(paths.has(path), path);
  // One event for the tree, as a rename emits one: the log above carries every path.
  assert.deepEqual(events, ['addDir dst']);
}

// ── Credentials: read access is required; the copy belongs to the caller ──
{
  const { vfs, user } = open();
  vfs.mkdir('home/user', { recursive: true });
  vfs.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  seed(vfs, 'root-tree', 1, 2);
  vfs.chmod('root-tree/d0/f1.js', 0o4755);
  assert.equal(user.copyTree('root-tree', 'home/user/mine'), 6);
  const copied = user.stat('home/user/mine/d0/f1.js');
  assert.equal(copied.uid, CRED_SESSION_USER.uid, 'owned by the caller');
  assert.equal(copied.mode & 0o7777, 0o755 & ~CRED_SESSION_USER.umask, 'setuid cleared, umask applied');
  vfs.chmod('root-tree/d0/f0.js', 0o600);
  assert.throws(() => user.copyTree('root-tree', 'home/user/denied'), /EACCES/);
  assert.equal(user.exists('home/user/denied'), false, 'refused before anything was copied');
  assert.throws(() => user.copyTree('home/user/mine', 'home/user/mine/inside'), /EINVAL/);
  assert.throws(() => user.copyTree('home/user/mine', 'home/user/mine'), /EEXIST/);
  const preserved = vfs.copyTree('root-tree', 'kept', { preserve: true });
  assert.equal(preserved, 6);
  assert.equal(vfs.stat('kept/d0/f1.js').mode & 0o7777, 0o4755);
  assert.equal(vfs.stat('kept/d0/f1.js').mtime, vfs.stat('root-tree/d0/f1.js').mtime);
}

// ── copyFile shares, and a write to either side copies on write ───────────
{
  const { harness, vfs } = open();
  vfs.writeFile('a', random(200_000, 5));
  const chunks = harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n;
  vfs.copyFile('a', 'b');
  assert.equal(harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_chunks')[0].n, chunks);
  vfs.writeRange('b', 0, new Uint8Array([1, 2, 3]));
  assert.deepEqual(vfs.readFile('a'), random(200_000, 5));
  assert.deepEqual([...vfs.readRange('b', 0, 4)], [1, 2, 3, random(200_000, 5)[3]]);
}

console.log('sqlite-vfs-copy-tree: all assertions passed');
