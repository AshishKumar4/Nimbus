#!/usr/bin/env bun
// Behavior tests for the fd syscall surface of the generated Node shims:
// openSync/readSync/writeSync/fstatSync/ftruncateSync/closeSync plus the
// async callback forms, driven against the REAL SqliteRuntimeFsBridge.
//
// The load-bearing contract is the resident/live boundary. A node facet has
// no synchronous I/O primitive, so sync reads are served from the resident
// view (__vfsWrites over __vfsBundle) and content that is only live in
// SQLite must fail EAGAIN — loudly — instead of returning wrong bytes.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);

const supervisor = {
  readFile: async (p) => { const b = await bridge.readFile(p); return b ? new TextDecoder().decode(b) : null; },
  readFileBytes: (p) => bridge.readFile(p),
  writeFile: (p, c) => bridge.writeFile(p, c),
  stat: (p) => bridge.stat(p),
  lstat: (p) => bridge.stat(p, { followSymlinks: false }),
  readdir: (p) => bridge.readdir(p),
  exists: async (p) => (await bridge.stat(p)) !== null,
  mkdir: (p) => bridge.mkdir(p, { recursive: true }),
  unlink: (p) => bridge.unlink(p),
  rmdir: (p) => bridge.rmdir(p),
  rename: (f, t) => bridge.rename(f, t),
  utimes: (p, a, m) => bridge.utimes(p, a, m),
  fsReadRange: (p, o, l) => bridge.readRange(p, o, l),
  fsWriteRange: (p, o, b) => bridge.writeRange(p, o, b),
  fsTruncate: (p, s) => bridge.truncate(p, s),
};

const enc = new TextEncoder();
const dec = new TextDecoder();
// __vfsWrites cells are string | Uint8Array by contract (facets/manager.ts).
const _bytes = (cell) => (typeof cell === 'string' ? enc.encode(cell) : cell);

const bundle = {};
const metadata = {};
const writes = {};
const dirs = {};

const code = generateShimsCode();
const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + code + '\n;return { fs: __fsMod, process: __processMod };'
);
const sandbox = factory(
  bundle, metadata, writes, dirs, null, supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
);
const fs = sandbox.fs;

vfs.mkdir('home/user', { recursive: true });
dirs['home/user'] = true;

// ── the regression that started this: openSync must exist ──
for (const name of ['openSync', 'closeSync', 'readSync', 'writeSync', 'fstatSync', 'ftruncateSync']) {
  assert.equal(typeof fs[name], 'function', `fs.${name} must be a function`);
}
for (const name of ['open', 'close', 'read', 'write', 'fstat', 'ftruncate', 'fsync', 'fdatasync']) {
  assert.equal(typeof fs[name], 'function', `fs.${name} must be a function`);
}

// ── ENOENT: opening a missing path without O_CREAT ──
assert.throws(() => fs.openSync('/home/user/nope.txt', 'r'), (e) => {
  assert.equal(e.code, 'ENOENT');
  assert.equal(e.syscall, 'open');
  return true;
});

// ── O_CREAT: create, write, read back byte-exactly ──
const fd = fs.openSync('/home/user/fd.txt', 'w+');
assert.equal(typeof fd, 'number');
assert.ok(fd >= 3, 'allocated fds must not collide with stdio');

assert.equal(fs.writeSync(fd, 'hello world'), 11);
assert.equal(fs.fstatSync(fd).size, 11, 'fstatSync must see the just-written size');
assert.equal(fs.fstatSync(fd).isFile(), true);

// Positional read (does not move the file position).
const buf = Buffer.alloc(32);
assert.equal(fs.readSync(fd, buf, 0, 5, 0), 5);
assert.equal(dec.decode(buf.subarray(0, 5)), 'hello');
assert.equal(fs.readSync(fd, buf, 0, 5, 6), 5);
assert.equal(dec.decode(buf.subarray(0, 5)), 'world');

