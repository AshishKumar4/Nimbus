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
    // Only its source through the alias: checked where it was resolved, it
    // used to go where the alias pointed by the time it ran.
    ['rename to a fixed name', () => bridge.rename('/home/user/swing/v.txt', '/m/top/free/w.txt')],
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
  // Repointed while the call is under way, from the caller's side, with no
  // timing: a write whose source repoints the alias as it yields its bytes,
  // and a descriptor opened through the alias before it is repointed (it
  // writes the file it opened).
  {
    await seed();
    for (const dir of ['/top/leased', '/top/free']) await m.writeFile(`${dir}/v.txt`, enc.encode('v'));
    point('/m/top/free');
    const source = (async function* () { point('/m/top/leased'); yield enc.encode('moved'); })();
    const outcome = await code(() => bridge.writeFileFrom('/home/user/swing/v.txt', 5, source));
    const leased = (await m.readdir('/top/leased')).map((entry) => entry.name).sort();
    const v = await Promise.resolve().then(() => m.readFile('/top/leased/v.txt')).then((bytes) => new TextDecoder().decode(bytes), () => '(gone)');
    landed.push(['writeFileFrom, its source repointing the alias', outcome, leased.join(','), v]);
  }
  {
    await seed();
    for (const dir of ['/top/leased', '/top/free']) await m.writeFile(`${dir}/v.txt`, enc.encode('v'));
    point('/m/top/free');
    const fd = await bridge.open('/home/user/swing/v.txt', { read: true, write: true });
    point('/m/top/leased');
    const outcome = await code(() => bridge.write(fd.id, 0, enc.encode('d')));
    await bridge.close(fd.id);
    const leased = (await m.readdir('/top/leased')).map((entry) => entry.name).sort();
    const v = new TextDecoder().decode(await m.readFile('/top/leased/v.txt'));
    landed.push(['a descriptor\'s write after the alias moved', outcome, leased.join(','), v]);
    assert.deepEqual([outcome, new TextDecoder().decode(await m.readFile('/top/free/v.txt'))], ['ok', 'd'],
      'the descriptor writes the file it opened');
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

// ── A lease taken while a mutation waits on its own reads ────────────────
// The namespace guards each raw backend mutation right before it is made, on
// the route it resolved: a copy's every write, a walked removal's every
// unlink, rmdir's fallback unlink. Here the backend itself takes the lease
// while the mutation reads (a copy's readFile, a removal's readdir), so the
// next write or unlink must be refused, with no timing.
{
  const cred = { uid: 1000, gid: 1000, groups: [1000] };
  const ns = box.files.vfs.as(cred);
  const leases = [];
  const take = (root) => { leases.push(engine.acquireExclusiveMutation(root).owner); };
  const releaseAll = () => { while (leases.length > 0) engine.releaseExclusiveMutation(leases.pop()); };
  /**
   * `vfs` with no synchronous face, `hide`'s methods absent, and `hooks` run
   * before a call. With rmdir hidden, its unlink removes an empty directory,
   * as a plane's single delete does.
   */
  const hooked = (vfs, hooks, hide = []) => new Proxy(vfs, {
    get(target, key) {
      if (key === 'sync' || hide.includes(key)) return undefined;
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (key === 'as') return (...args) => hooked(value.apply(target, args), hooks, hide);
      return async (...args) => {
        await hooks[key]?.(...args);
        if (key === 'unlink' && hide.includes('rmdir') && (await target.stat(args[0], { follow: false }))?.type === 'directory') return target.rmdir(args[0]);
        return value.apply(target, args);
      };
    },
    has: (target, key) => key !== 'sync' && !hide.includes(key) && key in target,
  });

  const src = new MemoryVFS(USER);
  await src.mkdir('/tree');
  await src.writeFile('/f.txt', enc.encode('f'));
  await src.writeFile('/tree/a.txt', enc.encode('a'));
  await src.writeFile('/tree/b.txt', enc.encode('b'));
  const srcHooks = {};
  const dst = new MemoryVFS(USER);
  const w = new MemoryVFS(USER);
  const wHooks = {};
  ws.filesystem.vfs.mount('/src', hooked(src, srcHooks));
  ws.filesystem.vfs.mount('/dst', asyncOnly(dst));
  ws.filesystem.vfs.mount('/w', hooked(w, wHooks, ['removeRecursive', 'rmdir']));

  // A file copy: the source's readFile takes a lease on the destination.
  srcHooks.readFile = (path) => { if (path === '/f.txt') take('dst/f.txt'); };
  assert.equal(await code(() => ns.copy('/src/f.txt', '/dst/f.txt')), 'EBUSY', 'the copy\'s write is refused');
  assert.equal(await dst.stat('/f.txt'), null, 'and nothing was written');
  releaseAll();
  // Through a process's bridge too.
  srcHooks.readFile = (path) => { if (path === '/f.txt') take('dst/h.txt'); };
  assert.equal(await code(() => bridge.copyFile('/src/f.txt', '/dst/h.txt')), 'EBUSY', 'the bridge\'s copy too');
  assert.equal(await dst.stat('/h.txt'), null);
  releaseAll();

  // A tree copy: the second file's read takes a lease on its own destination.
  srcHooks.readFile = (path) => { if (path === '/tree/b.txt') take('dst/tree/b.txt'); };
  assert.equal(await code(() => ns.copy('/src/tree', '/dst/tree', { recursive: true })), 'EBUSY', 'a tree copy\'s later write is refused');
  assert.equal(await dst.stat('/tree/b.txt'), null, 'the leased name was not written');
  releaseAll();
  srcHooks.readFile = undefined;

  // A walked removal: its readdir of the operand takes a lease on a child.
  await w.mkdir('/t/keep', { recursive: true });
  await w.writeFile('/t/keep/x', enc.encode('x'));
  await w.writeFile('/t/gone.txt', enc.encode('g'));
  wHooks.readdir = (path) => { if (path === '/t') take('w/t/keep'); };
  const report = await ns.removeRecursive('/w/t');
  wHooks.readdir = undefined;
  assert.deepEqual(report.failures.map((f) => [f.path, f.error.code]), [['/w/t/keep/x', 'EBUSY']], 'the leased entry is refused');
  assert.deepEqual([report.kept, report.removed], [['/w/t', '/w/t/keep', '/w/t/keep/x'], ['/w/t/gone.txt']],
    'it is kept with the directories holding it, and the walk carries on');
  assert.equal(new TextDecoder().decode(await w.readFile('/t/keep/x')), 'x', 'the leased child is there');
  assert.equal(await w.stat('/t/gone.txt'), null, 'its sibling is removed');
  releaseAll();

  // rmdir on a backend without it: its readdir takes a lease on the directory.
  await w.mkdir('/empty');
  wHooks.readdir = (path) => { if (path === '/empty') take('w/empty'); };
  assert.equal(await code(() => ns.rmdir('/w/empty')), 'EBUSY', 'the fallback unlink is refused');
  wHooks.readdir = undefined;
  assert.equal((await w.stat('/empty'))?.type, 'directory', 'and the directory is there');
  releaseAll();
}

// ── A file copied onto a link writes, and is checked, where the link leads ──
// cp writes through a link at its destination. /m is asynchronous-only and
// not flagged; /m/top/free/l -> ../leased/f.txt. A file copied from another
// mount onto /m/top/free/l used to be checked at the link's own name while
// the backend's write followed it into the lease.
{
  await seed();
  await m.symlink('../leased/f.txt', '/top/free/l');
  const other = new MemoryVFS(USER);
  await other.writeFile('/c.txt', enc.encode('copied'));
  ws.filesystem.vfs.mount('/cs', asyncOnly(other));
  const ns = box.files.vfs.as({ uid: 1000, gid: 1000, groups: [1000] });
  const held = engine.acquireExclusiveMutation('m/top/leased');
  assert.equal(await code(() => ns.copy('/cs/c.txt', '/m/top/free/l')), 'EBUSY', 'the namespace\'s copy is refused where the link leads');
  assert.equal(await code(() => bridge.copyFile('/cs/c.txt', '/m/top/free/l')), 'EBUSY', 'and a process\'s copyFile');
  assert.equal(await code(() => bridge.copyFile('/cs/c.txt', '/home/user/alias/top/free/l')), 'EBUSY', 'also through the alias');
  assert.equal(new TextDecoder().decode(await m.readFile('/top/leased/f.txt')), 'f', 'the leased file is untouched');
  engine.releaseExclusiveMutation(held.owner);
  // Released, the copy writes through the link, as cp does.
  assert.equal(await ns.copy('/cs/c.txt', '/m/top/free/l'), 1);
  assert.equal(new TextDecoder().decode(await m.readFile('/top/leased/f.txt')), 'copied', 'released, the copy lands where the link leads');
  assert.equal((await m.stat('/top/free/l', { follow: false }))?.type, 'symlink', 'and the link stays a link');
  ws.filesystem.vfs.unmount('/cs');
}

// ── A write still resolving when its scope is revoked does not land ────────
// The namespace asks the bridge's scope again right before the backend is
// called. Each case holds the mount's stat of the write's own name, revokes
// the scope (a host lease disposed, a process killed, a process released),
// then lets the stat answer: the write is refused (EBADF), nothing written.
{
  const gated = new MemoryVFS(USER);
  let gate = null;
  /** Asynchronous-only, its stat of the gate's path held until the gate is released. */
  const gating = (vfs) => new Proxy(vfs, {
    get(target, key) {
      if (key === 'sync') return undefined;
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (key === 'as') return (...args) => gating(value.apply(target, args));
      return async (...args) => {
        if (key === 'stat' && gate !== null && args[0] === gate.path) { const open = gate; gate = null; open.reached(); await open.released; }
        return value.apply(target, args);
      };
    },
    has: (target, key) => key !== 'sync' && key in target,
  });
  ws.filesystem.vfs.mount('/g', gating(gated));
  /** Run `write` until the mount is asked for `path`, `revoke` there, then let it go on. */
  const revokedDuring = async (path, write, revoke) => {
    let reached; let release;
    const isReached = new Promise((resolve) => { reached = resolve; });
    gate = { path, reached, released: new Promise((resolve) => { release = resolve; }) };
    // An error's code, or an abort's name.
    const outcome = Promise.resolve().then(write).then(() => 'ok', (error) => (typeof error.code === 'string' ? error.code : error.name));
    await isReached;
    await revoke();
    release();
    return outcome;
  };
  const files = box.files;
  const cred = { ...USER, groups: [1000], umask: 0o022 };

  const lease = files.openHost(cred);
  assert.equal(await revokedDuring('/a.txt', () => lease.fs.writeFile('/g/a.txt', 'late'), () => lease.dispose()), 'EBADF', 'a disposed host lease');
  const killed = files.bind({ pid: 501, cred });
  assert.equal(await revokedDuring('/b.txt', () => killed.writeFile('/g/b.txt', 'late'), () => files.killProcess(501)), 'EBADF', 'a killed process');
  // A rename looks up no last component (it acts on the names), so it is
  // held at the mounted root's search.
  await gated.writeFile('/x.txt', enc.encode('x'));
  const released = files.bind({ pid: 502, cred });
  assert.equal(await revokedDuring('/', () => released.rename('/g/x.txt', '/g/c.txt'), () => files.releaseProcess(502)), 'EBADF', 'a released process\'s rename');
  const aborts = new AbortController();
  const signalled = files.bind({ pid: 503, cred, signal: aborts.signal });
  assert.equal(await revokedDuring('/d.txt', () => signalled.writeFile('/g/d.txt', 'late'), () => aborts.abort()), 'AbortError', 'an aborted binding');
  assert.deepEqual((await gated.readdir('/')).map((entry) => entry.name), ['x.txt'], 'nothing was written or renamed');
  // A live scope's write lands.
  const live = files.bind({ pid: 504, cred });
  await live.writeFile('/g/e.txt', 'ok');
  assert.equal(new TextDecoder().decode(await gated.readFile('/e.txt')), 'ok');
  await files.releaseProcess(504);
  ws.filesystem.vfs.unmount('/g');
}

// ── An aborted binding's buffered descriptor, torn down ──────────────────
// On a synchronous mount with no writeRange, a descriptor buffers its writes
// and its last close flushes them through the binding's own view, which
// refuses once the binding's signal is aborted. That flush failing stopped
// the teardown half way: the scope stayed open (a same-pid bridge without
// the signal went on using it), and the process stayed bound. Now the
// teardown finishes, then reports that the buffered bytes are lost.
{
  const plain = new MemoryVFS(USER);
  /** `vfs` with no writeRange, its credentialed and synchronous views too: a descriptor buffers. */
  const unranged = (vfs) => new Proxy(vfs, {
    get(target, key) {
      if (key === 'writeRange') return undefined;
      const value = target[key];
      if (key === 'sync') return value === undefined ? undefined : unranged(value);
      if (typeof value !== 'function') return value;
      if (key === 'as') return (...args) => unranged(value.apply(target, args));
      return value.bind(target);
    },
    has: (target, key) => key !== 'writeRange' && key in target,
  });
  ws.filesystem.vfs.mount('/b', unranged(plain));
  assert.equal(box.files.vfs.as({ uid: 1000, gid: 1000, groups: [1000] }).writesInPlace('/b/x'), false, 'the mount buffers');
  const files = box.files;
  const cred = { ...USER, groups: [1000], umask: 0o022 };
  const lostOnClose = (error) => error.code === 'EIO' && /its buffered writes are lost/.test(error.message) && error.cause?.name === 'AbortError';

  // A process: released after its signal-bound binding was aborted.
  {
    const aborts = new AbortController();
    const signalled = files.bind({ pid: 601, cred, signal: aborts.signal });
    const other = files.bind({ pid: 601, cred });
    const fd = await signalled.open('/b/p.txt', { write: true, create: true });
    await signalled.write(fd.id, 0, enc.encode('buffered'));
    aborts.abort();
    await assert.rejects(files.releaseProcess(601), lostOnClose, 'the release reports the lost bytes');
    assert.equal(await code(() => other.stat('/b')), 'EBADF', 'and the scope is closed for every bridge on it');
    assert.equal(plain.stat('/p.txt')?.size ?? 0, 0, 'nothing was flushed');
  }
  // A host lease: disposed after its signal was aborted.
  {
    const aborts = new AbortController();
    const lease = files.openHost(cred, { signal: aborts.signal });
    const fd = await lease.fs.open('/b/h.txt', { write: true, create: true });
    await lease.fs.write(fd.id, 0, enc.encode('buffered'));
    aborts.abort();
    await assert.rejects(lease.dispose(), lostOnClose, 'the dispose reports the lost bytes');
    await lease.dispose();
    assert.equal(plain.stat('/h.txt')?.size ?? 0, 0, 'nothing was flushed');
  }
  // A live binding's release flushes, as before.
  {
    const live = files.bind({ pid: 602, cred });
    const fd = await live.open('/b/l.txt', { write: true, create: true });
    await live.write(fd.id, 0, enc.encode('flushed'));
    await files.releaseProcess(602);
    assert.equal(new TextDecoder().decode(plain.readFile('/l.txt')), 'flushed');
  }
  ws.filesystem.vfs.unmount('/b');
}

console.log(`async-mount-leases: ${mutations.length} awaited mutations are checked where they land`);
