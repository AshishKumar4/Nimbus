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
import { VfsEventEmitter } from '../../packages/core/src/vfs/events.ts';
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
  const storeD = new MemoryVFS({ uid: 0, gid: 0 });
  const [actorA, actorB] = [new MemoryVFS({ uid: 0, gid: 0 }), new MemoryVFS({ uid: 0, gid: 0 })];
  ns.mount('/device', (principal) => (principal.cred?.uid === 1000 ? null : storeD));
  ns.mount('/pc', (principal) => (principal.cred?.uid === 2000 ? storeB : storeA));
  ns.mount('/actors', (principal) => (principal.actor === 'b' ? actorB : actorA));
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
  assert.deepEqual(heard, ['unlink public/a', 'unlink public/b', 'add public/c'], 'a process\'s watch, as SQLite names it');
  pub.stop(); all.stop(); stop();
});

await check('a watch of a path hears it go when it, or the directory above it, is renamed', async () => {
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
  assert.deepEqual(moved.take(), [], 'what a directory renamed above it brings is not known');
  assert.deepEqual(followed.take(), ['unlink /home/user/followed']);
  leaf.stop(); moved.stop(); followed.stop();
});

await check('a copy tells each entry it made, SQLite\'s and the namespace\'s alike, the ones before a failure too', async () => {
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

await check('mkdir -p tells only a directory it made, a watch registered while it runs included', async () => {
  ns.mount('/rp', new MemoryVFS({ uid: 0, gid: 0 }), { resolvesPaths: true });
  const w = watching('/rp');
  await ns.mkdir('/rp/d', { recursive: true });
  await ns.mkdir('/rp/d', { recursive: true });
  assert.deepEqual(w.take(), ['addDir /rp/d']);
  w.stop();
  ns.unmount('/rp');
  const g = gated();
  const slow = new MemoryVFS({ uid: 0, gid: 0 });
  slow.mkdir('/d');
  ns.mount('/rps', asyncOnly(slow, { beforeCall: (method) => (method === 'mkdir' ? (g.enter(), g.gate) : undefined) }), { resolvesPaths: true });
  const making = ns.mkdir('/rps/d', { recursive: true });
  await g.entering;
  const late = watching('/rps');
  g.release();
  await making;
  assert.deepEqual(late.take(), [], 'nothing made');
  late.stop();
  ns.unmount('/rps');
  const g2 = gated();
  ns.mount('/rpm2', asyncOnly(new MemoryVFS({ uid: 0, gid: 0 }), { beforeCall: (method) => (method === 'mkdir' ? (g2.enter(), g2.gate) : undefined) }), { resolvesPaths: true });
  const creating = ns.mkdir('/rpm2/a/b', { recursive: true });
  await g2.entering;
  const later = watching('/rpm2');
  g2.release();
  await creating;
  assert.deepEqual(later.take(), ['addDir /rpm2/a', 'addDir /rpm2/a/b'], 'each it made, as its backend says');
  later.stop();
  ns.unmount('/rpm2');
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

await check('the engine\'s listeners: one registered while a batch is told hears only what comes after; one let go then is not told', async () => {
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


await check('a watch of a path hears it go when it, or a directory above it, is renamed; one that follows its target moves with it, the changes after in the same batch too', async () => {
  kernel.writeFile('home/user/f1', 'one');
  kernel.mkdir('home/user/dirA/sub', { recursive: true });
  kernel.writeFile('home/user/dirA/sub/deep', 'one');
  const fixedFile = watching('/home/user/f1');
  const fixedDeep = watching('/home/user/dirA/sub/deep');
  const following = (path) => {
    const heard = [];
    const stop = ns.watchChanges(path, (events) => heard.push(...events.map(said)), { follow: true });
    return { stop, take: () => heard.splice(0) };
  };
  const file = following('/home/user/f1');
  const deep = following('/home/user/dirA/sub/deep');
  kernel.rename('home/user/f1', 'home/user/f2');
  kernel.writeFile('home/user/f2', 'two');
  kernel.rename('home/user/dirA', 'home/user/dirB');
  kernel.writeFile('home/user/dirB/sub/deep', 'two');
  await settled();
  assert.deepEqual(file.take(), ['rename /home/user/f1 -> /home/user/f2', 'change /home/user/f2']);
  assert.deepEqual(deep.take(), ['rename /home/user/dirA/sub/deep -> /home/user/dirB/sub/deep', 'change /home/user/dirB/sub/deep']);
  assert.deepEqual(fixedFile.take(), ['unlink /home/user/f1']);
  assert.deepEqual(fixedDeep.take(), ['unlink /home/user/dirA/sub/deep']);
  for (const w of [file, deep, fixedFile, fixedDeep]) w.stop();
});

await check('a directory above a watched path renamed again, or its target then written or removed, in the same batch: followed to where it went', async () => {
  const following = (path) => {
    const heard = [];
    const stop = ns.watchChanges(path, (events) => heard.push(...events.map(said)), { follow: true });
    return { stop, take: () => heard.splice(0) };
  };
  const cases = [
    ['twice, then written', (at) => { kernel.rename(`${at}1`, `${at}2`); kernel.rename(`${at}2`, `${at}3`); kernel.writeFile(`${at}3/sub/file`, 'two'); },
      (at) => [`rename /${at}1/sub/file -> /${at}2/sub/file`, `rename /${at}2/sub/file -> /${at}3/sub/file`, `change /${at}3/sub/file`]],
    ['then unlinked', (at) => { kernel.rename(`${at}1`, `${at}2`); kernel.unlink(`${at}2/sub/file`); },
      (at) => [`rename /${at}1/sub/file -> /${at}2/sub/file`, `unlink /${at}2/sub/file`]],
    ['then removed with its tree', (at) => { kernel.rename(`${at}1`, `${at}2`); kernel.removeRecursive(`${at}2`); },
      (at) => [`rename /${at}1/sub/file -> /${at}2/sub/file`, `unlink /${at}2/sub/file`]],
    ['twice, then removed', (at) => { kernel.rename(`${at}1`, `${at}2`); kernel.rename(`${at}2`, `${at}3`); kernel.unlink(`${at}3/sub/file`); },
      (at) => [`rename /${at}1/sub/file -> /${at}2/sub/file`, `rename /${at}2/sub/file -> /${at}3/sub/file`, `unlink /${at}3/sub/file`]],
  ];
  for (const [what, change, followed] of cases) {
    const at = `carried-${what.replace(/\W+/g, '-')}-`;
    kernel.mkdir(`${at}1/sub`, { recursive: true });
    kernel.writeFile(`${at}1/sub/file`, 'one');
    const fixed = watching(`/${at}1/sub/file`);
    const follows = following(`/${at}1/sub/file`);
    change(at);
    await settled();
    assert.deepEqual(follows.take(), followed(at), `${what}: following`);
    assert.deepEqual(fixed.take(), [`unlink /${at}1/sub/file`], `${what}: fixed`);
    fixed.stop(); follows.stop();
  }
  // Made where it was taken to after the move: it was not there to take.
  kernel.mkdir('carried-made-1', { recursive: true });
  const made = watching('/carried-made-1/sub/file');
  kernel.rename('carried-made-1', 'carried-made-2');
  kernel.mkdir('carried-made-2/sub');
  kernel.writeFile('carried-made-2/sub/file', 'new');
  await settled();
  assert.deepEqual(made.take(), [], 'made after the move');
  made.stop();
});

await check('a directory above a watched path renamed: nothing told where the watcher could not look, and no path is made up', async () => {
  kernel.mkdir('before/secret', { recursive: true });
  kernel.writeFile('before/secret/token', 't');
  kernel.chmod('before/secret', 0o700);
  kernel.mkdir('before2', { recursive: true });
  const user = watching('/before/secret/token', ns.as(PUBLIC));
  const missing = watching('/after2/missing');
  kernel.rename('before', 'after');
  kernel.rename('before2', 'after2');
  await settled();
  assert.deepEqual(user.take(), []);
  assert.deepEqual(missing.take(), []);
  user.stop(); missing.stop();
  kernel.mkdir('open1/sub', { recursive: true });
  kernel.writeFile('open1/sub/file', 'f');
  const seen = watching('/open1/sub/file', ns.as(PUBLIC));
  const proc = files.bind({ pid: 4120, cred: PUBLIC });
  const heard = [];
  const stop = proc.subscribe('/open1/sub/file', (event) => heard.push(said(event)));
  kernel.rename('open1', 'open2');
  await settled();
  assert.deepEqual(seen.take(), ['unlink /open1/sub/file'], 'where the watcher could look, it hears its path go');
  assert.deepEqual(heard, ['unlink open1/sub/file']);
  seen.stop(); stop();
  // Following: nothing hidden, nothing made up.
  kernel.mkdir('fb/secret', { recursive: true });
  kernel.writeFile('fb/secret/token', 't');
  kernel.chmod('fb/secret', 0o700);
  kernel.mkdir('fm', { recursive: true });
  const heardFollowing = [];
  const stops = [
    ns.as(PUBLIC).watchChanges('/fb/secret/token', (events) => heardFollowing.push(...events.map(said)), { follow: true }),
    ns.watchChanges('/fm/missing', (events) => heardFollowing.push(...events.map(said)), { follow: true }),
    ns.watchChanges('/fm-fixed-missing', () => {}),
  ];
  const fixedMissing = watching('/fm/missing');
  kernel.rename('fb', 'fa');
  kernel.rename('fm', 'fn');
  await settled();
  assert.deepEqual(heardFollowing, []);
  assert.deepEqual(fixedMissing.take(), []);
  for (const s of stops) s();
  fixedMissing.stop();
});

await check('a change is told in the store its write was routed to, whatever the mount gives when it lands', async () => {
  const g = gated();
  const storeA = new MemoryVFS({ uid: 0, gid: 0 });
  const storeB = new MemoryVFS({ uid: 0, gid: 0 });
  const slowA = asyncOnly(storeA, { beforeCall: (method) => (method === 'writeFile' ? (g.enter(), g.gate) : undefined) });
  let current = slowA;
  ns.mount('/factory', () => current);
  ns.mount('/alias-a', storeA);
  const root = watching('/');
  try {
    const writing = ns.writeFile('/factory/file', enc.encode('f'));
    await g.entering;
    current = storeB;
    g.release();
    await writing;
    assert.deepEqual(root.take().filter((line) => !line.includes('/home')), ['change /alias-a/file']);
  } finally {
    root.stop();
    ns.unmount('/factory'); ns.unmount('/alias-a');
  }
});

await check('on a mount that resolves its own paths, a change under a directory the watcher may not search is not told to it', async () => {
  const other = createSqliteVfsTestHarness();
  const inner = sqliteFiles(new SqliteVFS(other.sql, other.ctx), CRED_KERNEL);
  const quiet = (vfs) => new Proxy(vfs, {
    get(target, key) {
      if (key === 'watchChanges') return undefined;
      if (key === 'as') return (...args) => quiet(target.as(...args));
      if (key === 'sync') return quiet(target.sync === target ? target : target.sync);
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has: (target, key) => key !== 'watchChanges' && key in target,
  });
  ns.mount('/rpm', quiet(inner), { resolvesPaths: true });
  await ns.mkdir('/rpm/secret');
  await ns.chmod('/rpm/secret', 0o700);
  const user = watching('/rpm', ns.as(PUBLIC));
  const root = watching('/rpm');
  try {
    await ns.writeFile('/rpm/secret/token', enc.encode('t'));
    await settled();
    assert.deepEqual(user.take(), []);
    assert.deepEqual(root.take(), ['change /rpm/secret/token']);
  } finally {
    user.stop(); root.stop();
    ns.unmount('/rpm');
  }
});

await check('a watch whose judgment awaits holds the batches after it: none judged or told before it is, and each is judged by what followed it', async () => {
  const g = gated();
  let asked = 0;
  const held = new MemoryVFS({ uid: 0, gid: 0 });
  held.mkdir('/a');
  held.writeFile('/a/f', enc.encode('f'));
  held.mkdir('/c');
  held.writeFile('/c/h', enc.encode('h'));
  ns.mount('/held', asyncOnly(held, {
    methods: { access: () => undefined },
    beforeCall: (method) => (method === 'access' ? (asked++, g.enter(), g.gate) : undefined),
  }), { resolvesPaths: true });
  ns.mount('/quick', new MemoryVFS({ uid: 0, gid: 0 }));
  const ours = (line) => line.includes('/held') || line.includes('/quick');
  const user = watching('/', ns.as(PUBLIC));
  const heardFollowing = [];
  const stopFollowing = ns.as(PUBLIC).watchChanges('/held/a/f', (events) => heardFollowing.push(...events.map(said)), { follow: true });
  const heardMade = [];
  const stopMade = ns.as(PUBLIC).watchChanges('/held/a/g', (events) => heardMade.push(...events.map(said)), { follow: true });
  const heardWritten = [];
  const stopWritten = ns.as(PUBLIC).watchChanges('/held/c/h', (events) => heardWritten.push(...events.map(said)), { follow: true });
  await settled();
  try {
    await ns.mkdir('/held/d');
    await g.entering;
    await settled();
    const judging = asked;
    await ns.mkdir('/held/e');
    await ns.writeFile('/quick/b', enc.encode('b'));
    await ns.rename('/held/a', '/held/b');
    await ns.unlink('/held/b/f');
    await ns.writeFile('/held/b/g', enc.encode('g'));
    await ns.rename('/held/c', '/held/k');
    await ns.writeFile('/held/k/h', enc.encode('h2'));
    await settled();
    assert.equal(asked, judging, 'the batches after it wait to be judged');
    assert.deepEqual(user.take().filter(ours), [], 'nothing told before it');
    assert.deepEqual(heardFollowing, []);
    g.release();
    await settled();
    assert.deepEqual(user.take().filter(ours), [
      'addDir /held/d', 'addDir /held/e', 'change /quick/b', 'rename /held/a -> /held/b', 'unlink /held/b/f', 'change /held/b/g',
      'rename /held/c -> /held/k', 'change /held/k/h',
    ]);
    assert.deepEqual(heardFollowing, ['rename /held/a/f -> /held/b/f', 'unlink /held/b/f'], 'a move judged by what followed it');
    assert.deepEqual(heardMade, [], 'a write after the move may have made it: it is not taken to have been there');
    assert.deepEqual(heardWritten, ['rename /held/c/h -> /held/k/h', 'change /held/k/h'], 'nor to have not been');
  } finally {
    g.release();
    user.stop(); stopFollowing(); stopMade(); stopWritten();
    ns.unmount('/held'); ns.unmount('/quick');
  }
});

await check('a directory above a watched path renamed, then its target written through the namespace: taken along only if it was there, as the watch began and its changes since say', async () => {
  const g = gated();
  let gating = false;
  const store = new MemoryVFS({ uid: 0, gid: 0 });
  store.mkdir('/before');
  store.writeFile('/before/file', enc.encode('one'));
  store.mkdir('/empty');
  // Any look at where the target went waits while the write after the move lands.
  const held = (method, [path]) => gating && method === 'stat' && path === '/after/file';
  ns.mount('/carry', asyncOnly(store, { beforeCall: (method, args) => (held(method, args) ? (gating = false, g.enter(), g.gate) : undefined) }), { resolvesPaths: true });
  const heard = { follows: [], fixed: [], absent: [] };
  const stops = [];
  try {
    stops.push(ns.watchChanges('/carry/before/file', (events) => heard.follows.push(...events.map(said)), { follow: true }));
    stops.push(ns.watchChanges('/carry/before/file', (events) => heard.fixed.push(...events.map(said))));
    stops.push(ns.watchChanges('/carry/empty/file', (events) => heard.absent.push(...events.map(said)), { follow: true }));
    await settled();
    gating = true;
    await ns.rename('/carry/before', '/carry/after');
    await ns.rename('/carry/empty', '/carry/emptied');
    await settled();
    gating = false;
    await ns.writeFile('/carry/after/file', enc.encode('two'));
    await ns.writeFile('/carry/emptied/file', enc.encode('made'));
    g.release();
    await settled();
    assert.deepEqual(heard.follows, ['rename /carry/before/file -> /carry/after/file', 'change /carry/after/file']);
    assert.deepEqual(heard.fixed, ['unlink /carry/before/file']);
    assert.deepEqual(heard.absent, [], 'made after the move: not taken along');
  } finally {
    g.release();
    for (const stop of stops) stop();
    ns.unmount('/carry');
  }
});

await check('a source that fails one watcher\'s view as a change lands: every other watch is told, and the write stands', async () => {
  const shared = new MemoryVFS({ uid: 0, gid: 0 });
  ns.mount('/plain', shared);
  ns.mount('/picky', (principal) => {
    if (principal.cred?.uid === 1000) throw new Error('no source for this view');
    return shared;
  });
  const user = watching('/plain', ns.as(PUBLIC));
  const root = watching('/');
  const errors = console.error;
  console.error = () => {};
  try {
    await ns.writeFile('/plain/f', enc.encode('f'));
  } finally {
    console.error = errors;
  }
  assert.deepEqual(user.take(), ['change /plain/f']);
  assert.deepEqual(root.take().filter((line) => !line.includes('/home')).sort(), ['change /picky/f', 'change /plain/f']);
  user.stop(); root.stop();
  ns.unmount('/plain'); ns.unmount('/picky');
});

await check('mkdir -p on a mount that resolves its own paths is one call to its backend, watched or not, and tells what that backend says it made', async () => {
  const calls = [];
  ns.mount('/rpa', asyncOnly(new MemoryVFS({ uid: 0, gid: 0 }), { beforeCall: (method) => { calls.push(method); } }), { resolvesPaths: true });
  const silentCalls = [];
  ns.mount('/rpq', asyncOnly(new MemoryVFS({ uid: 0, gid: 0 }), {
    beforeCall: (method) => { silentCalls.push(method); },
    methods: { mkdir(path, options) { this.mkdir(path, options); } },
  }), { resolvesPaths: true });
  const w = watching('/');
  try {
    await ns.mkdir('/rpa/x/y', { recursive: true });
    await ns.mkdir('/rpq/x/y', { recursive: true });
    assert.deepEqual(calls, ['mkdir']);
    assert.deepEqual(silentCalls, ['mkdir']);
    assert.deepEqual(w.take().filter((line) => line.includes('/rp')), ['addDir /rpa/x', 'addDir /rpa/x/y'], 'a backend that does not say what it made has nothing told');
  } finally {
    w.stop();
    ns.unmount('/rpa'); ns.unmount('/rpq');
  }
});

await check('a listener that publishes while it is told: what it publishes is after, for every listener', async () => {
  const bus = new VfsEventEmitter();
  const all = [];
  const late = [];
  bus.on((batch) => all.push(...batch.map((event) => event.path)));
  bus.onPath('first', () => {
    bus.on((batch) => late.push(...batch.map((event) => event.path)));
    bus.emit('add', 'second');
  });
  bus.emit('add', 'first');
  await settled();
  assert.deepEqual(all, ['first', 'second']);
  assert.deepEqual(late, ['second']);
  const paths = new VfsEventEmitter();
  const heardA = [];
  const heardB = [];
  paths.onPath('', (event) => {
    heardA.push(event.path);
    if (event.path === 'a') paths.emit('add', 'b');
  });
  paths.onPath('', (event) => heardB.push(event.path));
  paths.emit('add', 'a');
  assert.deepEqual(heardA, ['a', 'b']);
  assert.deepEqual(heardB, ['a', 'b'], 'every path listener hears them in the order they were published');
});

await check('a killed process\'s subscriptions all stop, one whose backend fails to stop included', async () => {
  const failing = new MemoryVFS({ uid: 0, gid: 0 });
  failing.watchChanges = () => () => { throw new Error('the backend could not stop'); };
  ns.mount('/stuck', failing);
  const procPid = 4130;
  const proc = files.bind({ pid: procPid, cred: CRED_KERNEL });
  const heard = [];
  proc.subscribe('/stuck', () => {});
  proc.subscribe('/home/user', (event) => heard.push(said(event)));
  const errors = console.error;
  console.error = () => {};
  try {
    files.killProcess(procPid);
  } finally {
    console.error = errors;
  }
  kernel.writeFile('home/user/after-kill', 'k');
  await settled();
  assert.deepEqual(heard, []);
  ns.unmount('/stuck');
});


if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('namespace-watch-changes: ok');
