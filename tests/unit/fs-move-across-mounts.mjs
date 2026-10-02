#!/usr/bin/env bun
// A move across mounts happens whole or not at all. rename(2) answers EXDEV
// between filesystems (and on one that cannot rename in place), and
// `ws.fs.move` and the shell's `mv` then share one carry (vfs/move.ts): a
// copy staged beside the destination and confirmed, the source removed, and
// one rename of the copy over the destination, which keeps its bytes until
// then. A failure at any step puts the source back and leaves no copy. `mv`
// copied straight onto the destination, so a failure mid-copy left part of
// a tree there, or a destination file already overwritten.
import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { move } from '../../packages/core/src/vfs/move.ts';
import { VfsError } from '../../packages/core/src/vfs/vfs-error.ts';

const USER = { uid: 1000, gid: 1000 };
const text = (bytes) => new TextDecoder().decode(bytes);
const code = (run) => Promise.resolve().then(run).then(() => 'ok', (error) => error.code);
const STAGED = /\.nimbus-move-/;

/** A mounted volume that fails where it is told to, and lets a test watch each call. */
class Faulty extends MemoryVFS {
  constructor() { super(USER); this.faults = []; this.watch = null; }
  fault(op, match, { code = 'EIO', once = false } = {}) { this.faults.push({ op, match, code, once }); }
  at(op, path) {
    this.watch?.(op, path);
    const index = this.faults.findIndex((f) => f.op === op && f.match.test(path));
    if (index < 0) return;
    const { code, once } = this.faults[index];
    if (once) this.faults.splice(index, 1);
    throw new VfsError(code, 'injected failure', path);
  }
  writeFile(path, data, options) { this.at('writeFile', path); return super.writeFile(path, data, options); }
  writeRange(path, offset, bytes) { this.at('writeRange', path); return super.writeRange(path, offset, bytes); }
  truncate(path, size) { this.at('truncate', path); return super.truncate(path, size); }
  mkdir(path, options) { this.at('mkdir', path); return super.mkdir(path, options); }
  unlink(path) { this.at('unlink', path); return super.unlink(path); }
  removeRecursive(path) { this.at('removeRecursive', path); return super.removeRecursive(path); }
  rename(from, to) { this.at('rename', from); return super.rename(from, to); }
}
/** One that cannot rename in place (a device, a container), so even a move within it is a carry. */
class NoRename extends Faulty { rename = undefined; }
/** One that removes a tree only by walking it. */
class Walked extends Faulty { removeRecursive = undefined; }

const m = new Faulty();
const dev = new NoRename();
const walked = new Walked();
const box = await testBox({ cwd: '/home/user', mounts: { '/m': m, '/dev2': dev, '/walked': walked } });
const { workspace: ws } = box;
const ns = box.files.vfs.sync;
const read = (path) => text(ns.readFile(path));
const leftovers = (dir) => ns.readdir(dir).map((e) => e.name).filter((name) => STAGED.test(name));
const tree = async (base) => {
  await ws.fs.mkdir(`${base}/sub`, { recursive: true });
  await ws.fs.mkdir(`${base}/empty`);
  await ws.fs.writeFile(`${base}/a.txt`, 'a');
  await ws.fs.writeFile(`${base}/sub/b.txt`, 'b');
  await ws.fs.symlink('a.txt', `${base}/link`);
};
const assertTree = (base, what) => {
  assert.equal(read(`${base}/a.txt`), 'a', `${what}: a.txt`);
  assert.equal(read(`${base}/sub/b.txt`), 'b', `${what}: sub/b.txt`);
  assert.equal(ns.readlink(`${base}/link`), 'a.txt', `${what}: the link is a link`);
  assert.equal(ns.stat(`${base}/empty`).type, 'directory', `${what}: an empty directory`);
};

// ── rename keeps POSIX: EXDEV across mounts, nothing moved ──────────────
await ws.fs.writeFile('stay.txt', 'stay');
assert.equal(await code(() => ws.fs.rename('stay.txt', '/m/stay.txt')), 'EXDEV');
assert.equal(read('/home/user/stay.txt'), 'stay');
assert.equal(ns.stat('/m/stay.txt'), null);

// ── A file, and a tree, between SQLite and a mount, both ways ───────────
await ws.fs.writeFile('f.txt', 'file', { mode: 0o640 });
await ws.fs.move('f.txt', '/m/f.txt');
assert.equal(read('/m/f.txt'), 'file');
assert.equal(ns.stat('/m/f.txt').mode & 0o777, 0o640, 'the mode moved with it');
assert.equal(ns.stat('/home/user/f.txt'), null, 'the source is gone');

await tree('/home/user/t');
await ws.fs.move('t', '/m/t');
assertTree('/m/t', 'into a mount');
assert.equal(ns.stat('/home/user/t'), null);
await ws.fs.move('/m/t', 'back');
assertTree('/home/user/back', 'out of a mount');
assert.equal(ns.stat('/m/t'), null);
assert.deepEqual([...leftovers('/m'), ...leftovers('/home/user')], [], 'no staged copy is left');

