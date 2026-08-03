#!/usr/bin/env bun
// A stat is a report about a file, and a facet may only report what the
// authority told it. Where it has no record it says so — it does not fill
// the gap with a zero size, a stock mode, and the reader's own uid, which is
// an answer that is not merely wrong but wrong in the reader's favour: an
// access check against a manufactured owner is a check against the caller
// itself, and it always passes.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/worker/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const READER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const dir = '/home/user/authority';
const owned = `${dir}/owned.txt`;
const foreign = `${dir}/root-private.txt`;
const lateFile = `${dir}/late.txt`;
const lateDir = `${dir}/late-dir`;

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
const enc = new TextEncoder();
const dec = new TextDecoder();

kernel.mkdir(dir, { recursive: true });
kernel.chown(dir, READER.uid, READER.gid);

// Owned by the reader, and readable/writable by it.
const vfs = rawVfs.as(READER);
vfs.writeFile(owned, enc.encode('mine'));

// Owned by root and private to root — the case the fabrication hid. It is
// in the spawn snapshot, so the facet has a record for it from the start.
kernel.writeFile(foreign, enc.encode('root-only-content'));
kernel.chmod(foreign, 0o600);

// The bridge speaks for the reader, exactly as the facet claims to be.
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const supervisor = {
  readFile: async (path) => {
    const bytes = await bridge.readFile(path);
    return bytes ? dec.decode(bytes) : null;
  },
  writeFile: (path, content) => bridge.writeFile(path, content),
  stat: (path) => bridge.stat(path),
  lstat: (path) => bridge.stat(path, { followSymlinks: false }),
  readdir: (path) => bridge.readdir(path),
  exists: async (path) => (await bridge.stat(path)) !== null,
  access: (path, mode) => bridge.access(path, mode),
  mkdir: (path) => bridge.mkdir(path, { recursive: true }),
  fsReadRange: (path, offset, length) => bridge.readRange(path, offset, length),
  fsWriteRange: (path, offset, bytes) => bridge.writeRange(path, offset, bytes),
  fsTruncate: (path, size) => bridge.truncate(path, size),
};

