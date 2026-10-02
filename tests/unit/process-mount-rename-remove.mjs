#!/usr/bin/env bun
// A process's rename within one mount is that mount's rename, and its rm -r
// on a mount says when part of the tree stayed.
//
// The process bridge refused every rename that touched a mount with EXDEV,
// even within one mount whose backend renames, so `mv /m/a /m/b`, a node
// process's fs.rename and `ws.fs.rename` all copied (or failed) where the
// namespace itself renames. Between two filesystems, and on a backend with
// no rename in place, EXDEV stays the answer.
//
// rm -r on a mount whose backend has no removal of its own is walked; the
// walk carries on past an entry it cannot remove and reports it, and the
// namespace's synchronous face dropped that report, so `rm -r` exited 0 with
// the entry still there.
import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { VfsError } from '../../packages/core/src/vfs/vfs-error.ts';

const USER = { uid: 1000, gid: 1000 };
const code = (run) => Promise.resolve().then(run).then(() => 'ok', (error) => error.code);

class Counted extends MemoryVFS {
  constructor() { super(USER); this.calls = { rename: 0, writeFile: 0 }; }
  rename(from, to) { this.calls.rename++; return super.rename(from, to); }
  writeFile(path, data, options) { this.calls.writeFile++; return super.writeFile(path, data, options); }
}
class NoRename extends MemoryVFS { rename = undefined; }
class Walked extends MemoryVFS {
  removeRecursive = undefined;
  unlink(path) {
    if (path.endsWith('/kept.txt')) throw new VfsError('EACCES', 'permission denied', path);
    return super.unlink(path);
  }
}

const m = new Counted();
const box = await testBox({ mounts: { '/m': m, '/n': new NoRename(USER), '/w': new Walked(USER) } });
const { workspace: ws } = box;
const ns = box.files.vfs.sync;
const view = ws.shell.getVfs();

// ── rename within one mount, through each face a process has ────────────
await view.writeFile('/m/a.txt', 'a');
const written = m.calls.writeFile;
await view.rename('/m/a.txt', '/m/b.txt');
assert.equal(m.calls.rename, 1, 'a view\'s rename within a mount is the mount\'s rename');
assert.equal(m.calls.writeFile, written, 'nothing was copied');
assert.equal(ns.stat('/m/a.txt'), null);
assert.equal(new TextDecoder().decode(ns.readFile('/m/b.txt')), 'a');

const mv = await ws.exec('mv /m/b.txt /m/c.txt && cat /m/c.txt');
assert.deepEqual([mv.exitCode, mv.stdout, mv.stderr], [0, 'a', '']);
assert.equal(m.calls.rename, 2, 'mv within a mount renames');
assert.equal(m.calls.writeFile, written);

const bridge = ws.filesystem.bind({ pid: 71, cred: { ...USER, groups: [1000], umask: 0o022 } });
await bridge.rename('/m/c.txt', '/m/d.txt');
assert.equal(m.calls.rename, 3, 'a process\'s bridge renames within a mount');
await view.mkdir('/m/dir/sub', { recursive: true });
await view.rename('/m/dir', '/m/moved');
assert.equal(ns.stat('/m/moved/sub').type, 'directory', 'a directory too');

// ── EXDEV stays the answer between filesystems, and without rename in place ─
await view.writeFile('/home/user/h.txt', 'h');
await view.writeFile('/n/x.txt', 'x');
assert.equal(await code(() => view.rename('/m/d.txt', '/home/user/d.txt')), 'EXDEV', 'mount to SQLite');
assert.equal(await code(() => view.rename('/home/user/h.txt', '/m/h.txt')), 'EXDEV', 'SQLite to mount');
assert.equal(await code(() => view.rename('/m/d.txt', '/n/d.txt')), 'EXDEV', 'mount to mount');
assert.equal(await code(() => view.rename('/n/x.txt', '/n/y.txt')), 'EXDEV', 'a backend with no rename in place');
assert.equal(ns.stat('/m/d.txt').type, 'file');
assert.equal(ns.stat('/n/x.txt').type, 'file');
// The namespace's own refusals still come through the bridge.
assert.equal(await code(() => view.rename('/m/missing', '/m/e.txt')), 'ENOENT');
assert.equal(await code(() => view.rename('/m', '/m2')), 'EBUSY', 'a mount point is not renamed');

// ── rm -r of a walked tree says what stayed ─────────────────────────────
await view.mkdir('/w/t/sub', { recursive: true });
await view.writeFile('/w/t/gone.txt', 'g');
await view.writeFile('/w/t/sub/kept.txt', 'k');
const rm = await ws.exec('rm -r /w/t');
assert.equal(rm.exitCode, 1, `rm -r fails: ${rm.stdout}${rm.stderr}`);
assert.match(rm.stderr, /Permission denied/);
assert.equal(ns.stat('/w/t/sub/kept.txt').type, 'file', 'the entry it could not remove is there');
assert.equal(ns.stat('/w/t/gone.txt'), null, 'and what it could is gone');
assert.equal(await code(() => view.remove('/w/t', { recursive: true })), 'EACCES');
assert.equal((await view.removeRecursive('/w/t')).failures[0]?.error.code, 'EACCES');

box.destroy();
console.log('process-mount-rename-remove: ok');
