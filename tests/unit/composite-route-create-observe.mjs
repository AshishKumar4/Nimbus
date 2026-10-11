#!/usr/bin/env bun
// Three things an embedder asks of the session's namespace (CompositeVFS),
// each one lookup the namespace owns rather than one the embedder re-derives:
//
//   - route / mutationRoute { creating } (Kinu's ask 32): where a write that
//     makes its parents lands, links followed through the view's mounts, a
//     link to where nothing is yet included. Red before: ENOENT for any
//     missing directory on the way.
//   - writeFileIfRevision(path, data, 0) on a missing file (Kinu's ask 36):
//     create-if-absent, which reaches the backend, the only place it can be
//     atomic. Red before: ENOENT from the namespace's lookup.
//   - observeWrites wants per side (Kinu's ask 34): an observer that wants
//     only after-images costs no before read, and a writeFile's after-image
//     is the bytes it was given. Red before: three writes cost six reads.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

/** The session's namespace: SQLite at the root, a device that resolves its own paths at /pc, a read-only mount. */
function namespace() {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/main', { recursive: true });
  kernel.chown('home/main', 1000, 1000);
  kernel.mkdir('work', { recursive: true });
  kernel.writeFile('home/main/file', 'a file');
  const vfs = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL));
  const pc = new MemoryVFS({ uid: 1000, gid: 1000 });
  pc.mkdir('/laptop');
  vfs.mount('/pc', pc, { resolvesPaths: true });
  vfs.mount('/ro', new MemoryVFS(), { readOnly: true });
  return { engine, kernel, vfs, pc };
}

const routed = (route) => ({ point: route.point, path: route.path });

// ── route / mutationRoute { creating } ──────────────────────────────────────
{
  const { vfs, kernel } = namespace();
  kernel.symlink('/pc/laptop', 'home/main/pc-link');
  kernel.symlink('/outside/missing/deeper', 'work/link');
  assert.deepEqual(routed(await vfs.route('/home/main/pc-link/missing/new.txt', { follow: true, creating: true })),
    { point: '/pc', path: '/laptop/missing/new.txt' }, 'through a root link into a device, its missing directories included');
  assert.deepEqual(routed(await vfs.route('/home/main/missing/deeper/x', { creating: true })),
    { point: '/', path: '/home/main/missing/deeper/x' }, 'missing directories on the root');
  assert.deepEqual(routed(await vfs.route('/work/link/file', { follow: true, creating: true })),
    { point: '/', path: '/outside/missing/deeper/file' }, 'a link to where nothing is yet leads there');
  assert.deepEqual(await vfs.mutationRoute('/work/link/file', { follow: true, creating: true }),
    { path: '/outside/missing/deeper/file', point: '/', readOnly: false }, 'and so does a mutation\'s route');
  await assert.rejects(vfs.route('/home/main/file/x/y', { creating: true }), (error) => error.code === 'ENOTDIR', 'a file among them is still ENOTDIR');
  await assert.rejects(vfs.route('/home/main/missing/deeper/x'), (error) => error.code === 'ENOENT', 'without creating, ENOENT as before');
  console.log('  route { creating } is the lookup a write that makes its parents makes');
}

// ── writeFileIfRevision(path, data, 0): create-if-absent ────────────────────
// Revision 0 means nothing is there (O_CREAT|O_EXCL), which only the backend
// can make atomic, so the namespace hands a missing file to it. Red before:
// ENOENT from the namespace's lookup, so a create was a stat then a write,
// racy across heads.
{
  const { vfs, kernel } = namespace();
  const events = [];
  const stop = vfs.observeWrites((event) => { events.push(`${event.type} ${event.path}`); });
  const asUser = vfs.as(user);
  const created = await asUser.writeFileIfRevision('/home/main/new.txt', enc.encode('made'), 0);
  assert.equal(created.ok, true, 'a missing file expecting nothing there is created');
  assert.equal(dec.decode(kernel.readFile('home/main/new.txt')), 'made');
  assert.deepEqual(events, ['create /home/main/new.txt'], 'and reported once');
  const existing = await asUser.writeFileIfRevision('/home/main/new.txt', enc.encode('clobber'), 0);
  assert.equal(existing.ok, false, 'expecting nothing on a file that is there is a revision conflict, not ENOENT');
  assert.equal(existing.revision, created.revision, 'which names its revision');
  assert.equal(dec.decode(kernel.readFile('home/main/new.txt')), 'made', 'untouched');
  assert.deepEqual(events, ['create /home/main/new.txt'], 'a lost compare reports nothing');
  // Two writers racing to create one file: exactly one wins.
  const raced = await Promise.all([
    vfs.as(user).writeFileIfRevision('/home/main/race.txt', enc.encode('first'), 0),
    vfs.as(user).writeFileIfRevision('/home/main/race.txt', enc.encode('second'), 0),
  ]);
  assert.deepEqual(raced.map((result) => result.ok).sort(), [false, true], 'exactly one of two racing creates wins');
  const winner = raced.findIndex((result) => result.ok);
  assert.equal(dec.decode(kernel.readFile('home/main/race.txt')), winner === 0 ? 'first' : 'second', 'and its bytes are what stands');
  assert.equal(raced[1 - winner].revision, raced[winner].revision, 'the other is told the winner\'s revision');
  await assert.rejects(asUser.writeFileIfRevision('/home/main/missing/new.txt', enc.encode('x'), 0), (error) => error.code === 'ENOENT', 'a missing parent');
  await assert.rejects(asUser.writeFileIfRevision('/ro/new.txt', enc.encode('x'), 0), (error) => error.code === 'EROFS', 'a read-only mount');
  await assert.rejects(asUser.writeFileIfRevision('/work/new.txt', enc.encode('x'), 0), (error) => error.code === 'EACCES', 'a directory it may not write');
  await assert.rejects(asUser.writeFileIfRevision('/home/main/other.txt', enc.encode('x'), 7), (error) => error.code === 'ENOENT', 'expecting a revision of what is not there');
  stop();
  console.log('  writeFileIfRevision(path, data, 0) is create-if-absent through the namespace');
}

