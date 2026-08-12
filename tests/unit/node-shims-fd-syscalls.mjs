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
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
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
let writes;
const dirs = {};

const code = generateShimsCode();
const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + code +
    '\n;return { fs: __fsMod, process: __processMod, writes: __vfsWrites };'
);
const sandbox = factory(
  bundle, metadata, dirs, null, supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
);
writes = sandbox.writes;
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

// ── a failure with nowhere to go must be raised, not swallowed ──
assert.throws(() => fs.close(9999), (e) => e.code === 'EBADF',
  'close without a callback must surface EBADF');
assert.throws(() => fs.fsync(9999), (e) => e.code === 'EBADF');
const closeErr = await new Promise((res) => fs.close(9999, (e) => res(e)));
assert.equal(closeErr.code, 'EBADF', 'with a callback it arrives there instead');

// ── O_APPEND must never pre-create ──
// `exists` is only as good as the sync view, so a file that lives only in
// SQLite looks absent. Zeroing it at open time would destroy the very
// content an append was asked to preserve.
vfs.writeFile('home/user/live-append.log', enc.encode('PRIOR'));
const preFd = fs.openSync('/home/user/live-append.log', 'a');
fs.closeSync(preFd);
assert.equal(dec.decode(await bridge.readFile('/home/user/live-append.log')), 'PRIOR',
  'opening for append with no write must not truncate');
// The async form stats live, so it appends correctly.
const liveAppend = await fs.promises.open('/home/user/live-append.log', 'a');
await liveAppend.write('-more');
await liveAppend.close();
assert.equal(dec.decode(await bridge.readFile('/home/user/live-append.log')), 'PRIOR-more');

// ── position -1 means "current position", not offset 0 ──
fs.writeFileSync('/home/user/neg.bin', '0123456789');
const nfd = fs.openSync('/home/user/neg.bin', 'r+');
assert.equal(fs.readSync(nfd, buf, 0, 3, null), 3);
assert.equal(dec.decode(buf.subarray(0, 3)), '012');
assert.equal(fs.readSync(nfd, buf, 0, 3, -1), 3, 'a negative position reads from the cursor');
assert.equal(dec.decode(buf.subarray(0, 3)), '345', 'not a re-read of byte 0');
fs.closeSync(nfd);
const wnfd = fs.openSync('/home/user/neg2.bin', 'w');
fs.writeSync(wnfd, Buffer.from('AB'), 0, 2, null);
fs.writeSync(wnfd, Buffer.from('CD'), 0, 2, -1);
fs.closeSync(wnfd);
assert.equal(fs.readFileSync('/home/user/neg2.bin', 'utf8'), 'ABCD',
  'a negative position appends at the cursor instead of overwriting from 0');

// ── the options form of write/writeSync must not silently write 0 bytes ──
const ofd = fs.openSync('/home/user/opts.bin', 'w');
assert.equal(fs.writeSync(ofd, Buffer.from('XYZ!'), { offset: 1, length: 2, position: 0 }), 2);
fs.closeSync(ofd);
assert.equal(fs.readFileSync('/home/user/opts.bin', 'utf8'), 'YZ');

// ── the options forms of fs.read must invoke the callback ──
fs.writeFileSync('/home/user/ropts.bin', 'abcdef');
const rofd2 = fs.openSync('/home/user/ropts.bin', 'r');
const viaBufOpts = await new Promise((res, rej) => {
  const b = Buffer.alloc(8);
  fs.read(rofd2, b, { offset: 0, length: 3, position: 2 }, (e, n, bb) => (e ? rej(e) : res({ n, bb })));
});
assert.equal(dec.decode(viaBufOpts.bb.subarray(0, viaBufOpts.n)), 'cde');
const viaOpts = await new Promise((res, rej) => {
  fs.read(rofd2, { buffer: Buffer.alloc(8), offset: 0, length: 2, position: 0 },
    (e, n, bb) => (e ? rej(e) : res({ n, bb })));
});
assert.equal(dec.decode(viaOpts.bb.subarray(0, viaOpts.n)), 'ab');
// read(fd, buffer, offset, length, callback) — no position
const noPos = await new Promise((res, rej) => {
  fs.read(rofd2, Buffer.alloc(8), 0, 3, (e, n, bb) => (e ? rej(e) : res({ n, bb })));
});
assert.equal(noPos.n, 3);
fs.closeSync(rofd2);

// ── async write must apply the same encoding rules as writeSync ──
const aefd = fs.openSync('/home/user/asyncenc.bin', 'w');
const aeWrote = await new Promise((res, rej) =>
  fs.write(aefd, 'aGVsbG8=', 0, 'base64', (e, n) => (e ? rej(e) : res(n))));
assert.equal(aeWrote, 5, 'base64 decodes to 5 bytes, not the 8 source characters');
fs.closeSync(aefd);
assert.equal(fs.readFileSync('/home/user/asyncenc.bin', 'utf8'), 'hello');

// ── statSync must not invent a new mtime on every call ──
metadata['home/user/stable.txt'] = {
  type: 'file', size: 4, mode: 0o644, uid: 1000, gid: 1000, mtime: 1_700_000_000_000,
};
fs.writeFileSync('/home/user/stable.txt', 'abcdefg');
const s1 = fs.statSync('/home/user/stable.txt');
const s2 = fs.statSync('/home/user/stable.txt');
assert.equal(s1.size, 7, 'size reflects the write');
assert.equal(s1.mtime.getTime(), s2.mtime.getTime(), 'mtime is stable across calls');
assert.equal(s1.mtime.getTime(), 1_700_000_000_000, 'mtime comes from the metadata record');

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
// readFileSync answers the SAME condition, so it must give the same code.
// It used to report ENOENT here — one mechanism with two answers, and the
// wrong one claimed a file npm had demonstrably installed did not exist.
assert.throws(() => fs.readFileSync('/home/user/live-only.bin'), (e) => {
  assert.equal(e.code, 'EAGAIN', 'a non-resident readFileSync must match readSync');
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
