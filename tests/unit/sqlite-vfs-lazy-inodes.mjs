#!/usr/bin/env bun
// SQLite holds the inode tree and memory holds a bounded cache of it (N10).
// Opening reads no inode, and the cache stays within its bound however much
// of the tree is walked. What followed from every inode being resident still
// holds: counters, readdir order, descriptions sharing the canonical inode,
// rollback.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { CHUNK_SIZE } from '../../packages/platform/src/limits.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness, inodeTableScans } from './sqlite-vfs-test-harness.mjs';

const CRED_USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);

function openVfs(harness = createSqliteVfsTestHarness(), options = undefined) {
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx, undefined, options);
  return { harness, rawVfs, vfs: rawVfs.as(CRED_KERNEL) };
}

/** `dirs` packages of `perDir` files each, under `root`; every path created. */
function seedTree(vfs, root, dirs, perDir) {
  const paths = [root];
  vfs.mkdir(root, { recursive: true });
  for (let d = 0; d < dirs; d++) {
    const dir = `${root}/pkg-${d}/lib`;
    vfs.mkdir(dir, { recursive: true });
    paths.push(`${root}/pkg-${d}`, dir);
    for (let f = 0; f < perDir; f++) {
      vfs.writeFile(`${dir}/file-${f}.js`, `module.exports = ${d * perDir + f};\n`);
      paths.push(`${dir}/file-${f}.js`);
    }
  }
  return paths;
}

function counters(rawVfs) {
  const stats = rawVfs.getStats();
  return { files: stats.files, directories: stats.directories, usedBytes: stats.usedBytes };
}

// ── Opening costs the same at any size ────────────────────────────────────
// Every inode used to be read into a Map at construction, plus three scans of
// the whole table; at 1M files that was ~1.4 s and ~440 MiB before the first
// request. Now nothing is read until a path asks for it.
{
  const { harness, vfs } = openVfs();
  seedTree(vfs, 'proj', 20, 25);
  const reopening = createSqliteVfsTestHarness(harness.db);
  const reopened = new SqliteVFS(reopening.sql, reopening.ctx);
  assert.deepEqual(inodeTableScans(reopening), [], 'opening read the whole inode table');
  assert.equal(reopened.getStats().inodes.resident, 0, 'opening loaded inodes');
  assert.equal(reopened.as(CRED_KERNEL).readFileString('proj/pkg-7/lib/file-3.js'), 'module.exports = 178;\n');
  assert.equal(reopened.getStats().inodes.total, 20 * 27 + 1);
}

// ── The cache holds at most its bound, whatever is walked ─────────────────
{
  const { harness, rawVfs, vfs } = openVfs(undefined, { inodeCacheEntries: 16 });
  const paths = seedTree(vfs, 'tree', 12, 20);
  const from = harness.statements.length;
  for (const path of paths) {
    vfs.stat(path);
    if (vfs.isFile(path)) vfs.readFile(path);
    else vfs.readdir(path);
  }
  let after = null;
  do {
    const page = vfs.list(after, 7);
    after = page.next;
  } while (after !== null);
  vfs.rename('tree/pkg-0', 'tree/moved');
  assert.equal(vfs.removeRecursive('tree/pkg-1'), 22);
  assert.deepEqual(inodeTableScans(harness, from), [], 'a walk read the whole inode table');
  const stats = rawVfs.getStats();
  assert.equal(stats.inodes.cacheCapacity, 16);
  assert.ok(stats.inodes.resident <= 16, `${stats.inodes.resident} inodes resident in a 16-entry cache`);
  assert.equal(stats.inodes.total, paths.length - 22);
  assert.equal(vfs.readFileString('tree/moved/lib/file-19.js'), 'module.exports = 19;\n');
}

