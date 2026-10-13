#!/usr/bin/env bun
/**
 * wasi-dev-fd-codec — a path naming a descriptor (/dev/fd/N) opens what that
 * descriptor holds as Linux does, through the shared WASI codec over a real
 * process's filesystem: the session's SQLite authority behind the real
 * resident store (vfs/resident/index.ts), as a JSPI guest has it.
 *
 * The file itself is opened again, with the new open's flags: its own
 * description (a fresh offset), O_TRUNC honored, and, for a copy the codec
 * answers from the store, a hold on the bytes' pin, charged to the store's
 * budget for as long as either descriptor lives. Never a name: a file
 * renamed since, at the session or in a subtree the process holds, is the
 * one opened, and the new file at its old name is left alone.
 *
 * Red before: the open dup'd (a resident copy took the original's bytes
 * with no pin, an authority file's copy shared the original's offset and
 * ignored O_TRUNC); then it reopened the old name, and truncated whatever
 * file had it now.
 */

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { residentFilesystem } from '../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { installAuthorityFilesystem, ResidentHolds } from '../../packages/core/src/runtime/wasi/filesystem.ts';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { WASI_RESIDENT_STORE_BYTES } from '../../packages/platform/src/limits.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const E = { SUCCESS: 0, ACCES: 2, NOENT: 44 };
const RIGHT_READ = 2n, RIGHT_SEEK = 4n, RIGHT_WRITE = 64n;
const O_TRUNC = 8, FDFLAG_APPEND = 1;

/**
 * A process over a session seeded with `files` (beneath /home/user), its store's charge counted; `holding`: it holds
 * /home/user from its first change; `session`: the codec is straight over the session, its copies held there, as bash's are.
 */
async function processWith(files, { holding = false, session: direct = false, keep } = {}) {
  const harness = createSqliteVfsTestHarness();
  const session = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
  const kernel = session.bind({ pid: 1, cred: CRED_KERNEL });
  for (const dir of ['/home', '/home/user']) { await kernel.mkdir(dir, { recursive: true }); await kernel.chown(dir, 1000, 1000); }
  for (const [name, text] of Object.entries(files)) { await kernel.writeFile(`/home/user/${name}`, enc.encode(text)); await kernel.chown(`/home/user/${name}`, 1000, 1000); }
  const authority = session.bind({ pid: 2, cred: USER });
  const storeSource = createResidentStore();
  storeSource.bindInMemory(WASI_RESIDENT_STORE_BYTES);
  const supervisor = {
    fsAcquire: (...args) => authority.acquire(...args),
    fsList: (...args) => authority.list(...args),
    readdir: (path) => authority.readdir(path),
    readlink: (path) => authority.readlink(path),
    stat: (path, options) => authority.stat(path, options),
    async fsReadBatch(requests) {
      const out = [];
      for (const request of requests) {
        try {
          if (request.lstat) out.push({ stat: await authority.stat(request.path, { followSymlinks: false }) });
          else out.push({ bytes: await authority.readRange(request.path, request.offset, request.length) });
        } catch (error) { out.push({ error }); }
      }
      return out;
    },
  };
  storeSource.admission.setStorage(undefined, supervisor);
  assert.equal(await storeSource.lazy.bootLazy(supervisor), true);
  const view = storeSource.lazy.namespaceView(supervisor, (await authority.stat('/')).dev, USER);
  let charged = 0;
  const counted = {
    get device() { return view.device; },
    get cred() { return view.cred; },
    ready: () => view.ready(),
    entry: (key) => view.entry(key),
    children: (key) => view.children(key),
    list: (key) => view.list(key),
    lookup: (keys, content) => view.lookup(keys, content),
    listTree: (key) => view.listTree(key),
    content: (key) => view.content(key),
    fill: (key, entry) => view.fill(key, entry),
    barrier: () => view.barrier(),
    reserve: (bytes) => { const fits = view.reserve(bytes); if (fits) charged += bytes; return fits; },
    release: (bytes) => { charged -= bytes; view.release(bytes); },
  };
  const port = {
    openWriter: async () => null,
    writeBatchStream: async (stream, _fence, owner) => authority.writeStream(stream, owner === undefined ? {} : { mutationOwner: owner }),
    grants: {
      acquire: async (path, delegate) => authority.acquireExclusiveMutation(path, { delegate }),
      release: async (owner) => { authority.releaseExclusiveMutation(owner); },
      awaitRecall: (owner, waitMs) => authority.awaitRecall(owner, waitMs),
      recalled: async (owner, kind) => { authority.recalled(owner, kind); },
    },
  };
  const fs = direct ? authority
    : holding ? residentFilesystem(authority, counted, { session: port, isHomeRoot: (key) => key === 'home/user', grantAfter: 0 })
    : residentFilesystem(authority, counted);

  const memory = new WebAssembly.Memory({ initial: 2 });
  const fds = new Map([[3, { kind: 'preopen', vfsPath: '', wasiPath: '/' }]]);
  let next = 4;
  const imports = {};
  installAuthorityFilesystem(imports, {
    fs: () => fs, memory: () => memory, fds, allocateFd: () => next++, synchronous: false,
    residentBytes: 1 << 20, duplicate: () => null, ...(direct ? { residentHolds: new ResidentHolds(keep) } : {}),
  });
  const view32 = () => new DataView(memory.buffer);
  const name = (text) => { const b = enc.encode(text); new Uint8Array(memory.buffer).set(b, 4096); return b.length; };
  return {
    fds, kernel, authority, fs, charged: () => charged,
    /** path_open of `path` beneath the root preopen: the new descriptor. */
    async open(path, { rights = RIGHT_READ | RIGHT_SEEK, oflags = 0, fdflags = 0 } = {}) {
      const errno = await imports.path_open(3, 1, 4096, name(path), oflags, rights, 0n, fdflags, 64);
      assert.equal(errno, E.SUCCESS, `path_open ${path}`);
      return view32().getUint32(64, true);
    },
    /** path_open's errno alone. */
    openErrno: async (path) => imports.path_open(3, 1, 4096, name(path), 0, RIGHT_READ | RIGHT_SEEK, 0n, 0, 64),
    async read(fd, length) {
      view32().setUint32(128, 8192, true); view32().setUint32(132, length, true);
      assert.equal(await imports.fd_read(fd, 128, 1, 136), E.SUCCESS);
      return dec.decode(new Uint8Array(memory.buffer, 8192, view32().getUint32(136, true)));
    },
    async write(fd, text) {
      const b = enc.encode(text);
      new Uint8Array(memory.buffer).set(b, 8192);
      view32().setUint32(128, 8192, true); view32().setUint32(132, b.length, true);
      assert.equal(await imports.fd_write(fd, 128, 1, 136), E.SUCCESS);
    },
    close: async (fd) => assert.equal(await imports.fd_close(fd), E.SUCCESS),
    async rename(from, to) {
      const a = enc.encode(from), b = enc.encode(to);
      new Uint8Array(memory.buffer).set(a, 4096); new Uint8Array(memory.buffer).set(b, 6144);
      assert.equal(await imports.path_rename(3, 4096, a.length, 3, 6144, b.length), E.SUCCESS, `rename ${from} ${to}`);
    },
    async unlink(path) {
      const a = enc.encode(path);
      new Uint8Array(memory.buffer).set(a, 4096);
      assert.equal(await imports.path_unlink_file(3, 4096, a.length), E.SUCCESS, `unlink ${path}`);
    },
    settle: () => (direct ? undefined : fs.settle()),
  };
}

