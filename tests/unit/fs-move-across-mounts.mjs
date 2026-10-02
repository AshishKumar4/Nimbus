#!/usr/bin/env bun
// A move across mounts happens whole or not at all. rename(2) answers EXDEV
// between filesystems (and on one that cannot rename in place), and
// `ws.fs.move` and the shell's `mv` then share one carry (vfs/move.ts): a
// copy staged beside the destination and confirmed, the source removed, and
// one rename of the copy over the destination, which keeps its bytes until
// then. A failure before that rename puts the source back and leaves no
// copy; the rename's own answer says whether it did: a refusal changed
// nothing, a filesystem saying it renamed all of it has moved it, and
// anything else is EIO with nothing undone. `mv` copied straight onto the
// destination, so a failure mid-copy left part of a tree there, or a
// destination file already overwritten.
import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { move } from '../../packages/core/src/vfs/move.ts';
import { renameOutcome, VfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000 };
const text = (bytes) => new TextDecoder().decode(bytes);
const code = (run) => Promise.resolve().then(run).then(() => 'ok', (error) => error.code);
const STAGED = /\.nimbus-move-/;

/** A mounted volume that fails where it is told to, and lets a test watch each call. */
class Faulty extends MemoryVFS {
  constructor() { super(USER); this.faults = []; this.watch = null; }
  /** `after`: the call changes the volume, then fails. */
  fault(op, match, { code = 'EIO', once = false, after = false } = {}) { this.faults.push({ op, match, code, once, after }); }
  at(op, path, after = false) {
    if (!after) this.watch?.(op, path);
    const index = this.faults.findIndex((f) => f.op === op && f.after === after && f.match.test(path));
    if (index < 0) return;
    const { code, once } = this.faults[index];
    if (once) this.faults.splice(index, 1);
    throw new VfsError(code, 'injected failure', path);
  }
  call(op, path, run) { this.at(op, path); const result = run(); this.at(op, path, true); return result; }
  writeFile(path, data, options) { return this.call('writeFile', path, () => super.writeFile(path, data, options)); }
  writeRange(path, offset, bytes) { return this.call('writeRange', path, () => super.writeRange(path, offset, bytes)); }
  truncate(path, size) { return this.call('truncate', path, () => super.truncate(path, size)); }
  mkdir(path, options) { return this.call('mkdir', path, () => super.mkdir(path, options)); }
  unlink(path) { return this.call('unlink', path, () => super.unlink(path)); }
  removeRecursive(path) { return this.call('removeRecursive', path, () => super.removeRecursive(path)); }
  rename(from, to) { return this.call('rename', from, () => super.rename(from, to)); }
}
/** One that cannot rename in place (a device, a container), so even a move within it is a carry. */
class NoRename extends Faulty { rename = undefined; }
/** One that removes a tree only by walking it. */
class Walked extends Faulty { removeRecursive = undefined; }
/** Neither: a move into it writes in place, and its staged copy goes entry by entry. */
class Bare extends Faulty { rename = undefined; removeRecursive = undefined; }
/** One whose rename of a staged copy is made, and then fails anyway. */
class AppliesThenThrows extends MemoryVFS {
  rename(from, to) {
    super.rename(from, to);
    if (STAGED.test(from)) throw new VfsError('EIO', 'renamed, then failed', from);
  }
}
/** One whose failed rename of a staged copy loses it. */
class LosesIt extends MemoryVFS {
  rename(from, to) {
    if (!STAGED.test(from)) return super.rename(from, to);
    super.removeRecursive(from);
    throw new VfsError('EIO', 'lost it', from);
  }
}

const m = new Faulty();
const dev = new NoRename();
const walked = new Walked();
const bare = new Bare();
const harness = createSqliteVfsTestHarness();
const box = await testBox({
  harness, cwd: '/home/user',
  mounts: { '/m': m, '/dev2': dev, '/walked': walked, '/bare': bare, '/applies': new AppliesThenThrows(USER), '/loses': new LosesIt(USER) },
});
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

