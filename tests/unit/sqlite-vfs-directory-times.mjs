#!/usr/bin/env bun
// A directory's mtime and ctime move when a name is created in it, removed
// from it, or renamed into or out of it (POSIX; git's untracked cache, make,
// rsync and watchers rely on it), at the operation's time, once per
// directory per transaction. Rewriting a file in place, chmod, and a moved
// subtree's own descendants change no directory's entries.
//
// Red before: SqliteVFS never dated a directory after creating it: mkdir d,
// stat; write d/new.txt, stat; unlink, stat: all three the same.

import assert from 'node:assert/strict';

import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// The VFS clock (Date.now) stepped by hand: each operation lands at a known time.
let clock = 1_700_000_000_000;
Date.now = () => clock;
const tick = () => (clock += 1_000);

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const vfs = raw.as(CRED_KERNEL);
const enc = new TextEncoder();
const times = (path) => {
  const stat = vfs.stat(path);
  return { mtime: stat.mtime, ctime: stat.ctime };
};
const reopened = (path) => {
  const fresh = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL).stat(path);
  return { mtime: fresh.mtime, ctime: fresh.ctime };
};
function dated(path, at, what) {
  assert.deepEqual(times(path), { mtime: at, ctime: at }, `${what}: ${path} was not dated`);
  assert.deepEqual(reopened(path), { mtime: at, ctime: at }, `${what}: ${path}'s time did not reach the store`);
}
function unchanged(path, before, what) {
  assert.deepEqual(times(path), before, `${what}: ${path} was dated, though its entries did not change`);
}

tick();
vfs.mkdir('w/d', { recursive: true });
vfs.mkdir('w/e', { recursive: true });

// writeFile creating a name
let at = tick();
vfs.writeFile('w/d/new.txt', 'a');
dated('w/d', at, 'create');

// rewriting it in place: same name, same inode
let before = times('w/d');
tick();
vfs.writeFile('w/d/new.txt', 'bb');
unchanged('w/d', before, 'rewrite');

// chmod changes the file, not the directory
tick();
vfs.chmod('w/d/new.txt', 0o600);
unchanged('w/d', before, 'chmod');

// writeRange extends the file in place
tick();
vfs.writeRange('w/d/new.txt', 2, enc.encode('cc'));
unchanged('w/d', before, 'writeRange');

// symlink
at = tick();
vfs.symlink('new.txt', 'w/d/link');
dated('w/d', at, 'symlink');

// mkdir
at = tick();
vfs.mkdir('w/d/sub');
dated('w/d', at, 'mkdir');

// rmdir
at = tick();
vfs.rmdir('w/d/sub');
dated('w/d', at, 'rmdir');

// unlink
at = tick();
vfs.unlink('w/d/link');
dated('w/d', at, 'unlink');

// rename across directories dates both parents; the moved subtree's own
// directories do not move.
vfs.mkdir('w/d/tree/inner', { recursive: true });
vfs.writeFile('w/d/tree/inner/x', 'x');
const inner = times('w/d/tree/inner');
const tree = times('w/d/tree');
at = tick();
vfs.rename('w/d/tree', 'w/e/tree');
dated('w/d', at, 'rename (source parent)');
dated('w/e', at, 'rename (destination parent)');
assert.deepEqual({ mtime: times('w/e/tree/inner').mtime }, { mtime: inner.mtime }, 'rename re-dated a moved descendant directory');
assert.equal(times('w/e/tree').mtime, tree.mtime, "rename re-dated the moved directory's own mtime");

// rename within one directory
at = tick();
vfs.rename('w/d/new.txt', 'w/d/renamed.txt');
dated('w/d', at, 'rename (same parent)');

// rename over an existing name: the target's directory changes
vfs.writeFile('w/e/victim', 'v');
at = tick();
vfs.rename('w/d/renamed.txt', 'w/e/victim');
dated('w/d', at, 'rename over (source parent)');
dated('w/e', at, 'rename over (destination parent)');

// copyTree dates the directory it copies into, not the copy's own tree
vfs.mkdir('w/src/a', { recursive: true });
vfs.writeFile('w/src/a/f', 'f');
const copiedInner = times('w/src/a');
at = tick();
vfs.copyTree('w/src', 'w/e/copy', { preserve: true });
dated('w/e', at, 'copyTree');
assert.equal(times('w/e/copy/a').mtime, copiedInner.mtime, 'copyTree re-dated a preserved descendant');