/** What `call` answers: its value, or the code it was refused with. */
const outcome = async (call) => { try { return { value: await call() }; } catch (error) { return { code: error.code }; } };

const failures = [];
const check = async (what, run) => { try { await run(); console.log(`  ✓ ${what}`); } catch (error) { failures.push(`${what}: ${error.message}`); console.log(`  ✗ ${what}`); } };

await check('a resident copy opened through /dev/fd holds its own pin', async () => {
  const text = 'resident bytes';
  const p = await processWith({ 'r.txt': text });
  const original = await p.open('home/user/r.txt');
  assert.equal(p.fds.get(original).kind, 'resident', 'a small read-only open is answered from the store');
  assert.equal(await p.read(original, 4), 'resi');
  const copy = await p.open(`dev/fd/${original}`);
  assert.equal(p.fds.get(copy).kind, 'resident');
  assert.equal(p.charged(), text.length, 'one pin on the bytes, charged once');
  await p.close(original);
  assert.equal(p.charged(), text.length, 'the copy still holds the bytes, and they stay charged');
  assert.equal(await p.read(copy, 64), text, 'the copy reads from its own start');
  await p.close(copy);
  assert.equal(p.charged(), 0, 'the last descriptor gives the charge back');
});

await check('an authority file opened through /dev/fd with O_TRUNC is truncated, its offset its own', async () => {
  const p = await processWith({ 'w.txt': 'abc' });
  const original = await p.open('home/user/w.txt', { rights: RIGHT_READ | RIGHT_WRITE | RIGHT_SEEK, fdflags: FDFLAG_APPEND });
  assert.equal(p.fds.get(original).kind, 'authority');
  const copy = await p.open(`dev/fd/${original}`, { rights: RIGHT_WRITE | RIGHT_SEEK, oflags: O_TRUNC });
  await p.write(copy, 'x');
  await p.close(copy);
  await p.write(original, 'y');
  await p.close(original);
  await p.settle();
  assert.equal(dec.decode(await p.authority.readFile('/home/user/w.txt')), 'xy', 'truncated by the second open; the first appends after it');
});

