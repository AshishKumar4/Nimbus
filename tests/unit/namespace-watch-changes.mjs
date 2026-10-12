#!/usr/bin/env bun
// One change authority (VFS-2b): the namespace tells each change it shows,
// on SQLite and on any mount, without reading, holding or serializing
// anything (CompositeVFS.watchChanges), and the session's file tree, the
// real Vite facet's chokidar and a process's fs.watch hear it there.
//
//   - SQLite's own changes, whoever made them, under the namespace's paths;
//     one a mount covers is not told;
//   - a change on a mount whose backend tells none is told as it lands
//     through the namespace, typed by what the operation is, and a made file
//     is told as made where the namespace knows it (O_CREAT on nothing, a
//     copy onto nothing, a compare-and-write onto nothing);
//   - a watch is of its tree only; a mount made or gone later is followed;
//     a stopped watch hears nothing;
//   - a process's watch (RuntimeFsBridge.subscribe) of the root hears its
//     namespace, as SQLite names it.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { asyncOnly } from './lib/async-memory-vfs.mjs';

const enc = new TextEncoder();
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const kernel = raw.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true });
kernel.chown('home/user', 1000, 1000);
const files = new ProcessFiles(raw);
const ns = files.vfs;
const failures = [];
const check = async (name, run) => {
  try { await run(); } catch (error) { failures.push(`${name}: ${String(error?.message ?? error).split('\n').slice(0, 6).join(' | ')}`); }
};
/** The kernel hears SQLite's changes as the engine batches them: once its batch is out. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const said = (event) => (event.oldPath === undefined ? `${event.type} ${event.path}` : `${event.type} ${event.oldPath} -> ${event.path}`);
const watching = (path, view = ns) => {
  const heard = [];
  const stop = view.watchChanges(path, (events) => heard.push(...events.map(said)));
  return { heard, stop, take: () => heard.splice(0) };
};

await check('SQLite\'s changes are told under the namespace\'s paths, whoever made them', async () => {
  const w = watching('/home/user');
  kernel.writeFile('home/user/a.txt', 'a');
  kernel.writeFile('home/user/a.txt', 'b');
  await ns.mkdir('/home/user/d');
  await ns.rename('/home/user/a.txt', '/home/user/d/a.txt');
  kernel.unlink('home/user/d/a.txt');
  await settled();
  assert.deepEqual(w.take(), ['add /home/user/a.txt', 'change /home/user/a.txt', 'addDir /home/user/d', 'rename /home/user/a.txt -> /home/user/d/a.txt', 'unlink /home/user/d/a.txt']);
  w.stop();
  kernel.writeFile('home/user/after.txt', 'x');
  await settled();
  assert.deepEqual(w.take(), [], 'a stopped watch hears nothing');
});

const memory = new MemoryVFS({ uid: 1000, gid: 1000 });
ns.mount('/home/user/m', memory);

await check('a mount that tells nothing itself: its changes through the namespace, as the operation is', async () => {
  const w = watching('/home/user');
  await ns.writeFile('/home/user/m/x', enc.encode('x'));
  await ns.mkdir('/home/user/m/d');
  await ns.symlink('x', '/home/user/m/l');
  await ns.rename('/home/user/m/x', '/home/user/m/y');
  await ns.copy('/home/user/m/y', '/home/user/m/z');
  await ns.copy('/home/user/m/y', '/home/user/m/z');
  await ns.unlink('/home/user/m/l');
  await ns.rmdir('/home/user/m/d');
  assert.deepEqual(w.take(), [
    'change /home/user/m/x', 'addDir /home/user/m/d', 'add /home/user/m/l', 'rename /home/user/m/x -> /home/user/m/y',
    'add /home/user/m/z', 'change /home/user/m/z', 'unlink /home/user/m/l', 'unlinkDir /home/user/m/d',
  ]);
  w.stop();
});

await check('a file O_CREAT makes on such a mount is told as made, and its writes as changes', async () => {
  const w = watching('/home/user/m');
  const proc = files.bind({ pid: 4101, cred: USER });
  const fd = await proc.open('/home/user/m/made', { write: true, create: true, exclusive: true });
  await proc.write(fd.id, 0, enc.encode('made'));
  await proc.close(fd.id);
  assert.deepEqual(w.take(), ['add /home/user/m/made', 'change /home/user/m/made']);
  w.stop();
});

await check('a write SQLite takes under a mount point is not told: the namespace shows the mount there', async () => {
  const w = watching('/home/user');
  kernel.mkdir('home/user/m', { recursive: true });
  kernel.writeFile('home/user/m/hidden', 'h');
  await settled();
  assert.deepEqual(w.take(), []);
  w.stop();
});

await check('a watch is of its tree only', async () => {
  const w = watching('/home/user/m');
  kernel.writeFile('home/user/elsewhere', 'e');
  await ns.writeFile('/home/user/m/inside', enc.encode('i'));
  await settled();
  assert.deepEqual(w.take(), ['change /home/user/m/inside']);
  w.stop();
});

await check('a mount made after the watch began is followed, and one gone is not', async () => {
  const w = watching('/home/user');
  const late = new MemoryVFS({ uid: 1000, gid: 1000 });
  ns.mount('/home/user/late', late);
  await ns.writeFile('/home/user/late/f', enc.encode('f'));
  ns.unmount('/home/user/late');
  late.writeFile('/g', enc.encode('g'));
  assert.deepEqual(w.take(), ['change /home/user/late/f']);
  w.stop();
});

await check('a mount whose backend tells its own changes is heard from it, once', async () => {
  const other = createSqliteVfsTestHarness();
  const data = new SqliteVFS(other.sql, other.ctx);
  ns.mount('/data', sqliteFiles(data, CRED_KERNEL));
  const w = watching('/');
  data.as(CRED_KERNEL).writeFile('made-there', 'x');
  await ns.writeFile('/data/made-here', enc.encode('y'));
  await settled();
  assert.deepEqual(w.take().filter((line) => line.includes('/data')), ['add /data/made-there', 'add /data/made-here']);
  w.stop();
  ns.unmount('/data');
});

await check('a removed tree is heard entry by entry, as SQLite tells it', async () => {
  kernel.mkdir('home/user/t/u', { recursive: true });
  kernel.writeFile('home/user/t/u/f', 'f');
  const w = watching('/home/user/t');
  await ns.removeRecursive('/home/user/t');
  await settled();
  assert.deepEqual(w.take().sort(), ['unlink /home/user/t/u/f', 'unlinkDir /home/user/t', 'unlinkDir /home/user/t/u'].sort());
  w.stop();
});

await check('a process\'s watch of the root hears its namespace, as SQLite names it', async () => {
  const proc = files.bind({ pid: 4102, cred: USER });
  const heard = [];
  const stop = proc.subscribe('/', (event) => heard.push(said(event)));
  kernel.writeFile('home/user/root-watched', 'r');
  await ns.writeFile('/home/user/m/mounted-watched', enc.encode('m'));
  stop();
  kernel.writeFile('home/user/after-stop', 's');
  assert.deepEqual(heard, ['add home/user/root-watched', 'change home/user/m/mounted-watched']);
});

// ── Who may see a change: the one rule (projectChange), judged by the watching view ──
const PUBLIC = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const OTHER = Object.freeze({ uid: 2000, gid: 2000, groups: Object.freeze([2000]), umask: 0o022 });
/** A gate a backend call waits at, and the moment it is entered. */
const gated = () => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const entering = new Promise((resolve) => { entered = resolve; });
  return { gate, entering, release: () => release(), enter: () => entered() };
};