// Partial read: asking for more than remains returns only what exists.
assert.equal(fs.readSync(fd, buf, 0, 32, 6), 5);
// Reading past EOF yields 0 bytes, not an error.
assert.equal(fs.readSync(fd, buf, 0, 8, 100), 0);

// Sequential reads advance the position.
const seq = fs.openSync('/home/user/fd.txt', 'r');
assert.equal(fs.readSync(seq, buf, 0, 5), 5);
assert.equal(dec.decode(buf.subarray(0, 5)), 'hello');
assert.equal(fs.readSync(seq, buf, 0, 6), 6);
assert.equal(dec.decode(buf.subarray(0, 6)), ' world');
assert.equal(fs.readSync(seq, buf, 0, 4), 0, 'position is at EOF');
fs.closeSync(seq);

// Offset into the destination buffer is honoured.
buf.fill(0);
assert.equal(fs.readSync(fd, buf, 4, 5, 0), 5);
assert.equal(dec.decode(buf.subarray(4, 9)), 'hello');
assert.equal(buf[0], 0, 'bytes before the offset are untouched');

// Positional write into the middle rewrites only that range.
assert.equal(fs.writeSync(fd, Buffer.from('WORLD'), 0, 5, 6), 5);
assert.equal(fs.readFileSync('/home/user/fd.txt', 'utf8'), 'hello WORLD');

// Writing past EOF zero-fills the gap.
assert.equal(fs.writeSync(fd, Buffer.from('!'), 0, 1, 13), 1);
const grown = fs.readFileSync('/home/user/fd.txt');
assert.equal(grown.length, 14);
assert.equal(grown[11], 0);
assert.equal(grown[12], 0);
assert.equal(dec.decode(grown.subarray(13)), '!');

fs.closeSync(fd);

// writeSync(fd, string[, position[, encoding]]) — the encoding is the FOURTH
// argument, not the fifth. Reading it from the wrong slot silently writes
// UTF-8 bytes where base64/hex was asked for.
const efd = fs.openSync('/home/user/enc.bin', 'w');
assert.equal(fs.writeSync(efd, 'aGVsbG8=', 0, 'base64'), 5);
fs.closeSync(efd);
assert.equal(fs.readFileSync('/home/user/enc.bin', 'utf8'), 'hello');
const hfd = fs.openSync('/home/user/hex.bin', 'w');
assert.equal(fs.writeSync(hfd, '414243', 0, 'hex'), 3);
fs.closeSync(hfd);
assert.equal(fs.readFileSync('/home/user/hex.bin', 'utf8'), 'ABC');

// ── EBADF: any operation on a closed fd ──
for (const [name, run] of [
  ['readSync', () => fs.readSync(fd, buf, 0, 1, 0)],
  ['writeSync', () => fs.writeSync(fd, 'x')],
  ['fstatSync', () => fs.fstatSync(fd)],
  ['ftruncateSync', () => fs.ftruncateSync(fd, 0)],
  ['closeSync', () => fs.closeSync(fd)],
]) {
  assert.throws(run, (e) => {
    assert.equal(e.code, 'EBADF', `${name} on a closed fd must be EBADF`);
    return true;
  }, `${name} on a closed fd must throw`);
}
// A never-allocated fd is equally EBADF.
assert.throws(() => fs.fstatSync(9999), (e) => e.code === 'EBADF');

// ── O_TRUNC ──
fs.writeFileSync('/home/user/trunc.txt', 'abcdefgh');
const tfd = fs.openSync('/home/user/trunc.txt', 'w');
assert.equal(fs.fstatSync(tfd).size, 0, 'O_TRUNC empties the file at open');
assert.equal(fs.readFileSync('/home/user/trunc.txt', 'utf8'), '');
fs.writeSync(tfd, 'new');
fs.closeSync(tfd);
assert.equal(fs.readFileSync('/home/user/trunc.txt', 'utf8'), 'new');