await check('a renamed file opened through /dev/fd is that file, not the new one at its old name', async () => {
  const p = await processWith({ 'a.txt': 'old' });
  const original = await p.open('home/user/a.txt', { rights: RIGHT_READ | RIGHT_WRITE | RIGHT_SEEK });
  await p.rename('home/user/a.txt', 'home/user/b.txt');
  const replacement = await p.open('home/user/a.txt', { rights: RIGHT_WRITE | RIGHT_SEEK, oflags: 1 | O_TRUNC });
  await p.write(replacement, 'new');
  await p.close(replacement);
  const copy = await p.open(`dev/fd/${original}`, { rights: RIGHT_WRITE | RIGHT_SEEK, oflags: O_TRUNC });
  await p.write(copy, 'changed');
  await p.close(copy);
  await p.close(original);
  await p.settle();
  assert.equal(dec.decode(await p.authority.readFile('/home/user/a.txt')), 'new');
  assert.equal(dec.decode(await p.authority.readFile('/home/user/b.txt')), 'changed');
});

await check('a file a held subtree decided, renamed there, is the one /dev/fd opens', async () => {
  const p = await processWith({}, { holding: true });
  const original = await p.open('home/user/h.txt', { rights: RIGHT_READ | RIGHT_WRITE | RIGHT_SEEK, oflags: 1 | O_TRUNC });
  await p.write(original, 'held');
  await p.rename('home/user/h.txt', 'home/user/i.txt');
  const copy = await p.open(`dev/fd/${original}`, { rights: RIGHT_READ | RIGHT_WRITE | RIGHT_SEEK, oflags: O_TRUNC });
  await p.write(copy, 'x');
  await p.close(copy);
  assert.equal(await p.read(original, 64), '', 'the original reads on from its own offset, past the cut');
  await p.close(original);
  await p.settle();
  assert.equal(dec.decode(await p.authority.readFile('/home/user/i.txt')), 'x');
  assert.equal(await p.authority.stat('/home/user/h.txt'), null);
});

await check('a file the process cannot open by name is not opened by its inode number', async () => {
  const p = await processWith({});
  await p.kernel.mkdir('/srv/private', { recursive: true });
  await p.kernel.chown('/srv/private', 2000, 2000);
  await p.kernel.chmod('/srv/private', 0o700);
  await p.kernel.writeFile('/srv/private/f', enc.encode('protected'));
  await p.kernel.chmod('/srv/private/f', 0o644);
  const { dev, ino } = await p.kernel.stat('/srv/private/f');
  assert.equal((await outcome(() => p.authority.open('/srv/private/f', { read: true }))).code, 'EACCES', 'not by its name');
  const read = await outcome(async () => dec.decode(await p.authority.read((await p.authority.reopen({ dev, ino }, { read: true })).id, 0, 64)));
  assert.deepEqual(read, { code: 'EBADF' }, 'a number is not a descriptor the process holds');
});

await check('a resident copy opened again through /dev/fd reads its file as it is now', async () => {
  const p = await processWith({ 'n.txt': 'old' });
  const original = await p.open('home/user/n.txt');
  assert.equal(p.fds.get(original).kind, 'resident');
  const writer = await p.open('home/user/n.txt', { rights: RIGHT_WRITE | RIGHT_SEEK, oflags: O_TRUNC });
  await p.write(writer, 'new');
  await p.close(writer);
  const copy = await p.open(`dev/fd/${original}`);
  assert.equal(await p.read(copy, 64), 'new');
});

await check('a resident copy is not opened again once its mode refuses the read', async () => {
  const p = await processWith({ 'm.txt': 'x' });
  const original = await p.open('home/user/m.txt');
  await p.fs.chmod('/home/user/m.txt', 0);
  assert.equal(await p.openErrno(`dev/fd/${original}`), E.ACCES);
});

await check('a copy\'s hold is kept for the next copy at its name, and closed with an open once another takes its place', async () => {
  const p = await processWith({ 'c.txt': 'copy', 'd.txt': 'next', 'e.txt': 'third' }, { session: true, keep: 1 });
  const first = await p.open('home/user/c.txt');
  const entry = p.fds.get(first);
  assert.equal(entry.kind, 'resident', 'a small read-only open is a copy');
  const held = entry.hold.handle;
  assert.equal((await p.authority.fstat(held)).ino, entry.stat.ino, 'the session holds the copy\'s file');
  await p.close(first);
  const again = await p.open('home/user/c.txt');
  assert.equal(p.fds.get(again).hold.handle, held, 'the next copy at the name takes the hold again');
  assert.equal(await p.read(again, 64), 'copy');
  await p.close(again);
  await p.close(await p.open('home/user/d.txt'));
  assert.equal((await p.authority.fstat(held)).ino, entry.stat.ino, 'kept past its place, it is closed by the next open, not a call of its own');
  await p.open('home/user/e.txt');
  assert.equal((await outcome(() => p.authority.fstat(held))).code, 'EBADF', 'which closed it');
});

