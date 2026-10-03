#!/usr/bin/env bun
// A mount whose backend resolves its own paths (MountOptions.resolvesPaths,
// Kinu's ask 10): every operation on a path inside it is one call to the
// backend with the mount-relative path. No component on the way is stat-ed,
// no parent is checked, no link inside it is read by the namespace. Kinu's
// /pc device tunnel, /sandbox container and /shared Drive are each a round
// trip per call, and a device refuses even a stat of what is above the
// directory its user consented to.
//
// Composite alone, with a counting fake backend:
//   - each operation (stat, lstat, readdir, readFile, readRange, writeFile,
//     mkdir -p, rename, unlink, realpath) is exactly one backend call, on the
//     async face and on the sync face;
//   - a device that refuses ancestor stats (EACCES) serves its consented file,
//     and a plane that makes parents on write takes a deep write; without the
//     flag the component walk refuses both, and still makes its 7 calls;
//   - the namespace still owns the way in: root links into the mount, ENXIO
//     with the absent reason, the mount point (EBUSY, EISDIR, mkdir -p),
//     EROFS, EXDEV, and a mount nested inside;
//   - copy across mounts, both ways, with no parent check on the target.
// Then a NimbusWorkspace with the device mounted: cd, ls, find, cat, head,
// tail, cp, mv across mounts, and ws.fs (move, copy, realpath) work on it.

import assert from 'node:assert/strict';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { syscallError } from '../../packages/core/src/vfs/vfs-error.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Each call's name (`lstat` for a stat that does not follow) and its paths. */
function described(key, args) {
  const name = key === 'stat' && args[1]?.follow === false ? 'lstat' : key;
  const paths = key === 'symlink' ? [args[1]] : key === 'rename' || key === 'copy' ? [args[0], args[1]] : [args[0]];
  return { call: `${name} ${paths.join(' -> ')}`, paths };
}

/**
 * A remote backend over `backing`, async only unless `sync`. `consented`:
 * every path outside it, the ones above it included, is EACCES, as a device
 * answers. `makesParents`: a write makes its missing parents.
 */
function remote(backing, { consented = '/', makesParents = false, sync = false } = {}) {
  const calls = [];
  const inside = (path) => consented === '/' || path === consented || path.startsWith(`${consented}/`);
  const serve = (target, key) => (...args) => {
    const { call, paths } = described(key, args);
    calls.push(call);
    for (const path of paths) {
      if (!inside(path)) throw syscallError('EACCES', key, path, { detail: `outside ${consented}` });
    }
    if (makesParents && (key === 'writeFile' || key === 'writeRange')) {
      backing.mkdir(args[0].slice(0, args[0].lastIndexOf('/')) || '/', { recursive: true });
    }
    return target[key](...args);
  };
  const face = (target, awaited) => new Proxy(target, {
    get(_, key) {
      if (key === 'sync') return sync && awaited ? face(target, false) : undefined;
      const value = target[key];
      if (typeof value !== 'function') return value;
      const run = serve(target, key);
      return awaited ? async (...args) => run(...args) : run;
    },
    has(_, key) { return key === 'sync' ? sync && awaited : key in target; },
  });
  return { vfs: face(backing, true), calls };
}

/** A tree for each backend: the consented directory /home/me with a/b/c.txt in it. */
function tree() {
  const backing = new MemoryVFS();
  backing.mkdir('/home/me/a/b', { recursive: true });
  backing.writeFile('/home/me/a/b/c.txt', enc.encode('hello c\n'));
  backing.symlink('/home/me/a', '/home/me/ln');
  return backing;
}

/** `run`'s answer, after asserting it made exactly `expected` backend calls. */
async function only(backend, expected, label, run) {
  backend.calls.length = 0;
  const out = await run();
  assert.deepEqual(backend.calls, expected, label);
  return out;
}