// ── O_APPEND: every write lands at EOF regardless of position ──
fs.writeFileSync('/home/user/app.txt', 'base');
const afd = fs.openSync('/home/user/app.txt', 'a');
fs.writeSync(afd, '-one');
fs.writeSync(afd, '-two');
// An explicit position is ignored under O_APPEND, as in POSIX.
fs.writeSync(afd, '-three', 0);
fs.closeSync(afd);
assert.equal(fs.readFileSync('/home/user/app.txt', 'utf8'), 'base-one-two-three');

// ── O_EXCL ──
assert.throws(() => fs.openSync('/home/user/app.txt', 'wx'), (e) => e.code === 'EEXIST');
const xfd = fs.openSync('/home/user/excl-new.txt', 'wx');
fs.closeSync(xfd);

// ── read/write permission enforcement ──
const rofd = fs.openSync('/home/user/app.txt', 'r');
assert.throws(() => fs.writeSync(rofd, 'nope'), (e) => e.code === 'EBADF');
fs.closeSync(rofd);
const wofd = fs.openSync('/home/user/wo.txt', 'w');
assert.throws(() => fs.readSync(wofd, buf, 0, 1, 0), (e) => e.code === 'EBADF');
fs.closeSync(wofd);

// ── EISDIR ──
assert.throws(() => fs.openSync('/home/user', 'r'), (e) => e.code === 'EISDIR');

// ── ftruncateSync shrinks and grows ──
fs.writeFileSync('/home/user/t2.txt', '0123456789');
const t2 = fs.openSync('/home/user/t2.txt', 'r+');
fs.ftruncateSync(t2, 4);
assert.equal(fs.readFileSync('/home/user/t2.txt', 'utf8'), '0123');
assert.equal(fs.fstatSync(t2).size, 4);
fs.ftruncateSync(t2, 6);
const grownT = fs.readFileSync('/home/user/t2.txt');
assert.equal(grownT.length, 6);
assert.equal(grownT[4], 0, 'growing truncate zero-fills');
fs.closeSync(t2);

// ── stdio fds are not descriptors and must not EBADF ──
let stdoutSeen = '';
sandbox.process.stdout.write = (d) => { stdoutSeen += String(d); return true; };
assert.equal(fs.writeSync(1, 'to stdout'), 9);
assert.equal(stdoutSeen, 'to stdout');
assert.equal(fs.readSync(0, buf, 0, 4, null), 0, 'unattached stdin reads as EOF');
assert.equal(fs.fstatSync(1).isCharacterDevice(), true);
assert.equal(fs.fstatSync(1).isFile(), false);
fs.closeSync(1); // closing stdio is legal and a no-op

// ── the resident/live boundary ──
// Documented limit: a file that appeared in SQLite AFTER the facet booted is
// invisible to the sync view (learning about it needs an RPC, which cannot
// block), so openSync reports ENOENT — the same answer readFileSync already
// gives for such a path. One mechanism, one answer.
vfs.writeFile('home/user/born-later.bin', enc.encode('UNSEEN'));
assert.throws(() => fs.openSync('/home/user/born-later.bin', 'r'), (e) => e.code === 'ENOENT');
assert.throws(() => fs.readFileSync('/home/user/born-later.bin'), (e) => e.code === 'ENOENT');
// ...while the async form sees it, because it can reach the supervisor.
assert.equal(await fs.promises.readFile('/home/user/born-later.bin', 'utf8'), 'UNSEEN');

// The interesting case: the path IS known to the sync view (the spawn-time
// prefetch records metadata for the whole tree) but its CONTENT was capped
// out and lives only in SQLite. open succeeds; sync I/O must then refuse
// loudly rather than serve bytes it does not have.
vfs.writeFile('home/user/live-only.bin', enc.encode('LIVEDATA-0123456789'));
metadata['home/user/live-only.bin'] = {
  type: 'file', size: 19, mode: 0o644, uid: 1000, gid: 1000, mtime: Date.now(),
};
const lfd = fs.openSync('/home/user/live-only.bin', 'r+');
assert.throws(() => fs.readSync(lfd, buf, 0, 4, 0), (e) => {
  assert.equal(e.code, 'EAGAIN', 'non-resident sync read must be EAGAIN');
  assert.match(e.message, /not resident/);
  return true;
});
// Writing onto a non-resident, non-empty file would silently destroy the
// bytes we cannot see, so it must refuse too.
assert.throws(() => fs.writeSync(lfd, 'x', 0), (e) => e.code === 'EAGAIN');