await check('a change under a directory the watcher may not search is not told to it, whichever mount it is on', async () => {
  kernel.mkdir('secret', { recursive: true });
  kernel.chmod('secret', 0o700);
  const other = createSqliteVfsTestHarness();
  const inner = new SqliteVFS(other.sql, other.ctx);
  ns.mount('/secret/m', sqliteFiles(inner, CRED_KERNEL));
  const user = watching('/', ns.as(PUBLIC));
  const userSecret = watching('/secret', ns.as(PUBLIC));
  const root = watching('/secret');
  inner.as(CRED_KERNEL).writeFile('confidential-filename', 'x');
  kernel.writeFile('secret/also', 'y');
  await settled();
  assert.deepEqual([...user.take(), ...userSecret.take()].filter((line) => line.includes('secret')), []);
  assert.deepEqual(root.take().sort(), ['add /secret/also', 'add /secret/m/confidential-filename']);
  for (const w of [user, userSecret, root]) w.stop();
  ns.unmount('/secret/m');
});

await check('a mount whose source gives the watcher nothing, or another store, tells it nothing of another\'s writes', async () => {
  const storeA = new MemoryVFS({ uid: 0, gid: 0 });
  const storeB = new MemoryVFS({ uid: 0, gid: 0 });
  ns.mount('/device', (principal) => (principal.cred?.uid === 1000 ? null : storeA));
  ns.mount('/pc', (principal) => (principal.cred?.uid === 2000 ? storeB : storeA));
  ns.mount('/actors', (principal) => (principal.actor === 'b' ? storeB : storeA));
  const none = watching('/device', ns.as(PUBLIC));
  const b = watching('/pc', ns.as(OTHER));
  const sameUid = watching('/actors', ns.as(PUBLIC, 'b'));
  const a = watching('/pc', ns.as(PUBLIC));
  await ns.writeFile('/device/token', enc.encode('t'));
  await ns.as(PUBLIC).writeFile('/pc/only-a', enc.encode('a'));
  await ns.as(PUBLIC, 'a').writeFile('/actors/only-a', enc.encode('a'));
  await settled();
  assert.deepEqual(none.take(), [], 'no source for the watcher');
  assert.deepEqual(b.take(), [], 'another store for the watcher');
  assert.deepEqual(sameUid.take(), [], 'another store for another actor of the same uid');
  assert.deepEqual(a.take(), ['change /pc/only-a'], 'its own store');
  for (const w of [none, b, sameUid, a]) w.stop();
  for (const point of ['/device', '/pc', '/actors']) ns.unmount(point);
});