// ── observeWrites: wants per side, and a writeFile's after-image ────────────
{
  /** `files` that counts its readFile calls. */
  const counted = (files) => {
    const reads = { count: 0 };
    return {
      reads,
      files: new Proxy(files, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === 'readFile') return (...args) => { reads.count++; return value.apply(target, args); };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
  };
  for (const [what, wants, expected] of [
    ['only after-images', () => ({ before: false, after: true }), { writeFile: 0, writeRange: 1 }],
    ['neither side', () => false, { writeFile: 0, writeRange: 0 }],
    ['both sides', () => true, { writeFile: 1, writeRange: 2 }],
  ]) {
    const device = counted(new MemoryVFS());
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/dev-plane', device.files);
    const afters = [];
    const stop = vfs.observeWrites((event) => { afters.push(event.after === undefined ? undefined : dec.decode(event.after.read())); }, { wants });
    await vfs.writeFile('/dev-plane/a', enc.encode('one'));
    assert.equal(device.reads.count, 0, `${what}: a new file's write reads nothing`);
    device.reads.count = 0;
    await vfs.writeFile('/dev-plane/a', enc.encode('two'));
    assert.equal(device.reads.count, expected.writeFile, `${what}: a writeFile over a file reads ${expected.writeFile}`);
    device.reads.count = 0;
    await vfs.writeRange('/dev-plane/a', 0, enc.encode('T'));
    assert.equal(device.reads.count, expected.writeRange, `${what}: a writeRange reads ${expected.writeRange}`);
    if (what !== 'neither side') assert.deepEqual(afters, ['one', 'two', 'Two'], `${what}: the after-images are what stands after`);
    else assert.deepEqual(afters, [undefined, undefined, undefined], `${what}: no content`);
    stop();
  }
  // Three writes to one path, wanting the first before and every after: one read.
  const device = counted(new MemoryVFS());
  device.files.writeFile('/a', enc.encode('zero'));
  const vfs = new CompositeVFS(new MemoryVFS());
  vfs.mount('/dev-plane', device.files);
  const seen = new Set();
  const stop = vfs.observeWrites(() => {}, {
    wants: (path) => {
      const first = seen.has(path) === false;
      seen.add(path);
      return { before: first, after: true };
    },
  });
  device.reads.count = 0;
  for (const text of ['one', 'two', 'three']) await vfs.writeFile('/dev-plane/a', enc.encode(text));
  assert.equal(device.reads.count, 1, 'three writes to one path, its first before-image read once');
  stop();
  console.log('  observeWrites reads only the sides an observer wants, and a writeFile\'s after from its bytes');
}

// ── A tree copied into itself through two mounts of one backend ────────────
// Found by the regenerated refinement fixture (case 187: copy /pc to
// /proc/new, both mounts of one backend): the copy met the directory it had
// just made inside the tree it was walking and copied it again, without end
// (RangeError: Maximum call stack size exceeded). It copies the tree as it
// was when the copy began, as the model says.
{
  const backend = new MemoryVFS();
  backend.mkdir('/b/data', { recursive: true });
  backend.writeFile('/b/data/f', enc.encode('x'));
  const vfs = new CompositeVFS(new MemoryVFS());
  vfs.mount('/pc', backend);
  vfs.mount('/proc', backend);
  assert.equal(await vfs.copy('/pc', '/proc/new', { recursive: true }), 4, 'new, new/b, new/b/data, new/b/data/f');
  assert.deepEqual(backend.readdir('/new').map((entry) => entry.name), ['b']);
  assert.equal(dec.decode(backend.readFile('/new/b/data/f')), 'x');
  console.log('  a tree copied into itself through two mounts copies the tree as it was');
}

console.log('composite-route-create-observe: ok');