// Within one filesystem a move is one rename: the same inode, nothing copied.
const before = await ws.fs.stat('back', { follow: false });
await ws.fs.move('back', 'renamed');
assert.equal((await ws.fs.stat('renamed', { follow: false })).ino, before.ino);
await ws.fs.remove('renamed', { recursive: true });

// rename(2)'s refusals, made where the filesystems never got to make them.
await ws.fs.mkdir('/m/full/x', { recursive: true });
await ws.fs.mkdir('/m/hollow');
await ws.fs.writeFile('/m/plain.txt', 'p');
await tree('/home/user/r');
assert.equal(await code(() => ws.fs.move('r', '/m/full')), 'ENOTEMPTY');
assert.equal(await code(() => ws.fs.move('r', '/m/plain.txt')), 'ENOTDIR');
assert.equal(await code(() => ws.fs.move('r/a.txt', '/m/hollow')), 'EISDIR');
assert.equal(await code(() => ws.fs.move('r', '/m/nowhere/r')), 'ENOENT');
assert.equal(await code(() => ws.fs.move('missing', '/m/missing')), 'ENOENT');
assertTree('/home/user/r', 'refused');
// A directory replaces an empty one, as rename(2) has it.
await ws.fs.move('r', '/m/hollow');
assertTree('/m/hollow', 'onto an empty directory');

// ── The destination keeps its bytes until the move lands ───────────────
await ws.fs.writeFile('/m/dest.txt', 'OLD');
await ws.fs.writeFile('new.txt', 'NEW');
const seen = [];
m.watch = (op, path) => {
  if (STAGED.test(path) || (op === 'rename' && path !== '/dest.txt')) seen.push(`${op}: ${text(m.readFile('/dest.txt'))}`);
};
await ws.fs.move('new.txt', '/m/dest.txt');
m.watch = null;
assert.ok(seen.length >= 2, `the move was watched: ${seen}`);
assert.deepEqual([...new Set(seen.map((s) => s.split(': ')[1]))], ['OLD'], `while the copy is staged, the destination holds what it held: ${seen}`);
assert.equal(read('/m/dest.txt'), 'NEW', 'then the move lands');

// ── A failure at any step: the source intact, no copy, the destination as it was ─
const nothingMoved = async (what, run, { source, destination, check }) => {
  const result = await code(run);
  assert.notEqual(result, 'ok', `${what}: the move fails`);
  check();
  assert.deepEqual([...leftovers(source), ...leftovers(destination)], [], `${what}: no staged copy is left`);
  return result;
};

// Mid-copy, a tree onto an empty directory.
await ws.fs.mkdir('big/sub', { recursive: true });
for (const name of ['1.txt', '2.txt', '3.txt', 'sub/4.txt']) await ws.fs.writeFile(`big/${name}`, name);
await ws.fs.mkdir('/m/big');
m.fault('writeFile', /\/2\.txt$/);
assert.equal(await nothingMoved('mid-copy', () => ws.fs.move('big', '/m/big'), {
  source: '/home/user', destination: '/m',
  check() {
    for (const name of ['1.txt', '2.txt', '3.txt', 'sub/4.txt']) assert.equal(read(`/home/user/big/${name}`), name, 'mid-copy: the source is intact');
    assert.deepEqual(ns.readdir('/m/big'), [], 'mid-copy: the destination is still an empty directory');
  },
}), 'EIO');
m.faults.length = 0;

// Mid-copy, a file onto a file.
await ws.fs.writeFile('/m/kept.txt', 'OLD');
await ws.fs.writeFile('incoming.txt', 'NEW');
m.fault('writeFile', STAGED, { once: true });
await nothingMoved('a file mid-copy', () => ws.fs.move('incoming.txt', '/m/kept.txt'), {
  source: '/home/user', destination: '/m',
  check() {
    assert.equal(read('/m/kept.txt'), 'OLD', 'the destination keeps its bytes');
    assert.equal(read('/home/user/incoming.txt'), 'NEW');
  },
});

// The source's removal: refused whole by the mount, and refused for one
// entry by a mount that walks a tree (part of the source already gone).
await tree('/m/src');
m.fault('removeRecursive', /^\/src$/, { code: 'EACCES' });
assert.equal(await nothingMoved('the source refuses to go', () => ws.fs.move('/m/src', 'out'), {
  source: '/m', destination: '/home/user',
  check() { assertTree('/m/src', 'the source refuses to go'); assert.equal(ns.stat('/home/user/out'), null); },
}), 'EACCES');
m.faults.length = 0;

await tree('/walked/src');
walked.fault('unlink', /\/sub\/b\.txt$/, { code: 'EACCES' });
await nothingMoved('part of the source goes', () => ws.fs.move('/walked/src', 'out'), {
  source: '/walked', destination: '/home/user',
  check() { assertTree('/walked/src', 'part of the source goes'); assert.equal(ns.stat('/home/user/out'), null); },
});
walked.faults.length = 0;

