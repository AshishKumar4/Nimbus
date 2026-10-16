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
import { installAuthorityFilesystem } from '../../packages/core/src/runtime/wasi/filesystem.ts';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { WASI_RESIDENT_STORE_BYTES } from '../../packages/platform/src/limits.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const E = { SUCCESS: 0, ACCES: 2, NOENT: 44, PERM: 63 };
const ATIM = 1, ATIM_NOW = 2, MTIM = 4, MTIM_NOW = 8;
const RIGHT_READ = 2n, RIGHT_SEEK = 4n, RIGHT_WRITE = 64n, RIGHT_SET_TIMES = 1n << 23n;
const O_TRUNC = 8, FDFLAG_APPEND = 1;

/**
 * A process over a session seeded with `files` (beneath /home/user), its store's charge counted; `holding`: it holds
 * /home/user from its first change; `session`: the codec is straight over the session, as bash's is.
 */
async function processWith(files, { holding = false, session: direct = false } = {}) {
  const harness = createSqliteVfsTestHarness();
  const session = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
  const kernel = session.bind({ pid: 1, cred: CRED_KERNEL });
  for (const dir of ['/home', '/home/user']) { await kernel.mkdir(dir, { recursive: true }); await kernel.chown(dir, 1000, 1000); }
  for (const [name, text] of Object.entries(files)) {
    const parent = name.includes('/') ? `/home/user/${name.slice(0, name.lastIndexOf('/'))}` : null;
    if (parent !== null) { await kernel.mkdir(parent, { recursive: true }); await kernel.chown(parent, 1000, 1000); }
    await kernel.writeFile(`/home/user/${name}`, enc.encode(text)); await kernel.chown(`/home/user/${name}`, 1000, 1000);
  }
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
    residentBytes: 1 << 20, duplicate: () => null,
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
    /** fd_filestat_set_times' errno: `flags` its ATIM/MTIM bits, the times in ns. */
    setTimes: (fd, atimNs, mtimNs, flags) => imports.fd_filestat_set_times(fd, atimNs, mtimNs, flags),
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

/** The session descriptors process `p` holds, found as fstat finds them. */
async function sessionDescriptors(p) {
  const live = [];
  for (let id = 0; id < 128; id++) if ((await outcome(() => p.authority.fstat(id))).value !== undefined) live.push(id);
  return live;
}

await check('a refused open of a file too large for a copy leaves no descriptor at the session', async () => {
  const p = await processWith({ 'big.bin': 'x'.repeat(2 << 20) }, { session: true });
  await p.kernel.chmod('/home/user/big.bin', 0);
  for (let i = 0; i < 3; i++) assert.equal(await p.openErrno('home/user/big.bin'), E.ACCES);
  assert.deepEqual(await sessionDescriptors(p), []);
});

await check('a copy holds nothing at the session until its process takes the name away; then its last descriptor lets the hold go', async () => {
  const p = await processWith({ 'u.txt': 'old' }, { session: true });
  const fd = await p.open('home/user/u.txt');
  assert.equal(p.fds.get(fd).kind, 'resident', 'a small read-only open is a copy');
  assert.deepEqual(await sessionDescriptors(p), [], 'a copy alone holds no descriptor');
  await p.unlink('home/user/u.txt');
  assert.equal((await sessionDescriptors(p)).length, 1, 'the unlink held the file first');
  const writer = await p.open(`dev/fd/${fd}`, { rights: RIGHT_WRITE | RIGHT_SEEK, oflags: O_TRUNC });
  await p.write(writer, 'changed');
  await p.close(writer);
  const again = await p.open(`dev/fd/${fd}`);
  assert.equal(await p.read(again, 64), 'changed', 'the unlinked file, written');
  await p.close(again);
  await p.close(fd);
  assert.deepEqual(await sessionDescriptors(p), [], 'its last descriptor let the hold go');
});

await check('a copy whose name its process renamed another file over reopens itself through the hold', async () => {
  const p = await processWith({ 'r.txt': 'before', 'new.txt': 'after' }, { session: true });
  const fd = await p.open('home/user/r.txt');
  await p.rename('home/user/new.txt', 'home/user/r.txt');
  const again = await p.open(`dev/fd/${fd}`);
  assert.equal(await p.read(again, 64), 'before');
  const named = await p.open('home/user/r.txt');
  assert.equal(await p.read(named, 64), 'after', 'the name\'s file is the new one');
});

await check('a copy under a directory its process renamed reopens itself through the hold', async () => {
  const p = await processWith({ 'd/f.txt': 'inside' }, { session: true });
  const fd = await p.open('home/user/d/f.txt');
  await p.rename('home/user/d', 'home/user/e');
  const again = await p.open(`dev/fd/${fd}`);
  assert.equal(await p.read(again, 64), 'inside');
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

// ── futimes through the codec keeps each time's intent: now (a writer may),
// explicit (the owner), or omitted (kept) ───────────────────────────────
// Red before: the codec turned now into Date.now() before the judgment, and
// a writer who is not the owner was refused (EPERM) what utimes allows.
for (const holding of [false, true]) {
  await check(`futimes by a writer who is not the owner: now is theirs, explicit times are not, an omitted one is kept${holding ? ' (held)' : ''}`, async () => {
    const p = await processWith({ 'shared.txt': 's' }, { holding });
    await p.kernel.chown('/home/user/shared.txt', 0, 0);
    await p.kernel.chmod('/home/user/shared.txt', 0o666);
    await p.kernel.utimes('/home/user/shared.txt', 1_000, 2_000);
    const fd = await p.open('home/user/shared.txt', { rights: RIGHT_READ | RIGHT_WRITE | RIGHT_SEEK | RIGHT_SET_TIMES });
    assert.equal(await p.setTimes(fd, 5_000_000_000n, 6_000_000_000n, ATIM | MTIM), E.PERM, 'explicit times by a writer who is not the owner');
    const before = Date.now();
    assert.equal(await p.setTimes(fd, 0n, 0n, ATIM_NOW | MTIM_NOW), E.SUCCESS, 'both now, by a writer');
    const now = await p.kernel.stat('/home/user/shared.txt');
    assert.ok(now.mtime >= before - 1_000 && now.atime >= before - 1_000, `the times are now: ${now.atime} ${now.mtime}`);
    assert.equal(await p.setTimes(fd, 0n, 0n, MTIM_NOW), E.SUCCESS, 'mtime now, atime kept');
    assert.equal((await p.kernel.stat('/home/user/shared.txt')).atime, now.atime, 'an omitted atime is kept');
    await p.close(fd);
  });
}

assert.deepEqual(failures, []);
console.log('wasi-dev-fd-codec: ok');
