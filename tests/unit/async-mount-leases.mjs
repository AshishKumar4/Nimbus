#!/usr/bin/env bun
// A mutation on an asynchronous-only mount is checked against exclusive-
// mutation leases where it lands, as one on a synchronous mount is
// (8e8fa977, locateMutation): at the name the caller gave and at the name the
// lookup reaches, links on the way followed and the last one only when the
// call follows it.
//
// The synchronous walk refuses a path on an asynchronous mount, and the
// awaiting face then mutated through the namespace with no lease check at
// the name reached: a lease on m/leased did not stop a rename, an unlink or
// a write through /home/user/alias -> /m. A path relative to a descriptor
// open on the mount skipped the synchronous walk altogether.
//
// Every awaited mutation, through a process's view and its bridge (string
// paths, a descriptor-relative path, a preopen), and the edge: a dangling
// last link leads into the lease for a call that follows it (a write), and is
// the link itself for one that does not (unlink).
//
// That edge exposed a walk bug on both faces: the synchronous bridge
// resolved a SQLite link's target inside SQLite, so a link leading into a
// mount below its point (/home/user/dir -> /s/top) answered ENOENT for every
// read and write through it, on a synchronous mount as on an asynchronous
// one. It walks the target component by component now.

import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';

const USER = { uid: 1000, gid: 1000 };
const code = (run) => Promise.resolve().then(run).then(() => 'ok', (error) => error.code);

/** Called with each call the asynchronous mount takes, before it runs (the alias swap below). */
let beforeCall = null;

/** A MemoryVFS with no synchronous face: every call answers a promise. */
const asyncOnly = (vfs) => new Proxy(vfs, {
  get(target, key) {
    if (key === 'sync') return undefined;
    const value = target[key];
    if (typeof value !== 'function') return value;
    if (key === 'as') return (...args) => asyncOnly(value.apply(target, args));
    return async (...args) => { beforeCall?.(String(key), args); return value.apply(target, args); };
  },
  has: (target, key) => key !== 'sync' && key in target,
});

const m = new MemoryVFS(USER);
const s = new MemoryVFS(USER);
const box = await testBox({ mounts: { '/m': asyncOnly(m), '/s': s } });
const { workspace: ws } = box;
const engine = box.files.engine;
const view = ws.shell.getVfs();
const enc = new TextEncoder();
const source = async function* () { yield enc.encode('x'); };

// The tree each case starts from: the lease's directory under /m/top, a free
// sibling, the link /home/user/alias -> /m, and dangling links into the lease.
const seed = async () => {
  if (await m.stat('/top')) await m.removeRecursive('/top');
  await m.mkdir('/top/leased/sub', { recursive: true });
  await m.writeFile('/top/leased/f.txt', enc.encode('f'));
  await m.mkdir('/top/free');
  await m.writeFile('/top/free/h.txt', enc.encode('h'));
  for (const [link, target] of [['alias', '/m'], ['dangle', '/m/top/leased/new.txt'], ['deep', '/m/top/leased/gone/x.txt']]) {
    if ((await view.stat(`/home/user/${link}`, { follow: false })) === null) await view.symlink(target, `/home/user/${link}`);
  }
};
await seed();

const bridge = ws.filesystem.bind({ pid: 71, cred: { ...USER, groups: [1000], umask: 0o022 } });
// A descriptor open on the mount, through the link: the awaiting face's own.
const dir = await bridge.open('/home/user/alias', { read: true, directory: true });
const under = (path) => ({ directory: dir.id, path });