// ── Counters equal the durable aggregate after mixed operations ───────────
// ── and after a rollback ──────────────────────────────────────────────────
{
  const { harness, rawVfs, vfs } = openVfs(undefined, { inodeCacheEntries: 8 });
  rawVfs.getStats(); // counters are live from here on
  vfs.mkdir('a/b/c', { recursive: true });
  vfs.writeFile('a/one.txt', 'one');
  vfs.writeFile('a/one.txt', 'one, rewritten');
  vfs.symlink('one.txt', 'a/link');
  vfs.writeBatch({
    inodes: [
      { path: 'a/batch', parentPath: 'a', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 },
      { path: 'a/batch/x', parentPath: 'a/batch', isDir: false, size: 3, mtime: 1, mode: 0o644, chunkCount: 1 },
    ],
    chunks: [{ path: 'a/batch/x', chunkId: 0, data: encode('xyz') }],
  });
  const republishedIno = vfs.stat('a/batch/x').ino;
  // One batch that deletes a path and publishes it again: the delete is
  // counted, then the publication, and the path keeps its number.
  vfs.writeBatch({
    inodes: [{ path: 'a/batch/x', parentPath: 'a/batch', isDir: false, size: 5, mtime: 2, mode: 0o644, chunkCount: 1 }],
    chunks: [{ path: 'a/batch/x', chunkId: 0, data: encode('vwxyz') }],
    deletePaths: ['a/batch/x'],
  });
  assert.equal(vfs.stat('a/batch/x').ino, republishedIno);
  vfs.truncate('a/one.txt', CHUNK_SIZE + 10);
  vfs.truncate('a/one.txt', 2);
  vfs.writeRange('a/one.txt', 10, encode('tail'));
  const streamed = encode('streamed');
  const result = await vfs.writeStream(encodeWriteBatchStream({
    inodes: [
      { path: 'a/stream', parentPath: 'a', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 },
      { path: 'a/stream/s.txt', parentPath: 'a/stream', isDir: false, size: streamed.length, mtime: 1, mode: 0o644, chunkCount: 1 },
    ],
    chunks: [{ path: 'a/stream/s.txt', chunkId: 0, data: streamed }],
  }));
  assert.equal(result.ok, true);
  vfs.rename('a/one.txt', 'a/b/one.txt');
  vfs.writeFile('a/two.txt', 'two');
  vfs.rename('a/two.txt', 'a/b/one.txt');
  vfs.rename('a/b', 'a/moved');
  vfs.unlink('a/link');
  vfs.rmdir('a/moved/c');
  assert.equal(rawVfs._verifyCounters(), null, 'counters drifted from the durable rows');

  const before = counters(rawVfs);
  assert.throws(() => rawVfs.withTransaction(() => {
    vfs.writeFile('a/rolled.txt', 'gone');
    vfs.mkdir('a/rolled-dir');
    vfs.removeRecursive('a/moved');
    assert.equal(vfs.exists('a/moved'), false);
    throw new Error('roll back');
  }), /rolled back/);
  assert.deepEqual(counters(rawVfs), before, 'a rollback moved the counters');
  assert.equal(rawVfs._verifyCounters(), null);
  assert.equal(vfs.readFileString('a/moved/one.txt'), 'two');
  assert.equal(vfs.exists('a/rolled.txt'), false);

  const reopened = openVfs(createSqliteVfsTestHarness(harness.db)).rawVfs;
  assert.deepEqual(counters(reopened), counters(rawVfs));
  assert.equal(vfs.removeRecursive('a'), before.files + before.directories);
  assert.deepEqual(counters(rawVfs), { files: 0, directories: 0, usedBytes: 0 });
  assert.equal(rawVfs._verifyCounters(), null);
}

// ── readdir order is the one it always was ────────────────────────────────
// UTF-16 code-unit order, whatever order SQLite returns the rows in. The two
// disagree past the Basic Multilingual Plane: '\u{1F600}' sorts before
// '\uFF01' here and after it in SQLite's byte order.
{
  const { vfs } = openVfs(undefined, { inodeCacheEntries: 4 });
  const names = ['b', 'B', 'a', '_', '-', '10', '9', 'Zz', 'é', 'z', 'a.b', 'a-b', '\u{1F600}', '\uFF01', '\uE000'];
  vfs.mkdir('d');
  for (const name of names) vfs.writeFile(`d/${name}`, name);
  const expected = [...names].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  assert.deepEqual(vfs.readdir('d').map((entry) => entry.name), expected);
  assert.ok(expected.indexOf('\u{1F600}') < expected.indexOf('\uFF01'));
}

// ── Descriptions share the canonical inode with an 8-entry cache ──────────
// A second descriptor sees a change through the first at once, and an unlink
// leaves every holder on the same retired inode. An open description's inode
// is never evicted: a reload would hand the next opener a second object.
{
  const { rawVfs, vfs } = openVfs(undefined, { inodeCacheEntries: 8 });
  vfs.mkdir('d');
  vfs.writeFile('d/a.txt', 'hello');
  for (let i = 0; i < 64; i++) vfs.writeFile(`d/other-${i}`, 'x');
  const readChurn = () => { for (let i = 0; i < 64; i++) vfs.stat(`d/other-${i}`); };

  const first = rawVfs.openDescription('d/a.txt', CRED_KERNEL, { read: true, write: true });
  readChurn(); // no mutation, so nothing re-points `first`: only eviction could split it
  const second = rawVfs.openDescription('d/a.txt', CRED_KERNEL, { read: true, write: false });
  assert.equal(first.ino, second.ino);

  vfs.chmod('d/a.txt', 0o600);
  assert.equal(first.stat().mode & 0o777, 0o600);
  assert.equal(second.stat().mode & 0o777, 0o600);
  first.write(0, encode('HELLO'));
  readChurn();
  assert.equal(decode(second.read(0, 5)), 'HELLO');
  assert.equal(vfs.readFileString('d/a.txt'), 'HELLO');
  first.utimes(1000, 2000);
  readChurn();
  assert.equal(vfs.stat('d/a.txt').mtime, 2000);
  assert.equal(second.stat().mtime, 2000);

  vfs.rename('d/a.txt', 'd/b.txt');
  readChurn();
  assert.equal(first.path(), 'd/b.txt');
  assert.equal(second.path(), 'd/b.txt');

  vfs.unlink('d/b.txt');
  readChurn();
  assert.equal(first.stat().nlink, 0);
  assert.equal(second.stat().nlink, 0);
  first.chmod(0o640);
  assert.equal(second.stat().mode & 0o777, 0o640, 'the unlinked holders diverged');
  first.write(5, encode('!'));
  assert.equal(decode(second.read(0, 6)), 'HELLO!');
  first.close();
  second.close();
  assert.ok(rawVfs.getStats().inodes.resident <= 8);
}

