#!/usr/bin/env bun
/**
 * wasi-resident-fs-held-writes — what a WASI process holds of what it writes
 * (core runtime/wasi/resident-filesystem.ts), and the session's descriptors it
 * opens, against the session's own answers.
 *
 * A file the process creates or truncates is held until its close, fsync, a
 * path change, another writer's open, a send or the run's end. What must
 * hold:
 *   - a refusal the session makes is reported, never dropped by a flush that
 *     some other operation caused;
 *   - holding is bounded: a truncate or a write past what may be held goes to
 *     the session instead of growing the process;
 *   - a held file is known by its identity: a peer that replaces the name is
 *     read as the peer's file;
 *   - a second writer, a reader, and fsync through another descriptor all see
 *     what is held;
 *   - every descriptor is the session's, so a directory's descriptor works
 *     for the session's calls (mkdirat, futimes) and lists the directory it
 *     opened, wherever that directory is now;
 *   - a revision pinned for several descriptors is one buffer, charged once;
 *   - the barrier stays owed until one lands.
 */

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { residentFilesystem } from '../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { WASI_RESIDENT_FILE_CAP_BYTES } from '../../packages/core/src/constants.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const ROOT = 'home/user';
const beneath = (path) => ({ root: ROOT, path, beneath: true });
const k = (p) => `/${ROOT}/${p}`;

const harness = createSqliteVfsTestHarness();
const files = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
const kernel = files.bind({ pid: 1, cred: CRED_KERNEL });
const authority = files.bind({ pid: 2, cred: USER });
for (const dir of ['/home', `/${ROOT}`]) await kernel.mkdir(dir, { recursive: true });
await kernel.chown(`/${ROOT}`, 1000, 1000);
await kernel.mkdir(k('dir'));
await kernel.chown(k('dir'), 1000, 1000);
await kernel.writeFile(k('dir/inside.txt'), enc.encode('inside'));
const twoMiB = new Uint8Array(2 * 1024 * 1024 + 5).fill(7);
await kernel.writeFile(k('two.bin'), twoMiB);
await kernel.chown(k('two.bin'), 1000, 1000);

const storeSource = new Function(
  FACET_RESIDENT_STORE_SOURCE
    + '\nreturn { __residentBindInMemory, __residentSetStorage, __residentBootLazy, __residentNamespaceView };',
)();
storeSource.__residentBindInMemory(64 * 1024 * 1024);
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
storeSource.__residentSetStorage(undefined, supervisor);
assert.equal(await storeSource.__residentBootLazy(supervisor), true);
const device = (await authority.stat('/')).dev;
const view = storeSource.__residentNamespaceView(supervisor, device, USER);