// The final rename over the destination, refused: nothing changed, so the
// source is back and the refusal is the answer.
await ws.fs.writeFile('/m/last.txt', 'OLD');
await ws.fs.writeFile('last.txt', 'NEW', { mode: 0o600 });
m.fault('rename', STAGED, { code: 'EACCES' });
assert.equal(await nothingMoved('the last rename, refused', () => ws.fs.move('last.txt', '/m/last.txt'), {
  source: '/home/user', destination: '/m',
  check() {
    assert.equal(read('/m/last.txt'), 'OLD');
    assert.equal(read('/home/user/last.txt'), 'NEW', 'the source is back');
    assert.equal(ns.stat('/home/user/last.txt').mode & 0o777, 0o600, 'with its mode');
  },
}), 'EACCES');
m.faults.length = 0;
// Failed with EIO, which may come after part of a rename: nothing is undone
// or removed, and the answer says where what was moving is.
m.fault('rename', STAGED);
const unsure = await ws.fs.move('last.txt', '/m/last.txt').then(() => null, (error) => error);
m.faults.length = 0;
assert.equal(unsure?.code, 'EIO');
const [unsureStage] = leftovers('/m');
assert.ok(unsureStage, 'the staged copy is kept');
assert.match(unsure.message, new RegExp(`renaming /m/${unsureStage} to /m/last\\.txt failed \\(EIO: injected failure.*\\), and may have been done in whole or in part, so nothing was undone or removed: /home/user/last\\.txt is gone, and what was moving is at /m/${unsureStage}, at /m/last\\.txt, or partly at each`));
assert.equal(read(`/m/${unsureStage}`), 'NEW', 'what was moving is where it says');
assert.equal(read('/m/last.txt'), 'OLD', 'and the destination is as the filesystem left it');
assert.equal(ns.stat('/home/user/last.txt'), null);
await ws.fs.remove(`/m/${unsureStage}`);

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
// A write over the destination that lands and then fails: what it held is put back.
await ws.fs.writeFile('/dev2/landed.txt', 'OLD');
await ws.fs.writeFile('to-landed.txt', 'NEW');
dev.fault('writeFile', /^\/landed\.txt$/, { once: true, after: true });
await nothingMoved('a write over the destination that lands, then fails', () => ws.fs.move('to-landed.txt', '/dev2/landed.txt'), {
  source: '/home/user', destination: '/dev2',
  check() { assert.equal(read('/dev2/landed.txt'), 'OLD', 'the bytes it held are back'); assert.equal(read('/home/user/to-landed.txt'), 'NEW'); },
});
assert.deepEqual(dev.faults, []);
// The staged copy refuses to go once the destination holds the whole copy:
// the move has happened, and is never rolled back over a destination
// another writer may since have used. EIO says so, and where the residue is.
await tree('/home/user/bt');
bare.fault('unlink', /\.nimbus-move-[^/]+\/sub\/b\.txt$/, { once: true });
const residue = await ws.fs.move('bt', '/bare/bt').then(() => null, (error) => error);
assert.equal(residue?.code, 'EIO');
assert.match(residue.message, /moved to \/bare\/bt, but what was left at \/bare\/\.nimbus-move-[^ ]+ could not be removed \(EIO: injected failure/);
assertTree('/bare/bt', 'the staged copy goes only in part');
assert.equal(ns.stat('/home/user/bt'), null);
assert.deepEqual(bare.faults, []);
for (const name of leftovers('/bare')) await ws.fs.remove(`/bare/${name}`, { recursive: true });

// Where putting the destination back fails too, the answer is EIO naming
// both and saying so, and the source is still put back.
await ws.fs.writeFile('/dev2/stuck.txt', 'OLD');
await ws.fs.writeFile('to-stuck.txt', 'NEW');
for (const op of ['writeFile', 'writeRange', 'truncate']) dev.fault(op, /^\/stuck\.txt$/);
const stuck = await ws.fs.move('to-stuck.txt', '/dev2/stuck.txt').then(() => null, (error) => error);
assert.equal(stuck?.code, 'EIO');
assert.match(stuck.message, /the move failed \(EIO: injected failure.*\) and undoing it failed \(EIO: injected failure.*\); \/dev2\/stuck\.txt could not be put back as it was/);
assert.equal(read('/home/user/to-stuck.txt'), 'NEW', 'the source is put back');
assert.deepEqual([...leftovers('/dev2'), ...leftovers('/home/user')], []);
dev.faults.length = 0;

// ── Spelled through itself, but not beneath itself ──────────────────────
// On a filesystem with no rename in place, so the carry makes rename(2)'s
// refusals: it takes both names where the walk reaches them.
await tree('/dev2/src');
await ws.fs.move('/dev2/src', '/dev2/src/../dst');
assertTree('/dev2/dst', 'out through ..');
assert.equal(ns.stat('/dev2/src'), null);
await tree('/dev2/src2');
await ws.fs.mkdir('/dev2/elsewhere');
await ws.fs.symlink('/dev2/elsewhere', '/dev2/src2/out');
await ws.fs.move('/dev2/src2', '/dev2/src2/out/dst');
assertTree('/dev2/elsewhere/dst', 'through a link in itself to elsewhere');
assert.equal(ns.stat('/dev2/src2', { follow: false }), null);
await tree('/dev2/src3');
assert.equal(await code(() => ws.fs.move('/dev2/src3', '/dev2/src3/sub/inner')), 'EINVAL', 'beneath itself');
await ws.fs.symlink('/dev2/src3/sub', '/dev2/into');
assert.equal(await code(() => ws.fs.move('/dev2/src3', '/dev2/into/inner')), 'EINVAL', 'beneath itself through a link');
assertTree('/dev2/src3', 'refused');

const atStatement = (match) => {
  let armed = true;
  harness.setFaultInjector((statement) => {
    if (!armed || !match(statement)) return null;
    armed = false;
    return new Error('injected SQL fault');
  });
};
const publishing = (key) => (statement) => statement.sql.startsWith('INSERT OR REPLACE INTO vfs_inodes') && statement.params.includes(key);
const retiringStaged = (statement) => statement.sql.startsWith('DELETE FROM vfs_inodes') && statement.params.some((p) => STAGED.test(String(p)));

// ── A final rename that publishes the copy and then fails ───────────────
// SqliteVFS moves a tree in bounded steps: the destination is published,
// then the old name retired. A failure in the second step has moved the
// whole copy, and it says so: the move has happened and the residue goes.
const retiring = (once) => {
  let armed = true;
  harness.setFaultInjector((statement) => {
    if (!armed || !statement.sql.startsWith('DELETE FROM vfs_inodes') || !statement.params.some((p) => STAGED.test(String(p)))) return null;
    if (once) armed = false;
    return new Error('injected retirement failure');
  });
};
await tree('/m/pub');
retiring(true);
await ws.fs.move('/m/pub', 'published');
harness.clearFault();
assertTree('/home/user/published', 'published, then the retirement failed');
assert.equal(ns.stat('/m/pub'), null);
assert.deepEqual(leftovers('/home/user'), [], 'the staged remainder went');
// When the remainder cannot go either, the move has still happened, and the error says so.
await tree('/m/pub2');
retiring(false);
const remainder = await ws.fs.move('/m/pub2', 'published2').then(() => null, (error) => error);
harness.clearFault();
assert.equal(remainder?.code, 'EIO');
assert.match(remainder.message, /^EIO: moved to \/home\/user\/published2, but what was left at \/home\/user\/\.nimbus-move-[^ ]+ could not be removed/);
assertTree('/home/user/published2', 'moved, with a remainder');
for (const name of leftovers('/home/user')) await ws.fs.remove(name, { recursive: true });

// ── Each kind of entry, with the final rename failing at each step ──────
// SqliteVFS says what its rename did. Publication failing has renamed
// nothing: the source is back and the destination as it was. Retirement
// failing has renamed all of it: the move happened.
const kinds = {
  file: { make: (at) => ws.fs.writeFile(at, 'NEW'), old: (at) => ws.fs.writeFile(at, 'OLD'), moved: (at) => read(at) === 'NEW', kept: (at) => read(at) === 'OLD' },
  symlink: { make: (at) => ws.fs.symlink('new-target', at), old: (at) => ws.fs.symlink('old-target', at), moved: (at) => ns.readlink(at) === 'new-target', kept: (at) => ns.readlink(at) === 'old-target' },
  tree: { make: tree, old: (at) => ws.fs.mkdir(at), moved: (at) => { assertTree(at, 'a tree'); return true; }, kept: (at) => ns.readdir(at).length === 0 },
};
for (const [kind, k] of Object.entries(kinds)) {
  await k.make(`/m/${kind}-p`);
  await k.old(`/home/user/${kind}-p`);
  atStatement(publishing(`home/user/${kind}-p`));
  const failed = await code(() => ws.fs.move(`/m/${kind}-p`, `${kind}-p`));
  harness.clearFault();
  assert.notEqual(failed, 'ok', `${kind}: publication fails, so the move does`);
  assert.ok(k.moved(`/m/${kind}-p`), `${kind}: the source is back`);
  assert.ok(k.kept(`/home/user/${kind}-p`), `${kind}: the destination is as it was`);
  assert.deepEqual([...leftovers('/home/user'), ...leftovers('/m')], [], `${kind}: no staged copy is left`);

  await k.make(`/m/${kind}-r`);
  await k.old(`/home/user/${kind}-r`);
  atStatement(retiringStaged);
  await ws.fs.move(`/m/${kind}-r`, `${kind}-r`);
  harness.clearFault();
  assert.ok(k.moved(`/home/user/${kind}-r`), `${kind}: retirement failed after the copy was published, so it moved`);
  assert.equal(ns.stat(`/m/${kind}-r`, { follow: false }), null, `${kind}: the source is gone`);
  assert.deepEqual(leftovers('/home/user'), [], `${kind}: and the staged remainder`);
}

// ── A backend that makes a rename and still fails it, or loses what it renamed ─
// Neither says what it did, so nothing is undone and nothing is removed,
// whatever the names then hold: another writer may have used them since.
await ws.fs.writeFile('/applies/dest.txt', 'OLD');
await ws.fs.writeFile('applied.txt', 'NEW');
const applied = await ws.fs.move('applied.txt', '/applies/dest.txt').then(() => null, (error) => error);
assert.equal(applied?.code, 'EIO');
assert.match(applied.message, /what was moving is at \/applies\/\.nimbus-move-[^,]+, at \/applies\/dest\.txt, or partly at each/);
assert.equal(read('/applies/dest.txt'), 'NEW', 'the rename was made, and is left as it is');
assert.equal(ns.stat('/home/user/applied.txt'), null);
await tree('/home/user/at');
assert.equal(await code(() => ws.fs.move('at', '/applies/at')), 'EIO');
assertTree('/applies/at', 'a tree the rename was made for, left as it is');

await ws.fs.writeFile('/loses/dest.txt', 'OLD');
await ws.fs.writeFile('lost.txt', 'NEW');
const lost = await ws.fs.move('lost.txt', '/loses/dest.txt').then(() => null, (error) => error);
assert.equal(lost?.code, 'EIO', 'never a silent success, and never undone from a copy that is not there');
assert.match(lost.message, /\(EIO: lost it.*\), and may have been done in whole or in part, so nothing was undone or removed: \/home\/user\/lost\.txt is gone/);
assert.equal(read('/loses/dest.txt'), 'OLD', 'what is there is left as it is');

// ── A refusal of a destination that holds the same bytes ────────────────
// Sticky /tmp: uid 1000 may not replace uid 1001's file. That the file holds
// what is moving says nothing about whether the rename was made; the
// refusal does: EPERM, the source back, nothing left, and the destination
// never read.
const reading = (target, reads) => new Proxy(target, {
  get(view, name) {
    const value = Reflect.get(view, name, view);
    if (typeof value !== 'function') return value;
    if (!['readFile', 'readRange', 'readdir'].includes(name)) return value.bind(view);
    return (path, ...rest) => { reads.push(path); return value.call(view, path, ...rest); };
  },
});
const theirs = box.files.view({ pid: 4243, cred: { uid: 1001, gid: 1001, groups: [1001], umask: 0o022 } });
box.root.chown('tmp', 0, 0);
box.root.chmod('tmp', 0o1777);
await theirs.writeFile('/tmp/same.txt', 'same bytes');
await ws.fs.writeFile('/m/same.txt', 'same bytes');
const sameReads = [];
const refusal = await move(reading(ws.shell.getVfs(), sameReads), '/m/same.txt', '/tmp/same.txt').then(() => null, (error) => error);
assert.equal(refusal?.code, 'EPERM', 'the refusal is the answer');
assert.equal(read('/m/same.txt'), 'same bytes', 'the source is back');
assert.equal(ns.stat('/tmp/same.txt').uid, 1001, 'their file is theirs');
assert.deepEqual(leftovers('/tmp'), []);
assert.deepEqual(sameReads.filter((path) => path === '/tmp/same.txt'), [], 'the destination is never read');

// ── Published whole, then another writer, then the residue goes ─────────
// SQLite's tree rename says it published all of it before the retirement of
// the staged name failed. Between that failure and the move settling it,
// another process writes into the destination. The move has happened: the
// residue goes, and the other writer's file stays.
const concurrentReads = [];
const raced = new Proxy(reading(ws.shell.getVfs(), concurrentReads), {
  get(view, name) {
    const value = Reflect.get(view, name, view);
    if (name !== 'rename') return typeof value === 'function' ? value.bind(view) : value;
    return async (from, to) => {
      try {
        return await value.call(view, from, to);
      } catch (error) {
        if (STAGED.test(from)) await theirs.writeFile(`${to}/concurrent.txt`, 'CONCURRENT');
        throw error;
      }
    };
  },
});
await tree('/m/raced');
await ws.fs.chmod('/m/raced', 0o777);
atStatement(retiringStaged);
await move(raced, '/m/raced', '/home/user/raced');
harness.clearFault();
assertTree('/home/user/raced', 'published whole');
assert.equal(read('/home/user/raced/concurrent.txt'), 'CONCURRENT', 'the other writer\'s file stays');
assert.equal(ns.stat('/m/raced'), null);
assert.deepEqual(leftovers('/home/user'), [], 'the residue went');
assert.deepEqual(concurrentReads.filter((path) => path.startsWith('/home/user/raced')), [], 'the destination is never read');

// ── What it copies is private until it is complete ──────────────────────
// Another user must not read a copy its source would not let them, at any
// moment. Each entry is checked at the first call the move makes on it
// after making it (its times, set before its mode), on SQLite: it enforces
// a file's mode on reads, where a mounted MemoryVFS has one principal.
const other = box.files.view({ pid: 4242, cred: { uid: 1001, gid: 1001, groups: [1001], umask: 0o022 } });
const exposed = [];
const watched = new Proxy(ws.shell.getVfs(), {
  get(target, name) {
    const value = Reflect.get(target, name, target);
    if (typeof value !== 'function') return value;
    if (name !== 'utimes') return value.bind(target);
    return async (path, ...rest) => {
      if (!path.startsWith('/tmp/')) return await target.utimes(path, ...rest);
      const stat = await target.stat(path, { follow: false });
      const read = stat?.type === 'directory' ? () => other.readdir(path) : () => other.readFile(path);
      if (await read().then(() => true, () => false)) exposed.push(path);
      return await target.utimes(path, ...rest);
    };
  },
});
await ws.fs.writeFile('/m/secret.txt', 'secret');
await ws.fs.chmod('/m/secret.txt', 0o600);
await ws.fs.mkdir('/m/open-tree');
await ws.fs.chmod('/m/open-tree', 0o755);
await ws.fs.writeFile('/m/open-tree/secret.txt', 'secret');
await ws.fs.chmod('/m/open-tree/secret.txt', 0o600);
await ws.fs.writeFile('/m/open-tree/public.txt', 'public');
await ws.fs.chmod('/m/open-tree/public.txt', 0o644);
await move(watched, '/m/secret.txt', '/tmp/secret.txt');
await move(watched, '/m/open-tree', '/tmp/open-tree');
// A source on SQLite put back after a failed move is made the same way.
await ws.fs.writeFile('/tmp/kept-secret.txt', 'secret');
await ws.fs.chmod('/tmp/kept-secret.txt', 0o600);
m.fault('rename', STAGED, { once: true, code: 'EACCES' });
assert.equal(await code(() => move(watched, '/tmp/kept-secret.txt', '/m/kept-secret.txt')), 'EACCES');
assert.equal(read('/tmp/kept-secret.txt'), 'secret', 'the source is back');
assert.deepEqual(exposed, [], 'no copy was readable by another user before it was complete');
assert.equal(await code(() => other.readFile('/tmp/secret.txt')), 'EACCES', 'nor after: it has its own mode');
assert.equal(ns.stat('/tmp/secret.txt').mode & 0o777, 0o600);
assert.equal(await code(() => other.readFile('/tmp/open-tree/secret.txt')), 'EACCES');
assert.equal(await other.readFileString('/tmp/open-tree/public.txt'), 'public', 'and what the source let others read, they can');
assert.equal(ns.stat('/tmp/open-tree').mode & 0o777, 0o755);
assert.equal(await code(() => other.readFile('/tmp/kept-secret.txt')), 'EACCES');
assert.equal(ns.stat('/tmp/kept-secret.txt').mode & 0o777, 0o600);
// A file made on a mount is made at the mode it was asked for, as on SQLite.
await ws.fs.writeFile('/m/made.txt', 'x', { mode: 0o600 });
assert.equal(ns.stat('/m/made.txt').mode & 0o777, 0o600, 'open(O_CREAT, mode) on a mount makes the file at that mode');

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
// Beneath itself through a link, on a VFS with no realpath: refused before anything is copied.
plane.symlink('/archive/inner', '/into');
assert.equal(await code(() => move(plane, '/archive', '/into/again')), 'EINVAL');
assert.deepEqual(plane.readdir('/archive/inner').map((e) => e.name), ['x.md']);

/**
 * A VFS whose rename between two of its trees is EXDEV, and whose final
 * rename makes the rename, leaves a residue at the staged name, and fails:
 * saying it renamed it all, or saying nothing.
 */
class Torn extends MemoryVFS {
  constructor() { super(USER); this.tear = null; }
  rename(from, to) {
    if (from.startsWith('/src')) throw new VfsError('EXDEV', 'another filesystem', from);
    if (this.tear === null || !STAGED.test(from)) return super.rename(from, to);
    const tear = this.tear;
    this.tear = null;
    super.rename(from, to);
    this.mkdir(from);
    throw Object.assign(new VfsError('EIO', 'injected tear', from), tear === 'reported' ? { renamed: 'all' } : {});
  }
}
const torn = new Torn();
const seed = (base) => {
  torn.mkdir(`${base}/sub`, { recursive: true });
  torn.writeFile(`${base}/a.txt`, new TextEncoder().encode('a'));
  torn.writeFile(`${base}/sub/b.txt`, new TextEncoder().encode('b'));
};
torn.mkdir('/dst');
seed('/src/reported');
torn.tear = 'reported';
await move(torn, '/src/reported', '/dst/reported');
assert.equal(text(torn.readFile('/dst/reported/sub/b.txt')), 'b', 'a rename that says it moved all of the copy has moved it');
assert.equal(torn.stat('/src/reported'), null);
assert.deepEqual(torn.readdir('/dst').map((e) => e.name), ['reported'], 'and its residue is gone');
seed('/src/unsaid');
torn.tear = 'unsaid';
const unsaid = await move(torn, '/src/unsaid', '/dst/unsaid').then(() => null, (error) => error);
assert.equal(unsaid?.code, 'EIO', 'one that says nothing is not known to have');
assert.equal(renameOutcome(unsaid), undefined);
assert.equal(text(torn.readFile('/dst/unsaid/sub/b.txt')), 'b', 'and nothing is undone');
assert.equal(torn.readdir('/dst').filter((e) => STAGED.test(e.name)).length, 1, 'or removed');

box.destroy();
console.log('fs-move-across-mounts: ok');