// ── One call per operation ────────────────────────────────────────────────
{
  const backing = tree();
  const pc = remote(backing, { consented: '/home/me', makesParents: true });
  const root = new MemoryVFS();
  const vfs = new CompositeVFS(root);
  vfs.mount('/pc', pc.vfs, { resolvesPaths: true });

  assert.equal(dec.decode(await only(pc, ['readFile /home/me/a/b/c.txt'], 'readFile',
    () => vfs.readFile('/pc/home/me/a/b/c.txt'))), 'hello c\n');
  assert.equal((await only(pc, ['stat /home/me/a/b/c.txt'], 'stat', () => vfs.stat('/pc/home/me/a/b/c.txt'))).size, 8);
  assert.equal((await only(pc, ['lstat /home/me/ln'], 'lstat', () => vfs.stat('/pc/home/me/ln', { follow: false }))).type, 'symlink');
  assert.deepEqual((await only(pc, ['readdir /home/me/a/b'], 'readdir', () => vfs.readdir('/pc/home/me/a/b'))).map((e) => e.name), ['c.txt']);
  assert.equal(dec.decode(await only(pc, ['readRange /home/me/a/b/c.txt'], 'readRange',
    () => vfs.readRange('/pc/home/me/a/b/c.txt', 6, 10))), 'c\n');
  await only(pc, ['writeFile /home/me/new/deep/x.txt'], 'writeFile makes its parents on the backend',
    () => vfs.writeFile('/pc/home/me/new/deep/x.txt', enc.encode('x')));
  assert.equal(dec.decode(backing.readFile('/home/me/new/deep/x.txt')), 'x');
  await only(pc, ['mkdir /home/me/m/n/o'], 'mkdir -p', () => vfs.mkdir('/pc/home/me/m/n/o', { recursive: true }));
  assert.equal(backing.stat('/home/me/m/n/o')?.type, 'directory');
  await only(pc, ['mkdir /home/me/m/p'], 'mkdir', () => vfs.mkdir('/pc/home/me/m/p'));
  await only(pc, ['rename /home/me/new/deep/x.txt -> /home/me/m/x.txt'], 'rename within the mount',
    () => vfs.rename('/pc/home/me/new/deep/x.txt', '/pc/home/me/m/x.txt'));
  await only(pc, ['unlink /home/me/m/x.txt'], 'unlink', () => vfs.unlink('/pc/home/me/m/x.txt'));
  assert.equal(backing.stat('/home/me/m/x.txt'), null);
  assert.equal(await only(pc, ['stat /home/me/a/b'], 'realpath: one stat, links followed by the backend',
    () => vfs.realpathAsync('/pc/home/me/a/./x/../b')), '/pc/home/me/a/b');
  await only(pc, ['stat /home/me/nope'], 'realpath of a missing name', () =>
    assert.rejects(vfs.realpathAsync('/pc/home/me/nope'), { code: 'ENOENT', syscall: 'realpath', path: '/pc/home/me/nope' }));

  // The backend follows its own links; the namespace reads none of them.
  assert.equal(dec.decode(await only(pc, ['readFile /home/me/ln/b/c.txt'], 'a link inside is the backend\'s',
    () => vfs.readFile('/pc/home/me/ln/b/c.txt'))), 'hello c\n');
  assert.equal(await only(pc, ['stat /home/me/ln'], 'realpath names what the namespace sees', () => vfs.realpathAsync('/pc/home/me/ln')), '/pc/home/me/ln');

  // Ancestors the device will not show stay refused, by the device.
  await only(pc, ['stat /home'], 'stat of an ancestor', () => assert.rejects(vfs.stat('/pc/home'), { code: 'EACCES', path: '/home' }));
  await only(pc, ['readdir /'], 'readdir of the mounted root', () => assert.rejects(vfs.readdir('/pc'), { code: 'EACCES' }));
  // Its missing names are the device's own answer.
  await only(pc, ['readFile /home/me/a/nope/c.txt'], 'a missing component', () =>
    assert.rejects(vfs.readFile('/pc/home/me/a/nope/c.txt'), { code: 'ENOENT' }));
  assert.equal(await only(pc, ['stat /home/me/a/nope'], 'stat of a missing name', () => vfs.stat('/pc/home/me/a/nope')), null);

  // `..` is lexical, and leaves the mount past its root.
  root.writeFile('/top', enc.encode('root'));
  assert.equal(dec.decode(await only(pc, [], '.. out of the mount', () => vfs.readFile('/pc/home/me/../../../top'))), 'root');

  // The way in is the namespace's: a root link into the mount is followed here.
  root.symlink('/pc/home/me', '/me');
  assert.equal(dec.decode(await only(pc, ['readFile /home/me/a/b/c.txt'], 'through a root link',
    () => vfs.readFile('/me/a/b/c.txt'))), 'hello c\n');

  // The synchronous face takes the same one call.
  const syncBacking = tree();
  const sy = remote(syncBacking, { consented: '/home/me', sync: true });
  vfs.mount('/sy', sy.vfs, { resolvesPaths: true });
  sy.calls.length = 0;
  assert.equal(dec.decode(vfs.sync.readFile('/sy/home/me/a/b/c.txt')), 'hello c\n');
  assert.equal(vfs.sync.stat('/sy/home/me/a/b/c.txt')?.size, 8);
  vfs.sync.mkdir('/sy/home/me/q/r', { recursive: true });
  assert.equal(vfs.realpath('/sy/home/me/q/r'), '/sy/home/me/q/r');
  assert.deepEqual(sy.calls, ['readFile /home/me/a/b/c.txt', 'stat /home/me/a/b/c.txt', 'mkdir /home/me/q/r', 'stat /home/me/q/r'],
    'the sync face: one call each');
}