/** A session that refuses every write with ENOSPC, as a full store does. */
const refusing = new Proxy(authority, {
  get(target, name) {
    if (name === 'write') return () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
    const value = Reflect.get(target, name);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const create = { read: true, write: true, create: true, truncate: true };
/** Open `name` for writing as a held file: the store knows its directory first, as it does once a process has looked around. */
const openHeld = async (fs, name) => {
  await fs.stat(beneath('two.bin'));
  const handle = await fs.open(beneath(name), create);
  assert.equal(fs.holding(), true, `${name} is held`);
  return handle;
};
let passed = 0;
let index = 0;
/** ONLY=<n> runs the n-th check alone (1-based): how each one is shown to fail on an adapter without its fix. */
const only = process.env.ONLY === undefined ? null : Number(process.env.ONLY);
const check = async (name, fn) => {
  index++;
  if (only !== null && only !== index) return;
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

await check('a refusal met by a flush another operation caused is still the close\'s error', async () => {
  const fs = residentFilesystem(refusing, view);
  const held = await openHeld(fs, 'refused-a.txt');
  await fs.write(held.id, null, enc.encode('lost'));
  // A path change flushes what is held first; the session refuses it.
  await fs.mkdir(beneath('made-by-rename-path'));
  assert.equal(fs.holding(), false);
  await assert.rejects(async () => fs.close(held.id), { code: 'ENOSPC' });
});

await check('a refusal met by a flush before a send is reported by the run\'s settle', async () => {
  const fs = residentFilesystem(refusing, view);
  const held = await openHeld(fs, 'refused-b.txt');
  await fs.write(held.id, null, enc.encode('lost'));
  await fs.flush();
  const failures = await fs.settle();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].path, `${ROOT}/refused-b.txt`);
  assert.equal(failures[0].error.code, 'ENOSPC');
  await fs.close(held.id);
});

await check('a truncate or a write past what may be held goes to the session', async () => {
  const fs = residentFilesystem(authority, view);
  const held = await openHeld(fs, 'huge.bin');
  await fs.write(held.id, null, enc.encode('head'));
  await fs.ftruncate(held.id, WASI_RESIDENT_FILE_CAP_BYTES * 16);
  assert.equal(fs.holding(), false, 'the truncate was not held');
  assert.equal((await authority.stat(beneath('huge.bin'))).size, WASI_RESIDENT_FILE_CAP_BYTES * 16);
  await fs.close(held.id);
  const sparse = await openHeld(fs, 'sparse.bin');
  await fs.write(sparse.id, WASI_RESIDENT_FILE_CAP_BYTES * 4, enc.encode('x'));
  assert.equal(fs.holding(), false, 'the sparse write was not held');
  await fs.close(sparse.id);
  assert.equal((await authority.stat(beneath('sparse.bin'))).size, WASI_RESIDENT_FILE_CAP_BYTES * 4 + 1);
});

await check('a held file is known by its identity: a peer that replaces the name is read as the peer\'s', async () => {
  const fs = residentFilesystem(authority, view);
  const held = await openHeld(fs, 'x.txt');
  await fs.write(held.id, null, enc.encode('mine'));
  await kernel.writeFile(k('x.new'), enc.encode('theirs'));
  await kernel.chown(k('x.new'), 1000, 1000);
  await kernel.rename(k('x.new'), k('x.txt'));
  fs.inbound();
  assert.equal(dec.decode(await fs.readFile(beneath('x.txt'))), 'theirs');
  await fs.close(held.id);
  assert.equal(dec.decode(await authority.readFile(beneath('x.txt'))), 'theirs', 'the unlinked file took the held bytes');
});

await check('unlinking a held file while it is open: the name is gone and the close still succeeds', async () => {
  const fs = residentFilesystem(authority, view);
  const held = await openHeld(fs, 'gone.txt');
  await fs.write(held.id, null, enc.encode('orphan'));
  await fs.unlink(beneath('gone.txt'));
  assert.equal(await fs.readFile(beneath('gone.txt')), null);
  await fs.close(held.id);
  assert.equal(await authority.stat(beneath('gone.txt')), null);
});

await check('a second writer reads what is held, and a second O_TRUNC empties it for good', async () => {
  const fs = residentFilesystem(authority, view);
  const first = await openHeld(fs, 'shared.txt');
  await fs.write(first.id, null, enc.encode('old'));
  const second = await fs.open(beneath('shared.txt'), { read: true, write: true });
  assert.equal(dec.decode(await fs.read(second.id, 0, 10)), 'old', 'an r+ open sees the held bytes');
  await fs.close(second.id);
  const third = await fs.open(beneath('shared.txt'), create);
  await fs.write(third.id, null, enc.encode('new'));
  await fs.close(third.id);
  await fs.close(first.id);
  assert.equal(dec.decode(await authority.readFile(beneath('shared.txt'))), 'new', 'the first close restores nothing');
});

await check('fsync through another descriptor of a held file puts it in the session', async () => {
  const fs = residentFilesystem(authority, view);
  const held = await openHeld(fs, 'synced.txt');
  await fs.write(held.id, null, enc.encode('synced'));
  const st = await fs.fstat(held.id);
  await fs.syncInode(st.dev, st.ino);
  assert.equal(dec.decode(await authority.readFile(beneath('synced.txt'))), 'synced');
  await fs.close(held.id);
});

await check('a directory\'s descriptor is the session\'s: mkdirat, futimes, and the listing follow the directory', async () => {
  const fs = residentFilesystem(authority, view);
  const dir = await fs.open(beneath('dir'), { read: true, directory: true });
  assert.equal((await fs.fstat(dir.id)).type, 'directory');
  await fs.mkdir({ directory: dir.id, path: 'made', beneath: true });
  assert.equal((await authority.stat(beneath('dir/made'))).type, 'directory');
  await fs.futimes(dir.id, 1000, 2000);
  assert.equal((await authority.stat(beneath('dir'))).mtime, 2000);
  await kernel.rename(k('dir'), k('moved'));
  await kernel.mkdir(k('dir'));
  fs.inbound();
  const names = (await fs.readdirHandle(dir.id)).map((e) => e.name).sort();
  assert.deepEqual(names, ['inside.txt', 'made'], 'the descriptor lists the directory it opened');
  await kernel.writeFile(k('moved/later.txt'), enc.encode('later'));
  fs.inbound();
  assert.deepEqual((await fs.readdirHandle(dir.id)).map((e) => e.name).sort(), ['inside.txt', 'later.txt', 'made'], 'a peer\'s change is in the next listing');
  await fs.close(dir.id);
});

await check('a revision pinned for two descriptors is one buffer, charged once and given back once', async () => {
  const fs = residentFilesystem(authority, view);
  const st = await fs.stat(beneath('two.bin'));
  const one = await fs.pinContent(beneath('two.bin'), st);
  const two = await fs.pinContent(beneath('two.bin'), st);
  assert.equal(one.bytes.byteLength, twoMiB.byteLength);
  assert.equal(one.bytes, two.bytes, 'the same buffer');
  assert.equal(fs.stats().pinnedBytes, twoMiB.byteLength);
  one.release();
  one.release();
  assert.equal(fs.stats().pinnedBytes, twoMiB.byteLength, 'held while a descriptor holds it, a second release of one changes nothing');
  two.release();
  assert.equal(fs.stats().pinnedBytes, 0);
});

await check('the barrier stays owed until one lands', async () => {
  let failNext = false;
  const flaky = { ...view, ready: () => view.ready(), entry: (key) => view.entry(key), children: (key) => view.children(key), barrier: () => (failNext ? (failNext = false, Promise.resolve(false)) : view.barrier()) };
  Object.defineProperty(flaky, 'device', { get: () => view.device });
  const fs = residentFilesystem(authority, flaky);
  await kernel.writeFile(k('fresh.txt'), enc.encode('one'));
  await kernel.chown(k('fresh.txt'), 1000, 1000);
  fs.inbound();
  assert.equal(dec.decode(await fs.readFile(beneath('fresh.txt'))), 'one');
  await kernel.writeFile(k('fresh.txt'), enc.encode('two'));
  fs.inbound();
  failNext = true;
  await fs.stat(beneath('fresh.txt'));
  assert.equal(dec.decode(await fs.readFile(beneath('fresh.txt'))), 'two', 'the next answer took the barrier the failed one could not');
});

console.log(`wasi-resident-fs-held-writes: ${passed} checks passed`);