// The final rename over the destination.
await ws.fs.writeFile('/m/last.txt', 'OLD');
await ws.fs.writeFile('last.txt', 'NEW', { mode: 0o600 });
m.fault('rename', STAGED);
assert.equal(await nothingMoved('the last rename', () => ws.fs.move('last.txt', '/m/last.txt'), {
  source: '/home/user', destination: '/m',
  check() {
    assert.equal(read('/m/last.txt'), 'OLD');
    assert.equal(read('/home/user/last.txt'), 'NEW', 'the source is back');
    assert.equal(ns.stat('/home/user/last.txt').mode & 0o777, 0o600, 'with its mode');
  },
}), 'EIO');
m.faults.length = 0;

// ── A filesystem that cannot rename in place: written over where it is ──
await ws.fs.writeFile('/dev2/dest.txt', 'OLD');
await ws.fs.writeFile('to-dev.txt', 'NEW');
await ws.fs.move('to-dev.txt', '/dev2/dest.txt');
assert.equal(read('/dev2/dest.txt'), 'NEW');
await ws.fs.move('/dev2/dest.txt', '/dev2/within.txt');
assert.equal(read('/dev2/within.txt'), 'NEW', 'a move within it');
assert.equal(ns.stat('/dev2/dest.txt'), null);
await tree('/home/user/dt');
await ws.fs.move('dt', '/dev2/dt');
assertTree('/dev2/dt', 'a tree onto a filesystem without rename');
await ws.fs.writeFile('/dev2/held.txt', 'OLD');
await ws.fs.writeFile('to-held.txt', 'NEW');
dev.fault('writeFile', /^\/held\.txt$/, { once: true });
await nothingMoved('writing over in place', () => ws.fs.move('to-held.txt', '/dev2/held.txt'), {
  source: '/home/user', destination: '/dev2',
  check() { assert.equal(read('/dev2/held.txt'), 'OLD', 'what it held is put back'); assert.equal(read('/home/user/to-held.txt'), 'NEW'); },
});
assert.deepEqual(dev.faults, [], 'the injected failure was met');
// Where putting the destination back fails too, the answer is EIO naming
// both, and the source is still put back.
await ws.fs.writeFile('/dev2/stuck.txt', 'OLD');
await ws.fs.writeFile('to-stuck.txt', 'NEW');
for (const op of ['writeFile', 'writeRange', 'truncate']) dev.fault(op, /^\/stuck\.txt$/);
const stuck = await ws.fs.move('to-stuck.txt', '/dev2/stuck.txt').then(() => null, (error) => error);
assert.equal(stuck?.code, 'EIO');
assert.match(stuck.message, /the move failed \(EIO: injected failure.*\) and undoing it failed \(EIO: injected failure/);
assert.equal(read('/home/user/to-stuck.txt'), 'NEW', 'the source is put back');
assert.equal(read('/dev2/stuck.txt'), 'OLD');
assert.deepEqual([...leftovers('/dev2'), ...leftovers('/home/user')], []);
dev.faults.length = 0;

// ── The shell's mv is the same move ──────────────────────────────────────
await ws.fs.mkdir('mvtree/sub', { recursive: true });
for (const name of ['1.txt', '2.txt', 'sub/3.txt']) await ws.fs.writeFile(`mvtree/${name}`, name);
m.fault('writeFile', /\/2\.txt$/);
const failed = await ws.exec('mv /home/user/mvtree /m/mvtree');
assert.equal(failed.exitCode, 1);
assert.match(failed.stderr, /^mv: EIO: injected failure/);
assert.equal(ns.stat('/m/mvtree'), null, 'mv leaves no part of a tree behind');
assert.deepEqual(leftovers('/m'), []);
for (const name of ['1.txt', '2.txt', 'sub/3.txt']) assert.equal(read(`/home/user/mvtree/${name}`), name);
m.faults.length = 0;
const moved = await ws.exec('mv /home/user/mvtree /m/mvtree && ls -1 /m/mvtree');
assert.equal(moved.exitCode, 0, moved.stderr);
assert.equal(moved.stdout, '1.txt\n2.txt\nsub\n');

// ── Over any VFS, as an embedder calls it (no namespace, no rename) ─────
const plane = new NoRename();
plane.mkdir('/docs/inner', { recursive: true });
plane.writeFile('/docs/inner/x.md', new TextEncoder().encode('x'));
plane.writeFile('/note.md', new TextEncoder().encode('NEW'));
plane.writeFile('/kept.md', new TextEncoder().encode('OLD'));
await move(plane, '/docs', '/archive');
assert.equal(text(plane.readFile('/archive/inner/x.md')), 'x');
assert.equal(plane.stat('/docs'), null);
plane.fault('writeFile', /^\/kept\.md$/, { once: true });
assert.equal(await code(() => move(plane, '/note.md', '/kept.md')), 'EIO');
assert.equal(text(plane.readFile('/kept.md')), 'OLD');
assert.equal(text(plane.readFile('/note.md')), 'NEW');
await move(plane, '/note.md', '/kept.md');
assert.equal(text(plane.readFile('/kept.md')), 'NEW');
assert.equal(plane.stat('/note.md'), null);
assert.deepEqual(plane.readdir('/').map((e) => e.name).filter((n) => STAGED.test(n)), []);

box.destroy();
console.log('fs-move-across-mounts: ok');
