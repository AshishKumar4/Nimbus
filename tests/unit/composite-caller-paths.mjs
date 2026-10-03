#!/usr/bin/env bun
// A backend's filesystem error leaves CompositeVFS as Node's error for the
// caller's call (Kinu's ask 9, "errors should name the caller's path"): the
// call's syscall and the paths the caller gave, whatever path the backend was
// handed (a mount-relative one, a link's target). The reason stays in the
// backend's own words, the backend's error is the cause, and an asynchronous
// mount's refusal still says so. Through both faces, on the root mount and on
// a mounted backend.

import assert from 'node:assert/strict';
import { CompositeVFS, isAsyncMountRefusal } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { renameOutcome, syscallError, VfsError } from '../../packages/core/src/vfs/vfs-error.ts';

const enc = new TextEncoder();

/** A device: refuses what is outside /home in its own words, and has a rename that refuses without changing anything. */
function device() {
  const backing = new MemoryVFS();
  backing.mkdir('/home', { recursive: true });
  backing.writeFile('/home/a', enc.encode('a'));
  return Object.assign(Object.create(backing), {
    readFile(path) {
      if (!path.startsWith('/home')) throw syscallError('EACCES', 'open', path, { detail: 'outside the consented directory' });
      return backing.readFile(path);
    },
    readlink(path) { throw new VfsError('ENOTSUP', 'this plane serves no readlink', path); },
    rename(from, to) { throw Object.assign(syscallError('EBUSY', 'rename', from, { dest: to }), { renamed: 'none' }); },
    sync: undefined,
  });
}

const root = new MemoryVFS();
root.mkdir('/d', { recursive: true });
root.symlink('/d', '/l');
const vfs = new CompositeVFS(root);
vfs.mount('/m', new MemoryVFS());
vfs.mount('/pc', device(), { resolvesPaths: true });
root.symlink('/m', '/ml');
const syncMount = new MemoryVFS();
vfs.mount('/s', syncMount);

/** Node's error for the call, as each face reports it. */
async function both(label, run, { code, syscall, path, dest, words }) {
  for (const face of ['async', 'sync']) {
    let error;
    try { await run(face === 'async' ? vfs : vfs.sync); } catch (caught) { error = caught; }
    assert.ok(error instanceof VfsError, `${face} ${label}: a VfsError (${error})`);
    assert.equal(error.code, code, `${face} ${label}: ${error.message}`);
    assert.equal(error.syscall, syscall, `${face} ${label}: ${error.message}`);
    assert.equal(error.path, path, `${face} ${label}: the caller's path (${error.message})`);
    assert.equal(error.dest, dest, `${face} ${label}: ${error.message}`);
    const second = dest === undefined ? '' : ` -> '${dest}'`;
    assert.equal(error.message, `${code}: ${words}, ${syscall} '${path}'${second}`, `${face} ${label}`);
    assert.ok(error.cause instanceof Error, `${face} ${label}: the backend's error is the cause`);
  }
}

const NOENT = 'no such file or directory';
// A mounted backend saw '/nope', '/a', '/b'.
await both('readFile on a mount', (fs) => fs.readFile('/m/nope'), { code: 'ENOENT', syscall: 'open', path: '/m/nope', words: NOENT });
await both('readdir on a mount', (fs) => fs.readdir('/m/nope'), { code: 'ENOENT', syscall: 'scandir', path: '/m/nope', words: NOENT });
await both('rename within a mount', (fs) => fs.rename('/m/a', '/m/b'), { code: 'ENOENT', syscall: 'rename', path: '/m/a', dest: '/m/b', words: NOENT });
await both('unlink on a mount', (fs) => fs.unlink('/m/nope'), { code: 'ENOENT', syscall: 'unlink', path: '/m/nope', words: NOENT });
// Through a root link into the mount: the caller's spelling, not the target's.
await both('through a link into a mount', (fs) => fs.readFile('/ml/nope'), { code: 'ENOENT', syscall: 'open', path: '/ml/nope', words: NOENT });
// The root mount, through a link: the backend saw '/d'.
await both('writeFile through a root link', (fs) => fs.writeFile('/l', enc.encode('x')), { code: 'EISDIR', syscall: 'open', path: '/l', words: 'illegal operation on a directory' });

// The backend's own words stay, on the asynchronous mount's face.
for (const [label, run, expected] of [
  ['a refusal in its own words', () => vfs.readFile('/pc/etc/x'), { code: 'EACCES', syscall: 'open', path: '/pc/etc/x', message: "EACCES: outside the consented directory, open '/pc/etc/x'" }],
  ['an error built with its words', () => vfs.readlink('/pc/home/a'), { code: 'ENOTSUP', syscall: 'readlink', path: '/pc/home/a', message: "ENOTSUP: this plane serves no readlink, readlink '/pc/home/a'" }],
]) {
  const error = await run().then(() => null, (caught) => caught);
  assert.ok(error, label);
  for (const key of ['code', 'syscall', 'path', 'message']) assert.equal(error[key], expected[key], `${label}: ${key}`);
}
// What a rename refusal says it did is read through the cause, as move() reads it.
const refused = await vfs.rename('/pc/home/a', '/pc/home/b').then(() => null, (caught) => caught);
assert.equal(refused.path, '/pc/home/a');
assert.equal(refused.dest, '/pc/home/b');
assert.equal(renameOutcome(refused), 'none');
// An asynchronous mount refused to a synchronous caller still says so.
const waited = (() => { try { vfs.sync.readFile('/pc/home/a'); return null; } catch (caught) { return caught; } })();
assert.equal(waited.code, 'EAGAIN');
assert.equal(isAsyncMountRefusal(waited), true);
// A walked removal reports each failure on the namespace's path, in the backend's words.
{
  const volume = new MemoryVFS();
  volume.mkdir('/t', { recursive: true });
  volume.writeFile('/t/f', enc.encode('f'));
  const bare = Object.assign(Object.create(volume), {
    removeRecursive: undefined,
    unlink(path) { if (path === '/t/f') throw new VfsError('EIO', 'injected failure', path); return volume.unlink(path); },
  });
  vfs.mount('/w', bare);
  const report = await vfs.removeRecursive('/w/t');
  assert.deepEqual(report.failures.map((f) => [f.path, f.error.path, f.error.message]),
    [['/w/t/f', '/w/t/f', "EIO: injected failure, unlink '/w/t/f'"]]);
}
// Anything that is not a filesystem error is the backend's, as it threw it.
const broken = new TypeError('a bug in the backend');
syncMount.readFile = () => { throw broken; };
await assert.rejects(vfs.readFile('/s/x'), (error) => error === broken);

console.log('composite-caller-paths: a backend\'s error names the caller\'s call');