// The async form on the SAME fd CAN do live I/O and must succeed.
const liveRead = await new Promise((res, rej) =>
  fs.read(lfd, Buffer.alloc(8), 0, 8, 0, (e, n, b) => (e ? rej(e) : res({ n, b }))));
assert.equal(liveRead.n, 8);
assert.equal(dec.decode(liveRead.b.subarray(0, 8)), 'LIVEDATA');
fs.closeSync(lfd);

// ── async callback surface: open → write → fstat → read → ftruncate → close ──
const afd2 = await new Promise((res, rej) =>
  fs.open('/home/user/async.txt', 'w+', (e, d) => (e ? rej(e) : res(d))));
assert.equal(typeof afd2, 'number');
const wrote = await new Promise((res, rej) =>
  fs.write(afd2, Buffer.from('async bytes'), 0, 11, 0, (e, n) => (e ? rej(e) : res(n))));
assert.equal(wrote, 11);
const astat = await new Promise((res, rej) => fs.fstat(afd2, (e, s) => (e ? rej(e) : res(s))));
assert.equal(astat.size, 11);
const aread = await new Promise((res, rej) =>
  fs.read(afd2, Buffer.alloc(5), 0, 5, 6, (e, n, b) => (e ? rej(e) : res({ n, b }))));
assert.equal(dec.decode(aread.b.subarray(0, aread.n)), 'bytes');
await new Promise((res, rej) => fs.ftruncate(afd2, 5, (e) => (e ? rej(e) : res())));
await new Promise((res, rej) => fs.close(afd2, (e) => (e ? rej(e) : res())));
assert.equal(dec.decode(await bridge.readFile('/home/user/async.txt')), 'async');
// EBADF flows through the callback, not as a throw.
const closedErr = await new Promise((res) => fs.fstat(afd2, (e) => res(e)));
assert.equal(closedErr.code, 'EBADF');

// fs.promises.open still hands back a FileHandle sharing the same fd table.
const handle = await fs.promises.open('/home/user/async.txt', 'r');
assert.equal(typeof handle.fd, 'number');
assert.equal(fs.fstatSync(handle.fd).size, 5, 'sync ops work on a promises-opened fd');
await handle.close();
assert.throws(() => fs.fstatSync(handle.fd), (e) => e.code === 'EBADF');

// ── writes are durable through the existing write-back path ──
// writeSync buffers into __vfsWrites exactly as writeFileSync does. That map
// IS the contract the facet epilogue consumes: facets/manager.ts drains every
// cell to supervisor.writeFile() before reporting exit. A facet cannot block
// on durability, so fsyncSync validates the fd and marks the VFS stale rather
// than pretending to flush.
const dfd = fs.openSync('/home/user/durable.txt', 'w');
fs.writeSync(dfd, 'persisted');
fs.fsyncSync(dfd);
fs.closeSync(dfd);
assert.equal(dec.decode(_bytes(writes['home/user/durable.txt'])), 'persisted',
  'sync writes are staged in __vfsWrites for the epilogue drain');

// Any async op touching the same path drains it early, and then SQLite has it.
await fs.promises.truncate('/home/user/durable.txt', 9);
assert.equal(writes['home/user/durable.txt'], undefined, 'the staged cell was flushed');
assert.equal(dec.decode(await bridge.readFile('/home/user/durable.txt')), 'persisted',
  'sync writes reach the live VFS');

console.log('node-shims fd syscalls: OK');