const A = '/home/user/alias/top/leased';
const F = '/home/user/alias/top/free';
const mutations = [
  ['writeFile', () => bridge.writeFile(`${A}/f.txt`, 'y')],
  ['writeFile, making parents', () => bridge.writeFile(`${A}/p/q.txt`, 'y', { createParents: true })],
  ['writeRange', () => bridge.writeRange(`${A}/f.txt`, 0, enc.encode('y'))],
  ['writeFileFrom', () => bridge.writeFileFrom(`${A}/f.txt`, 1, source())],
  ['truncate', () => bridge.truncate(`${A}/f.txt`, 0)],
  ['utimes', () => bridge.utimes(`${A}/f.txt`, 1, 1)],
  ['chmod', () => bridge.chmod(`${A}/f.txt`, 0o600)],
  ['chown', () => bridge.chown(`${A}/f.txt`, 1000, 1000)],
  ['mkdir', () => bridge.mkdir(`${A}/d`)],
  ['mkdir -p', () => bridge.mkdir(`${A}/d/e`, { recursive: true })],
  ['unlink', () => bridge.unlink(`${A}/f.txt`)],
  ['rmdir', () => bridge.rmdir(`${A}/sub`)],
  ['rename out of the lease', () => bridge.rename(`${A}/f.txt`, `${F}/f.txt`)],
  ['rename into the lease', () => bridge.rename(`${F}/h.txt`, `${A}/h.txt`)],
  ['symlink', () => bridge.symlink('/x', `${A}/l`)],
  ['remove', () => bridge.remove(`${A}/f.txt`)],
  ['remove -r of a directory holding the lease', () => bridge.remove('/home/user/alias/top', { recursive: true })],
  ['copyFile onto it', () => bridge.copyFile(`${F}/h.txt`, `${A}/g.txt`)],
  ['copyTree onto it', () => bridge.copyTree(F, `${A}/t`)],
  ['open for writing, truncating', () => bridge.open(`${A}/f.txt`, { write: true, truncate: true })],
  ['open, creating', () => bridge.open(`${A}/n.txt`, { write: true, create: true })],
  ['a path relative to a descriptor on the mount', () => bridge.unlink(under('top/leased/f.txt'))],
  ['a path beneath a preopen on the mount', () => bridge.writeFile({ root: 'm/top', path: 'leased/f.txt', beneath: true }, 'y')],
  ['a write through a dangling link into it', () => bridge.writeFile('/home/user/dangle', 'y')],
  ['a write making parents through a dangling link into it', () => bridge.writeFile('/home/user/deep', 'y', { createParents: true })],
  ['a view\'s rename through the link', () => view.rename(`${A}/f.txt`, `${A}/g.txt`)],
  ['a view\'s unlink through the link', () => view.unlink(`${A}/f.txt`)],
  ['a view\'s write through the link', () => view.writeFile(`${A}/f.txt`, 'y')],
];

const lease = engine.acquireExclusiveMutation('m/top/leased');
const outcomes = [];
for (const [what, run] of mutations) {
  outcomes.push([what, await code(run)]);
  await seed();
}
assert.deepEqual(outcomes.filter(([, outcome]) => outcome !== 'EBUSY'), [], 'each refused where it lands (EBUSY)');
// What does not land in the lease goes through: a dangling link's own unlink,
// and a sibling of the lease.
assert.equal(await code(() => bridge.unlink('/home/user/dangle')), 'ok', 'unlinking a dangling link takes the link, not what it names');
assert.equal(await code(() => bridge.writeFile(`${F}/ok.txt`, 'ok')), 'ok', 'beside the lease');
assert.equal(new TextDecoder().decode(await m.readFile('/top/leased/f.txt')), 'f', 'nothing in the lease changed');
assert.equal(await m.stat('/top/leased/new.txt'), null);
engine.releaseExclusiveMutation(lease.owner);

// ── Descriptors opened before the lease: each mutation through one is refused ──
{
  await seed();
  const fd = await bridge.open(`${A}/f.txt`, { read: true, write: true });
  const held = engine.acquireExclusiveMutation('m/top/leased');
  const through = [
    ['write', () => bridge.write(fd.id, 0, enc.encode('y'))],
    ['ftruncate', () => bridge.ftruncate(fd.id, 0)],
    ['fchmod', () => bridge.fchmod(fd.id, 0o600)],
    ['fchown', () => bridge.fchown(fd.id, 1000, 1000)],
    ['futimes', () => bridge.futimes(fd.id, 1, 1)],
  ];
  const refused = [];
  for (const [what, run] of through) refused.push([what, await code(run)]);
  assert.deepEqual(refused.filter(([, outcome]) => outcome !== 'EBUSY'), [], 'a descriptor\'s mutations are refused where they land');
  assert.equal(new TextDecoder().decode(await bridge.read(fd.id, 0, 8)), 'f', 'and a read through it still reads');
  engine.releaseExclusiveMutation(held.owner);
  await bridge.write(fd.id, 0, enc.encode('w'));
  assert.equal(new TextDecoder().decode(await m.readFile('/top/leased/f.txt')), 'w', 'released, it writes');
  await bridge.close(fd.id);
}