await check('a hold kept at a name is not the copy of another file the name has since', async () => {
  const p = await processWith({ 'r.txt': 'before', 'new.txt': 'after' }, { session: true });
  const first = await p.open('home/user/r.txt');
  const before = p.fds.get(first);
  await p.close(first);
  await p.rename('home/user/new.txt', 'home/user/r.txt');
  const again = await p.open('home/user/r.txt');
  assert.notEqual(p.fds.get(again).stat.ino, before.stat.ino, 'the name\'s file now');
  assert.notEqual(p.fds.get(again).hold.handle, before.hold.handle, 'held anew');
  assert.equal(await p.read(again, 64), 'after');
  assert.equal((await p.authority.fstat(p.fds.get(again).hold.handle)).ino, p.fds.get(again).stat.ino);
});

await check('a /dev/fd reopen closes the holds let go before it', async () => {
  const p = await processWith({ 'q.txt': 'q' }, { session: true });
  const fd = await p.open('home/user/q.txt');
  const first = await p.open(`dev/fd/${fd}`);
  const firstHold = p.fds.get(first).hold.handle;
  await p.close(first);
  const second = await p.open(`dev/fd/${fd}`);
  assert.equal((await outcome(() => p.authority.fstat(firstHold))).code, 'EBADF', 'the next reopen closed it');
  await p.close(second);
});

await check('holds let go with no open after them are closed past a bound, not kept to the end', async () => {
  const p = await processWith({ 'b.txt': 'b' }, { session: true });
  const fd = await p.open('home/user/b.txt');
  const copies = [];
  for (let i = 0; i < 80; i++) copies.push(await p.open(`dev/fd/${fd}`));
  const firstHold = p.fds.get(copies[0]).hold.handle;
  for (const copy of copies) await p.close(copy);
  assert.equal((await outcome(() => p.authority.fstat(firstHold))).code, 'EBADF', 'closed, though no open came after');
});

await check('a kept hold whose name fails its stat is not lost', async () => {
  const p = await processWith({ 'k.txt': 'k', 'other.txt': 'o' }, { session: true, keep: 1 });
  const fd = await p.open('home/user/k.txt');
  const held = p.fds.get(fd).hold.handle;
  await p.close(fd);
  await p.kernel.chmod('/home/user', 0);
  assert.equal(await p.openErrno('home/user/k.txt'), E.ACCES, 'its name cannot be walked');
  await p.kernel.chmod('/home/user', 0o755);
  await p.close(await p.open('home/user/other.txt'));
  await p.open('home/user/other.txt');
  assert.equal((await outcome(() => p.authority.fstat(held))).code, 'EBADF', 'the hold the failed open took is closed');
});

await check('a pinned copy this process unlinked is reopened for writing through /dev/fd, as the file it was', async () => {
  const p = await processWith({ 'w.txt': 'old' });
  const fd = await p.open('home/user/w.txt');
  assert.equal(p.fds.get(fd).kind, 'resident', 'a pinned copy');
  await p.unlink('home/user/w.txt');
  const writer = await p.open(`dev/fd/${fd}`, { rights: RIGHT_WRITE | RIGHT_SEEK, oflags: O_TRUNC });
  await p.write(writer, 'changed');
  await p.close(writer);
  const again = await p.open(`dev/fd/${fd}`);
  assert.equal(await p.read(again, 64), 'changed', 'the unlinked file, written');
  assert.equal(await p.openErrno('home/user/w.txt'), E.NOENT, 'its name stays gone');
});

await check('a pinned copy whose name this process replaced is reopened as itself, not as the file now there', async () => {
  const p = await processWith({ 'r.txt': 'before', 'new.txt': 'after' });
  const fd = await p.open('home/user/r.txt');
  assert.equal(p.fds.get(fd).kind, 'resident', 'a pinned copy');
  await p.rename('home/user/new.txt', 'home/user/r.txt');
  const again = await p.open(`dev/fd/${fd}`);
  assert.equal(await p.read(again, 64), 'before');
  const writer = await p.open(`dev/fd/${fd}`, { rights: RIGHT_WRITE | RIGHT_SEEK, oflags: O_TRUNC });
  await p.write(writer, 'rewritten');
  await p.close(writer);
  const named = await p.open('home/user/r.txt');
  assert.equal(await p.read(named, 64), 'after', 'the name\'s file is untouched');
});

assert.deepEqual(failures, []);
console.log('wasi-dev-fd-codec: ok');