// ── Without the flag: the component walk, as before ─────────────────────────
{
  const open = remote(tree());
  const device = remote(tree(), { consented: '/home/me' });
  const plane = remote(tree(), { makesParents: true });
  const vfs = new CompositeVFS(new MemoryVFS());
  vfs.mount('/open', open.vfs);
  vfs.mount('/pc', device.vfs);
  vfs.mount('/plane', plane.vfs);
  await only(open, ['stat /', 'lstat /home', 'lstat /home/me', 'lstat /home/me/a', 'lstat /home/me/a/b', 'lstat /home/me/a/b/c.txt', 'readFile /home/me/a/b/c.txt'],
    'unflagged: a stat per component, then the read', () => vfs.readFile('/open/home/me/a/b/c.txt'));
  await assert.rejects(vfs.readFile('/pc/home/me/a/b/c.txt'), { code: 'EACCES', path: '/home' }, 'the walk stops at the device\'s refusal');
  await assert.rejects(vfs.writeFile('/plane/new/deep/x.txt', enc.encode('x')), { code: 'ENOENT' }, 'and at the missing parent');
}

// ── What the namespace still owns ───────────────────────────────────────────
{
  const backing = tree();
  const pc = remote(backing, { consented: '/home/me', makesParents: true });
  const root = new MemoryVFS();
  root.mkdir('/home/user', { recursive: true });
  root.writeFile('/home/user/notes.md', enc.encode('notes\n'));
  const vfs = new CompositeVFS(root);
  let connected = true;
  vfs.mount('/pc', () => (connected ? pc.vfs : null), { resolvesPaths: true, absentReason: () => 'no device connected' });
  vfs.mount('/ro', remote(tree()).vfs, { resolvesPaths: true, readOnly: true });

  await only(pc, [], 'a mount point is not renamed', () => assert.rejects(vfs.rename('/pc', '/elsewhere'), { code: 'EBUSY' }));
  await only(pc, [], 'mkdir -p of the mount point has nothing to do', () => vfs.mkdir('/pc', { recursive: true }));
  await assert.rejects(vfs.readFile('/pc'), { code: 'EISDIR' });
  await only(pc, [], 'EXDEV across mounts', () =>
    assert.rejects(vfs.rename('/pc/home/me/a/b/c.txt', '/home/user/c.txt'), { code: 'EXDEV' }));
  await assert.rejects(vfs.writeFile('/ro/home/me/a/b/c.txt', enc.encode('no')), { code: 'EROFS' });
  await assert.rejects(vfs.mkdir('/ro/home/me/z', { recursive: true }), { code: 'EROFS' });

  // Copy across mounts, both ways: the target's parent is the device's to answer for.
  assert.equal(await vfs.copy('/pc/home/me/a/b/c.txt', '/home/user/c.txt'), 1);
  assert.equal(dec.decode(root.readFile('/home/user/c.txt')), 'hello c\n');
  await only(pc, ['lstat /home/me/in/sub/notes.md', 'writeFile /home/me/in/sub/notes.md'], 'copy onto the device: no parent check',
    () => vfs.copy('/home/user/notes.md', '/pc/home/me/in/sub/notes.md'));
  assert.equal(dec.decode(backing.readFile('/home/me/in/sub/notes.md')), 'notes\n');
  assert.equal(await vfs.copy('/pc/home/me/a', '/home/user/a', { recursive: true }), 3);
  assert.deepEqual(root.readdir('/home/user/a').map((e) => e.name), ['b']);

  // A mount nested inside one that resolves its own paths is still crossed here.
  const inner = new MemoryVFS();
  inner.writeFile('/i.txt', enc.encode('inner'));
  vfs.mount('/pc/home/me/inner', inner);
  assert.equal(dec.decode(await vfs.readFile('/pc/home/me/inner/i.txt')), 'inner');
  assert.ok((await vfs.readdir('/pc/home/me')).some((e) => e.name === 'inner'), 'and listed where it is');
  await only(pc, ['mkdir /home/me/x/y'], 'mkdir -p beside a nested mount', () => vfs.mkdir('/pc/home/me/x/y', { recursive: true }));
  vfs.unmount('/pc/home/me/inner');

  connected = false;
  await assert.rejects(vfs.readFile('/pc/home/me/a/b/c.txt'), (error) => error.code === 'ENXIO' && /no device connected/.test(error.message));
  assert.equal(await vfs.stat('/pc/home/me/a/b/c.txt'), null);
  connected = true;
}

