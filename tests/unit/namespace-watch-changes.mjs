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

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('namespace-watch-changes: ok');