// ── The alias repointed mid-call: a mutation lands where it was checked ──
// The namespace resolves a mutation once and checks the lease on that route
// right before it calls the backend. Here the alias moves from free to
// leased while the call is under way (the first time the mount is asked
// about top/free): the mutation lands in free, or is refused, and never
// reaches leased unchecked.
{
  const ns = box.files.vfs.sync;
  const point = (target) => {
    if (ns.stat('/home/user/swing', { follow: false })) ns.unlink('/home/user/swing');
    ns.symlink(target, '/home/user/swing');
  };
  const swings = [
    ['writeFile', () => bridge.writeFile('/home/user/swing/v.txt', 'moved')],
    ['writeFile, making parents', () => bridge.writeFile('/home/user/swing/new/v.txt', 'moved', { createParents: true })],
    ['writeFileFrom', () => bridge.writeFileFrom('/home/user/swing/v.txt', 5, (async function* () { yield enc.encode('moved'); })())],
    ['truncate', () => bridge.truncate('/home/user/swing/v.txt', 0)],
    ['unlink', () => bridge.unlink('/home/user/swing/v.txt')],
    ['rename', () => bridge.rename('/home/user/swing/v.txt', '/home/user/swing/w.txt')],
    ['a view\'s write', () => view.writeFile('/home/user/swing/v.txt', 'moved')],
  ];
  const held = engine.acquireExclusiveMutation('m/top/leased');
  const landed = [];
  for (const [what, run] of swings) {
    await seed();
    for (const dir of ['/top/leased', '/top/free']) await m.writeFile(`${dir}/v.txt`, enc.encode('v'));
    point('/m/top/free');
    let swung = false;
    beforeCall = (_key, args) => {
      if (typeof args[0] !== 'string' || !args[0].startsWith('/top/free')) return;
      beforeCall = null;
      swung = true;
      point('/m/top/leased');
    };
    const outcome = await code(run);
    beforeCall = null;
    assert.ok(swung, `${what}: the alias moved while the call was under way`);
    const leased = (await m.readdir('/top/leased')).map((entry) => entry.name).sort();
    const v = await Promise.resolve().then(() => m.readFile('/top/leased/v.txt')).then((bytes) => new TextDecoder().decode(bytes), () => '(gone)');
    landed.push([what, outcome, leased.join(','), v]);
  }
  engine.releaseExclusiveMutation(held.owner);
  for (const [what, outcome, leased, v] of landed) {
    assert.ok(outcome === 'ok' || outcome === 'EBUSY', `${what}: ${outcome}`);
    assert.deepEqual([leased, v], ['f.txt,sub,v.txt', 'v'], `${what}: nothing in the lease changed (${outcome})`);
  }
  point('/m');
}

// Released, the same calls go through.
await seed();
await bridge.rename(`${A}/f.txt`, `${A}/g.txt`);
assert.equal((await m.stat('/top/leased/g.txt'))?.type, 'file', 'released, a rename through the link renames');
await bridge.writeFile('/home/user/dangle', 'made');
assert.equal(new TextDecoder().decode(await m.readFile('/top/leased/new.txt')), 'made', 'and a write through a dangling link makes its target');
await bridge.close(dir.id);

// ── A SQLite link into a mount below its point, followed by the walk ─────
await s.mkdir('/top', { recursive: true });
await view.symlink('/s/top', '/home/user/sdir');
await view.symlink('/s/top/made.txt', '/home/user/sdangle');
await view.symlink('/m/top/free', '/home/user/mdir');
await bridge.writeFile('/home/user/sdir/a.txt', 'through a directory link');
assert.equal(new TextDecoder().decode(s.readFile('/top/a.txt')), 'through a directory link', 'a write through a link into a synchronous mount');
assert.equal(new TextDecoder().decode(await bridge.readFile('/home/user/sdir/a.txt')), 'through a directory link', 'and a read');
await bridge.writeFile('/home/user/sdangle', 'made');
assert.equal(new TextDecoder().decode(s.readFile('/top/made.txt')), 'made', 'a write through a dangling link makes its target on the mount');
await bridge.writeFile('/home/user/mdir/b.txt', 'async');
assert.equal(new TextDecoder().decode(await m.readFile('/top/free/b.txt')), 'async', 'and on an asynchronous mount');
const cat = await ws.exec('cat /home/user/sdir/a.txt /home/user/mdir/b.txt');
assert.deepEqual([cat.exitCode, cat.stdout, cat.stderr], [0, 'through a directory linkasync', ''], 'the shell reads through both');

console.log(`async-mount-leases: ${mutations.length} awaited mutations are checked where they land`);