// The spawn snapshot, in the shape buildVfsMetadata() produces: a record for
// every path the bundle or the manifest names, taken from the authority.
const snapshot = (path) => {
  const stat = kernel.lstat(path.replace(/^\//, ''));
  return { type: stat.type, size: stat.size, mode: stat.mode, uid: stat.uid, gid: stat.gid };
};

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
    '\n;return { fs: __fsMod };',
);
const { fs } = factory(
  { 'home/user/authority/owned.txt': 'mine' },
  {
    'home/user': snapshot('/home/user'),
    'home/user/authority': snapshot(dir),
    'home/user/authority/owned.txt': snapshot(owned),
    'home/user/authority/root-private.txt': snapshot(foreign),
  },
  {},
  { 'home/user': ['authority'], 'home/user/authority': ['owned.txt', 'root-private.txt'] },
  supervisor,
  READER,
  dir, [], {}, `${dir}/main.mjs`, dir,
);
const fsp = fs.promises;

// ── the record is served, not a stand-in for it ────────────────────────────
{
  const stat = fs.statSync(owned);
  assert.equal(stat.size, 4);
  assert.equal(stat.mode, 0o100644);
  assert.equal(stat.uid, READER.uid);
  assert.equal(stat.gid, READER.gid);
  assert.equal(stat.isFile(), true);
}

// The reader is NOT the owner here. Every field has to say so: the mode the
// authority recorded, root's uid and gid, and the real length — not 0, not
// 0644, and above all not the reader's own credentials.
{
  const stat = fs.statSync(foreign);
  assert.equal(stat.uid, 0, 'ownership is the file\'s, never the reader\'s');
  assert.equal(stat.gid, 0);
  assert.equal(stat.mode, 0o100600);
  assert.equal(stat.size, 'root-only-content'.length);
  assert.notEqual(stat.uid, READER.uid);

  // ...and the access check that reads it agrees with the authority.
  assert.throws(
    () => fs.accessSync(foreign, fs.constants.R_OK),
    (error) => error.code === 'EACCES' && error.errno === -13,
    'a private file owned by another user is not readable',
  );
  await assert.rejects(fsp.access(foreign, fs.constants.R_OK), (error) => error.code === 'EACCES');
  assert.throws(
    () => fs.writeFileSync(foreign, 'overwritten'),
    (error) => error.code === 'EACCES' && error.syscall === 'open',
  );
  assert.equal(
    dec.decode(kernel.readFile(foreign.replace(/^\//, ''))),
    'root-only-content',
    'a denied write leaves the authority untouched',
  );
}

// ── a path discovered after spawn has no record, and says so ───────────────
kernel.writeFile(lateFile, enc.encode('created-after-spawn'));
kernel.chmod(lateFile, 0o600);
kernel.mkdir(lateDir, { recursive: true });

assert.deepEqual(
  (await fsp.readdir(dir)).sort(),
  ['late-dir', 'late.txt', 'owned.txt', 'root-private.txt'],
  'a live listing names everything, including what spawned after this facet',
);

// The listing carries names and nothing else. Reporting late.txt as an empty
// 0644 file owned by the reader is the defect; refusing, and naming both the
// path and the call that would answer, is the fix.
for (const path of [lateFile, lateDir]) {
  assert.throws(() => fs.statSync(path), (error) => {
    assert.equal(error.code, 'EAGAIN');
    assert.equal(error.path, path);
    assert.match(error.message, /no stat record/);
    assert.match(error.message, /fs\.promises\.stat/);
    return true;
  });
  // throwIfNoEntry:false is Node's "missing is not an error" switch, and
  // this path is not missing — suppressing the refusal would hand back
  // undefined for a file that is right there.
  assert.throws(
    () => fs.statSync(path, { throwIfNoEntry: false }),
    (error) => error.code === 'EAGAIN',
  );
  assert.equal(fs.existsSync(path), true, 'the name is known even when the record is not');
}

// A permission question cannot be deferred from a synchronous call, and
// "granted" is the one answer that cannot be taken back.
assert.throws(
  () => fs.accessSync(lateFile, fs.constants.R_OK),
  (error) => error.code === 'EAGAIN' && error.syscall === 'access',
  'access does not grant on a record it does not hold',
);
assert.doesNotThrow(
  () => fs.accessSync(lateFile, fs.constants.F_OK),
  'existence needs no record — the listing already proved it',
);

// Writing to a path known only by name does not make the writer its owner —
// the ownership claim a creating write is entitled to make belongs only to a
// path that was not there, or the fabrication returns by another door.
{
  const sideDoor = `${dir}/side-door.txt`;
  kernel.writeFile(sideDoor, enc.encode('root-wrote-this'));
  kernel.chmod(sideDoor, 0o666);
  await fsp.readdir(dir);
  fs.writeFileSync(sideDoor, 'local-overwrite');
  assert.throws(
    () => fs.statSync(sideDoor),
    (error) => error.code === 'EAGAIN',
    'a local write does not conjure a record for a file that already existed',
  );
}

// Genuine absence keeps its own code.
assert.throws(
  () => fs.statSync(`${dir}/never-existed.txt`),
  (error) => error.code === 'ENOENT',
);
assert.equal(fs.statSync(`${dir}/never-existed.txt`, { throwIfNoEntry: false }), undefined);

// ── an async observation is kept, and the sync view is served from it ──────
{
  const live = await fsp.stat(lateFile);
  assert.equal(live.uid, 0);
  assert.equal(live.mode, 0o100600);

  const sync = fs.statSync(lateFile);
  assert.equal(sync.uid, 0, 'the record the async call paid for is the one the sync call serves');
  assert.equal(sync.gid, 0);
  assert.equal(sync.mode, 0o100600);
  assert.equal(sync.size, 'created-after-spawn'.length, 'a non-empty file is never reported empty');
  assert.equal(sync.isFile(), true);

  assert.throws(
    () => fs.accessSync(lateFile, fs.constants.R_OK),
    (error) => error.code === 'EACCES',
    'once the real owner is known the check denies, where it used to pass',
  );
}

// A directory is reported as a directory. The fabrication returned isFile()
// for every path it had only heard the name of, directories included.
{
  const live = await fsp.stat(lateDir);
  assert.equal(live.isDirectory(), true);
  const sync = fs.statSync(lateDir);
  assert.equal(sync.isDirectory(), true);
  assert.equal(sync.isFile(), false);
  assert.equal(sync.uid, 0);
}

// Reading a path fetches the record that describes it on the same trip, so
// bytes in hand never come with an unknown owner.
{
  const other = `${dir}/read-first.txt`;
  kernel.writeFile(other, enc.encode('bytes'));
  await fsp.readdir(dir);
  assert.equal(await fsp.readFile(other, 'utf8'), 'bytes');
  const stat = fs.statSync(other);
  assert.equal(stat.uid, 0);
  assert.equal(stat.size, 5);
}

// ── what this process creates, it owns ─────────────────────────────────────
// The one case where the caller's own credentials ARE the record: a creating
// syscall assigns them, so they are written down at creation rather than
// re-derived from the reader at every stat.
{
  const made = `${dir}/made-here.txt`;
  fs.writeFileSync(made, 'local');
  const stat = fs.statSync(made);
  assert.equal(stat.uid, READER.uid);
  assert.equal(stat.gid, READER.gid);
  assert.equal(stat.mode, 0o100644, '0666 & ~umask, as creat(2) defines it');
  assert.equal(stat.size, 5);
  assert.equal(stat.isFile(), true);

  const madeDir = `${dir}/made-dir`;
  fs.mkdirSync(madeDir);
  const dirStat = fs.statSync(madeDir);
  assert.equal(dirStat.isDirectory(), true);
  assert.equal(dirStat.uid, READER.uid);
  assert.equal(dirStat.mode, 0o40755, '0777 & ~umask');

  // Writing to a file does not make the writer its owner.
  fs.writeFileSync(owned, 'rewritten-by-owner');
  assert.equal(fs.statSync(owned).uid, READER.uid);
  assert.equal(fs.statSync(owned).size, 'rewritten-by-owner'.length);
}

console.log('node-shims-stat-authority: all assertions passed');