// ── A list page resumes across entries the caller cannot see ──────────────
{
  const { harness, rawVfs, vfs } = openVfs(undefined, { inodeCacheEntries: 8 });
  vfs.mkdir('open');
  vfs.mkdir('shut');
  for (let i = 0; i < 30; i++) vfs.writeFile(`shut/f-${String(i).padStart(2, '0')}`, 'hidden');
  for (let i = 0; i < 5; i++) vfs.writeFile(`open/f-${i}`, 'shown');
  vfs.writeFile('zz-last', 'shown');
  vfs.chmod('shut', 0o700);
  const user = rawVfs.as(CRED_USER);
  const from = harness.statements.length;
  const listed = [];
  let pages = 0;
  let after = null;
  do {
    const page = user.list(after, 2);
    pages++;
    assert.ok(page.entries.length <= 2);
    for (const entry of page.entries) listed.push(entry.path);
    after = page.next;
  } while (after !== null);
  assert.deepEqual(inodeTableScans(harness, from), []);
  assert.deepEqual(listed, ['open', 'open/f-0', 'open/f-1', 'open/f-2', 'open/f-3', 'open/f-4', 'shut', 'zz-last']);
  assert.equal(pages, 4);
}

// ── A removal larger than one page of the subtree ─────────────────────────
// Each directory's entries go before it, however the pages fall, and
// every directory is checked readable before the first group commits.
{
  const PATHS = 4400; // past one 4096-row page
  const { harness, rawVfs, vfs } = openVfs(undefined, { inodeCacheEntries: 64 });
  vfs.mkdir('big/aaa-opaque', { recursive: true });
  vfs.writeFile('big/aaa-opaque/kept', 'x');
  const created = ['big', 'big/aaa-opaque', 'big/aaa-opaque/kept'];
  for (let dir = 0; created.length < PATHS; dir++) {
    const parent = `big/d-${String(dir).padStart(3, '0')}`;
    const inodes = [{ path: parent, parentPath: 'big', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 }];
    for (let f = 0; f < 40; f++) {
      inodes.push({ path: `${parent}/f-${f}`, parentPath: parent, isDir: false, size: 0, mtime: 1, mode: 0o644, chunkCount: 0 });
    }
    vfs.writeBatch({ inodes, chunks: [] });
    created.push(...inodes.map((inode) => inode.path));
  }
  rawVfs.getStats();
  // Sorts first, so a descending walk reaches it on the last page.
  vfs.chown('big', 1000, 1000);
  vfs.chown('big/aaa-opaque', 1000, 1000);
  vfs.chmod('big/aaa-opaque', 0o333);
  const user = rawVfs.as(CRED_USER);
  assert.throws(() => user.removeRecursive('big'), /EACCES: big\/aaa-opaque/);
  assert.equal(rawVfs.getStats().inodes.total, created.length, 'a refused removal removed something');

  const order = [];
  rawVfs.events.on((batch) => {
    for (const event of batch) if (event.type === 'unlink' || event.type === 'unlinkDir') order.push(event.path);
  });
  const from = harness.statements.length;
  assert.equal(vfs.removeRecursive('big'), created.length);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(inodeTableScans(harness, from), []);
  assert.equal(order.length, created.length);
  const position = new Map(order.map((path, index) => [path, index]));
  for (const path of created) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (position.has(parent)) assert.ok(position.get(path) < position.get(parent), `${parent} went before ${path}`);
  }
  assert.equal(rawVfs._verifyCounters(), null);
  assert.deepEqual(counters(rawVfs), { files: 0, directories: 0, usedBytes: 0 });
  assert.ok(rawVfs.getStats().inodes.resident <= 64);
}

// ── A row with no ino is numbered on first read, never reusing one ────────
// Only code older than the ino column writes such a row. Opening no longer
// scans for them, so the first read numbers the row from the allocator.
{
  const { harness, vfs } = openVfs();
  vfs.writeFile('a.txt', 'a');
  const aIno = vfs.stat('a.txt').ino;
  harness.sql.exec(
    `INSERT INTO inodes (path, parent_path, kind, size, mtime, mode, chunk_count)
     VALUES ('legacy.txt', '', 0, 0, 1, ${0o100644}, 0)`,
  );
  const reopened = openVfs(createSqliteVfsTestHarness(harness.db)).vfs;
  const legacyIno = reopened.stat('legacy.txt').ino;
  assert.ok(legacyIno > aIno, `legacy row numbered ${legacyIno}, beside ${aIno}`);
  reopened.writeFile('b.txt', 'b');
  assert.ok(reopened.stat('b.txt').ino > legacyIno);
  assert.equal(openVfs(createSqliteVfsTestHarness(harness.db)).vfs.stat('legacy.txt').ino, legacyIno);
}

console.log('sqlite-vfs-lazy-inodes: ok');