await check('a write that lands after its mount is gone is not told', async () => {
  const g = gated();
  const backend = new MemoryVFS({ uid: 0, gid: 0 });
  ns.mount('/gone', asyncOnly(backend, { beforeCall: (method) => (method === 'writeFile' ? (g.enter(), g.gate) : undefined) }));
  const w = watching('/gone');
  const root = watching('/');
  const writing = ns.writeFile('/gone/file', enc.encode('f'));
  await g.entering;
  ns.unmount('/gone');
  g.release();
  await writing;
  await settled();
  assert.deepEqual(w.take(), []);
  assert.deepEqual(root.take().filter((line) => line.includes('/gone')), []);
  w.stop(); root.stop();
});

await check('a rename is told at each end the watcher may see: out, in from where it may not look, into where it may not look', async () => {
  for (const dir of ['public', 'elsewhere', 'private']) kernel.mkdir(dir, { recursive: true });
  kernel.chmod('private', 0o700);
  kernel.writeFile('public/a', 'a');
  kernel.writeFile('public/b', 'b');
  kernel.writeFile('private/c', 'c');
  const pub = watching('/public', ns.as(PUBLIC));
  const all = watching('/', ns.as(PUBLIC));
  const proc = files.bind({ pid: 4110, cred: PUBLIC });
  const heard = [];
  const stop = proc.subscribe('/public', (event) => heard.push(said(event)));
  kernel.rename('public/a', 'elsewhere/a');
  kernel.rename('public/b', 'private/b');
  kernel.rename('private/c', 'public/c');
  await settled();
  assert.deepEqual(pub.take(), ['unlink /public/a', 'unlink /public/b', 'add /public/c']);
  assert.deepEqual(all.take().filter((line) => !line.includes('/home')), ['rename /public/a -> /elsewhere/a', 'unlink /public/b', 'add /public/c']);
  assert.deepEqual(heard, ['unlink public/a', 'unlink public/b', 'add public/c'], 'a process\\'s watch, as SQLite names it');
  pub.stop(); all.stop(); stop();
});

await check('a watch of a path whose directory is renamed hears it go and come; a watched path renamed is followed', async () => {
  kernel.mkdir('home/user/anc/sub', { recursive: true });
  kernel.writeFile('home/user/anc/sub/file', 'f');
  kernel.writeFile('home/user/followed', 'f');
  const leaf = watching('/home/user/anc/sub/file');
  const moved = watching('/home/user/anc2/sub/file');
  const followed = watching('/home/user/followed');
  await ns.rename('/home/user/anc', '/home/user/anc2');
  await ns.rename('/home/user/followed', '/home/user/followed2');
  await settled();
  assert.deepEqual(leaf.take(), ['unlink /home/user/anc/sub/file']);
  assert.deepEqual(moved.take(), ['add /home/user/anc2/sub/file']);
  assert.deepEqual(followed.take(), ['rename /home/user/followed -> /home/user/followed2']);
  leaf.stop(); moved.stop(); followed.stop();
});

await check('a copy tells each entry it made, SQLite\\'s and the namespace\\'s alike, the ones before a failure too', async () => {
  kernel.mkdir('home/user/source/d', { recursive: true });
  kernel.writeFile('home/user/source/file', 'f');
  kernel.writeFile('home/user/source/d/deep', 'd');
  const leaf = watching('/home/user/copy/file');
  const tree = watching('/home/user/copy');
  await ns.copy('/home/user/source', '/home/user/copy', { recursive: true });
  await settled();
  assert.deepEqual(leaf.take(), ['add /home/user/copy/file']);
  assert.deepEqual(tree.take().sort(), ['add /home/user/copy/d/deep', 'add /home/user/copy/file', 'addDir /home/user/copy', 'addDir /home/user/copy/d']);
  leaf.stop(); tree.stop();
  const src = new MemoryVFS({ uid: 0, gid: 0 });
  src.mkdir('/t');
  src.writeFile('/t/a', enc.encode('a'));
  src.writeFile('/t/b', enc.encode('b'));
  const dst = new MemoryVFS({ uid: 0, gid: 0 });
  const failing = new Proxy(dst, {
    get(target, key) {
      if (key === 'writeFile') return (path, ...rest) => { if (path === '/copy/b') throw Object.assign(new Error('EIO'), { code: 'EIO' }); return target.writeFile(path, ...rest); };
      if (key === 'sync') return undefined;
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  ns.mount('/csrc', src);
  ns.mount('/cdst', failing);
  const w = watching('/cdst');
  await assert.rejects(ns.copy('/csrc/t', '/cdst/copy', { recursive: true }));
  assert.deepEqual(w.take(), ['addDir /cdst/copy', 'add /cdst/copy/a']);
  w.stop();
  ns.unmount('/csrc'); ns.unmount('/cdst');
});

await check('a change on a store mounted twice is told at both names', async () => {
  const shared = new MemoryVFS({ uid: 0, gid: 0 });
  ns.mount('/a', shared);
  ns.mount('/b', shared);
  const a = watching('/a');
  const b = watching('/b');
  const root = watching('/');
  await ns.writeFile('/a/file', enc.encode('f'));
  assert.deepEqual(a.take(), ['change /a/file']);
  assert.deepEqual(b.take(), ['change /b/file']);
  assert.deepEqual(root.take().filter((line) => !line.includes('/home')).sort(), ['change /a/file', 'change /b/file']);
  a.stop(); b.stop(); root.stop();
  ns.unmount('/a'); ns.unmount('/b');
});

await check('mkdir -p tells only a directory it made', async () => {
  ns.mount('/rp', new MemoryVFS({ uid: 0, gid: 0 }), { resolvesPaths: true });
  const w = watching('/rp');
  await ns.mkdir('/rp/d', { recursive: true });
  await ns.mkdir('/rp/d', { recursive: true });
  assert.deepEqual(w.take(), ['addDir /rp/d']);
  w.stop();
  ns.unmount('/rp');
});

await check('a change is told to the watches registered when it landed, whatever was registered when it began', async () => {
  const g = gated();
  const backend = new MemoryVFS({ uid: 0, gid: 0 });
  let gate = null;
  ns.mount('/late', asyncOnly(backend, { beforeCall: (method) => (method === 'writeFile' && gate !== null ? (g.enter(), gate) : undefined) }));
  gate = g.gate;
  const writing = ns.writeFile('/late/file', enc.encode('f'));
  await g.entering;
  const early = watching('/late');
  early.stop();
  const late = watching('/late');
  g.release();
  await writing;
  gate = null;
  assert.deepEqual(early.take(), []);
  assert.deepEqual(late.take(), ['change /late/file']);
  late.stop();
  ns.unmount('/late');
});

await check('the engine\\'s listeners: one registered while a batch is told hears only what comes after; one let go then is not told', async () => {
  const heard = { a: [], b: [], c: [] };
  let stopA;
  let stopC = null;
  stopA = raw.events.on((batch) => {
    heard.a.push(...batch.map(said));
    if (stopC === null) stopC = raw.events.on((later) => heard.c.push(...later.map(said)));
    stopA();
  });
  const stopB = raw.events.on((batch) => heard.b.push(...batch.map(said)));
  kernel.writeFile('home/user/before', 'b');
  await settled();
  kernel.writeFile('home/user/after', 'a');
  await settled();
  assert.deepEqual(heard.a, ['add home/user/before']);
  assert.deepEqual(heard.b, ['add home/user/before', 'add home/user/after']);
  assert.deepEqual(heard.c, ['add home/user/after']);
  stopB(); stopC();
});

await check('registering a watch stores nothing an open description holds', async () => {
  kernel.writeFile('home/user/held.log', 'base:');
  const writer = raw.openDescription('home/user/held.log', CRED_KERNEL, { read: false, write: true });
  writer.write(writer.end(), enc.encode('held'));
  let stored = 0;
  const exec = harness.sql.exec.bind(harness.sql);
  harness.sql.exec = (query, ...params) => { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) stored++; return exec(query, ...params); };
  try {
    const w = watching('/home/user/unrelated', ns.as(PUBLIC));
    w.stop();
  } finally {
    harness.sql.exec = exec;
  }
  assert.equal(stored, 0, 'no storage write');
  writer.close();
  assert.equal(new TextDecoder().decode(kernel.readFile('home/user/held.log')), 'base:held');
});


if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('namespace-watch-changes: ok');