// writeBatch: many new names, one per directory per transaction
at = tick();
vfs.writeBatch({
  inodes: [
    { path: 'w/d/b1', parentPath: 'w/d', kind: 'file', isDir: false, size: 1, mtime: 5, mode: 0o644, chunkCount: 1 },
    { path: 'w/d/b2', parentPath: 'w/d', kind: 'file', isDir: false, size: 1, mtime: 5, mode: 0o644, chunkCount: 1 },
    { path: 'w/e/b3', parentPath: 'w/e', kind: 'file', isDir: false, size: 1, mtime: 5, mode: 0o644, chunkCount: 1 },
  ],
  chunks: [
    { path: 'w/d/b1', chunkId: 0, data: enc.encode('1') },
    { path: 'w/d/b2', chunkId: 0, data: enc.encode('2') },
    { path: 'w/e/b3', chunkId: 0, data: enc.encode('3') },
  ],
});
dated('w/d', at, 'writeBatch');
dated('w/e', at, 'writeBatch');
assert.equal(vfs.stat('w/d/b1').mtime, 5, "writeBatch's own file mtime is kept");

// A batch that creates a directory and its files in one transaction keeps
// the directory's own time: its row is written with them.
tick();
vfs.writeBatch({
  inodes: [
    { path: 'w/fresh', parentPath: 'w', kind: 'directory', isDir: true, size: 0, mtime: 9, mode: 0o755, chunkCount: 0 },
    { path: 'w/fresh/f', parentPath: 'w/fresh', kind: 'file', isDir: false, size: 1, mtime: 9, mode: 0o644, chunkCount: 1 },
  ],
  chunks: [{ path: 'w/fresh/f', chunkId: 0, data: enc.encode('f') }],
});
assert.equal(vfs.stat('w/fresh').mtime, 9, 'a directory written with its files was re-dated over its own row');

// writeStream: a W7 wave's group, and a deletion record
at = tick();
const result = await vfs.writeStream(encodeWriteBatchStream({
  inodes: [
    { path: 'w/s/one', parentPath: 'w/s', kind: 'file', isDir: false, size: 3, mtime: 7, mode: 0o644, chunkCount: 1 },
    { path: 'w/d/two', parentPath: 'w/d', kind: 'file', isDir: false, size: 3, mtime: 7, mode: 0o644, chunkCount: 1 },
    { path: 'w/s', parentPath: 'w', kind: 'directory', isDir: true, size: 0, mtime: 7, mode: 0o755, chunkCount: 0 },
  ],
  chunks: [
    { path: 'w/s/one', chunkId: 0, data: enc.encode('one') },
    { path: 'w/d/two', chunkId: 0, data: enc.encode('two') },
  ],
  deletePaths: ['w/e/b3'],
}));
assert.equal(result.ok, true, result.error?.message);
dated('w/d', at, 'writeStream');
dated('w/e', at, 'writeStream deletion');
// A directory the wave created is dated by the names created in it after,
// as on any filesystem (mkdir, then create).
dated('w/s', at, 'writeStream (a directory it created, then filled)');

// One directory update per directory per transaction, not one per file.
const statements = harness.statements.length;
tick();
vfs.writeBatch({
  inodes: Array.from({ length: 40 }, (_, index) => ({
    path: `w/d/many${index}`, parentPath: 'w/d', kind: 'file', isDir: false, size: 1, mtime: 1, mode: 0o644, chunkCount: 1,
  })),
  chunks: Array.from({ length: 40 }, (_, index) => ({ path: `w/d/many${index}`, chunkId: 0, data: enc.encode(String(index % 10)) })),
});
const touches = harness.statements.slice(statements).filter((statement) => statement.sql.trimStart().startsWith('UPDATE vfs_inodes SET mtime'));
assert.equal(touches.length, 1, `${touches.length} directory updates for 40 files in one directory`);

console.log('sqlite vfs directory times: ok');