// ── A workspace with the device mounted: the shell and ws.fs ────────────────
{
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  const backing = tree();
  const pc = remote(backing, { consented: '/home/me', makesParents: true });
  ws.filesystem.vfs.mount('/pc', pc.vfs, { resolvesPaths: true, absentReason: () => 'no device connected' });

  const run = async (command) => {
    const result = await ws.exec(command);
    assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
    return result.stdout;
  };
  assert.match(await run('ls /'), /\bpc\b/, 'ls / lists the mount point');
  assert.equal(await run('cd /pc/home/me && pwd && ls -1'), '/pc/home/me\na\nln\n', 'cd into the consented directory, past refused ancestors');
  assert.equal(await run('cd /pc/home/me/a/b && cat c.txt'), 'hello c\n');
  assert.equal(await run('cat /pc/home/me/a/b/c.txt'), 'hello c\n');
  assert.equal(await run('head -c 5 /pc/home/me/a/b/c.txt'), 'hello');
  assert.equal(await run('tail -n 1 /pc/home/me/ln/b/c.txt'), 'hello c\n', 'through the device\'s own link');
  assert.match(await run('ls -l /pc/home/me/a/b'), /^-\S+ .* 8 .* c\.txt\n$/m, 'ls -l stats each entry');
  assert.equal(await run('find /pc/home/me/a'), '/pc/home/me/a\n/pc/home/me/a/b\n/pc/home/me/a/b/c.txt\n');
  assert.equal(await run('echo made > /pc/home/me/w/deep/f.txt && cat /pc/home/me/w/deep/f.txt'), 'made\n', 'a write makes its parents on the device');
  assert.equal(await run('mkdir -p /pc/home/me/d/e && cp /pc/home/me/a/b/c.txt /pc/home/me/d/e/ && ls /pc/home/me/d/e'), 'c.txt\n');
  assert.equal(await run('mv /pc/home/me/d/e/c.txt /home/user/c.txt && cat /home/user/c.txt && ls /pc/home/me/d/e'), 'hello c\n', 'mv off the device');
  assert.equal(await run('mv /home/user/c.txt /pc/home/me/d/back.txt && cat /pc/home/me/d/back.txt'), 'hello c\n', 'and back onto it');
  assert.equal(await run('cp -r /pc/home/me/a /home/user/a && cat /home/user/a/b/c.txt'), 'hello c\n');
  assert.equal(await run('rm -r /pc/home/me/d && ls -1 /pc/home/me'), 'a\nln\nw\n');
  const refused = await ws.exec('ls /pc/home');
  assert.notEqual(refused.exitCode, 0, 'an ancestor the device refuses stays refused');

  /** Whether every backend call since `calls` was cleared was on `path` itself. */
  const onlyOn = (calls, path) => calls.length > 0 && calls.every((call) => call.endsWith(` ${path}`));
  pc.calls.length = 0;
  assert.equal(await run('cat /pc/home/me/a/b/c.txt && cat /pc/home/me/a/../a/b/c.txt'), 'hello c\nhello c\n');
  assert.ok(onlyOn(pc.calls, '/home/me/a/b/c.txt'), `cat asks the device of nothing but the file: ${pc.calls.join(', ')}`);

  // A device with a synchronous face is read through the process's
  // synchronous bridge, whose own walk looks up the mount point (the
  // device's root, refused and so made a directory) and nothing past it.
  const sy = remote(tree(), { consented: '/home/me', sync: true });
  ws.filesystem.vfs.mount('/sy', sy.vfs, { resolvesPaths: true });
  assert.equal(await run('cat /sy/home/me/a/b/c.txt && cat /sy/home/me/a/../a/b/c.txt'), 'hello c\nhello c\n');
  assert.ok(onlyOn(sy.calls.filter((call) => call !== 'lstat /' && call !== 'stat /'), '/home/me/a/b/c.txt'),
    `nor does the synchronous bridge: ${sy.calls.join(', ')}`);
  assert.equal(await run('cd /sy/home/me/a && ls ../a/b && cat b/c.txt'), 'c.txt\nhello c\n');

  // ws.fs: the embedder's own calls.
  assert.equal(await ws.fs.readFileString('/pc/home/me/a/b/c.txt'), 'hello c\n');
  await ws.fs.writeFile('/pc/home/me/fs/new.txt', 'from ws.fs');
  assert.equal(dec.decode(backing.readFile('/home/me/fs/new.txt')), 'from ws.fs');
  await ws.fs.move('/pc/home/me/fs/new.txt', '/home/user/moved.txt');
  assert.equal(await ws.fs.readFileString('/home/user/moved.txt'), 'from ws.fs');
  assert.equal(backing.stat('/home/me/fs/new.txt'), null, 'a move across mounts removes the source');
  await ws.fs.move('/home/user/moved.txt', '/pc/home/me/fs/back.txt');
  assert.equal(dec.decode(backing.readFile('/home/me/fs/back.txt')), 'from ws.fs');
  assert.equal(await ws.fs.realpath('/pc/home/me/a/../a/b'), '/pc/home/me/a/b');
}

console.log('composite-resolves-paths: ok');