// ── Against the host: which operations date which directories ──────────
// git's untracked cache keeps a directory's untracked list while the
// directory's stat data (mtime, ctime) is unchanged, so every operation that
// changes a directory's entries must change them, and none that leaves its
// entries alone may (that would only cost a rescan, but it would differ
// from git's own filesystem). The same script runs on the host filesystem
// and on the VFS; the answers must agree.
{
  const { mkdtempSync, writeFileSync, mkdirSync, rmdirSync, unlinkSync, renameSync, symlinkSync, chmodSync, statSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const host = mkdtempSync(join(tmpdir(), 'vfs-dir-times-'));
  const hostFs = {
    mkdir: (p) => mkdirSync(join(host, p)),
    write: (p, text) => writeFileSync(join(host, p), text),
    unlink: (p) => unlinkSync(join(host, p)),
    rmdir: (p) => rmdirSync(join(host, p)),
    rename: (a, b) => renameSync(join(host, a), join(host, b)),
    symlink: (target, p) => symlinkSync(target, join(host, p)),
    chmod: (p, mode) => chmodSync(join(host, p), mode),
    stamp: (p) => { const stat = statSync(join(host, p), { bigint: true }); return `${stat.mtimeNs}/${stat.ctimeNs}`; },
  };
  const vfsFs = {
    mkdir: (p) => vfs.mkdir(`h/${p}`),
    write: (p, text) => vfs.writeFile(`h/${p}`, text),
    unlink: (p) => vfs.unlink(`h/${p}`),
    rmdir: (p) => vfs.rmdir(`h/${p}`),
    rename: (a, b) => vfs.rename(`h/${a}`, `h/${b}`),
    symlink: (target, p) => vfs.symlink(target, `h/${p}`),
    chmod: (p, mode) => vfs.chmod(`h/${p}`, mode),
    stamp: (p) => { const stat = vfs.stat(`h/${p}`); return `${stat.mtime}/${stat.ctime}`; },
  };
  vfs.mkdir('h');
  const script = [
    ['create untracked file', (fs) => fs.write('a/new.txt', 'n')],
    ['rewrite it in place', (fs) => fs.write('a/new.txt', 'rewritten')],
    ['chmod it', (fs) => fs.chmod('a/new.txt', 0o600)],
    ['create a subdirectory', (fs) => fs.mkdir('a/sub')],
    ['create a file in the subdirectory', (fs) => fs.write('a/sub/deep.txt', 'd')],
    ['symlink', (fs) => fs.symlink('new.txt', 'a/link')],
    ['rename within', (fs) => fs.rename('a/new.txt', 'a/moved.txt')],
    ['rename out to b', (fs) => fs.rename('a/moved.txt', 'b/moved.txt')],
    ['rename a directory out', (fs) => fs.rename('a/sub', 'b/sub')],
    ['unlink', (fs) => fs.unlink('a/link')],
    ['rmdir in b', (fs) => { fs.unlink('b/sub/deep.txt'); }],
  ];
  const run = async (fs, advance) => {
    fs.mkdir('a');
    fs.mkdir('b');
    const answers = [];
    for (const [name, step] of script) {
      const before = { a: fs.stamp('a'), b: fs.stamp('b') };
      await advance();
      step(fs);
      answers.push([name, fs.stamp('a') !== before.a, fs.stamp('b') !== before.b]);
    }
    return answers;
  };
  const onHost = await run(hostFs, () => new Promise((resolve) => setTimeout(resolve, 15)));
  const onVfs = await run(vfsFs, async () => { tick(); });
  rmSync(host, { recursive: true, force: true });
  assert.deepEqual(onVfs, onHost, 'the VFS dated directories differently from the host filesystem');
  console.log('  ok  directory dating matches the host filesystem, operation by operation');
}

// ── A wave of many directories commits within the row bound ────────────
// The stream commits its directory records in strict batches; each
// directory now dates its parent too, and under a snapshot both keep a
// before-image. Batches are sized by the plan's own accounting. Red before:
// a fixed batch of MAX_TX_LOGICAL_ROWS directories failed live ("transaction
// exceeds logicalRows limit: 303 > 256", next.js and vscode clones), and
// under a snapshot it failed even before directories dated their parents.
for (const pinned of [false, true]) {
  const h = createSqliteVfsTestHarness();
  const r = new SqliteVFS(h.sql, h.ctx);
  const k = r.as(CRED_KERNEL);
  k.mkdir('repo', { recursive: true });
  if (pinned) r.snapshot('pin');
  const inodes = [];
  for (let top = 0; top < 30; top++) {
    inodes.push({ path: `repo/t${top}`, parentPath: 'repo', kind: 'directory', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });
    for (let leaf = 0; leaf < 30; leaf++) {
      inodes.push({ path: `repo/t${top}/l${leaf}`, parentPath: `repo/t${top}`, kind: 'directory', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 });
    }
  }
  const result = await k.writeStream(encodeWriteBatchStream({ inodes, chunks: [] }));
  assert.equal(result.ok, true, `${pinned ? 'pinned: ' : ''}${result.error?.message}`);
  assert.equal(k.readdir('repo').length, 30);
  assert.equal(k.readdir('repo/t29').length, 30);
}
console.log('  ok  930 directory records in one wave commit, with and without a snapshot');
