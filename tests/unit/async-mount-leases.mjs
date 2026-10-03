#!/usr/bin/env bun
// A read or write through a SQLite link that leads into a mount below its
// point reaches the mount. The synchronous bridge resolved a SQLite link's
// target inside SQLite, so a link to /s/top (a directory on the mount /s)
// answered ENOENT for every read and write through it, on a synchronous
// mount as on an asynchronous one. It walks the target component by
// component now.

import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';

const USER = { uid: 1000, gid: 1000 };
const code = (run) => Promise.resolve().then(run).then(() => 'ok', (error) => error.code);

/** A MemoryVFS with no synchronous face: every call answers a promise. */
const asyncOnly = (vfs) => new Proxy(vfs, {
  get(target, key) {
    if (key === 'sync') return undefined;
    const value = target[key];
    if (typeof value !== 'function') return value;
    if (key === 'as') return (...args) => asyncOnly(value.apply(target, args));
    return async (...args) => value.apply(target, args);
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

await m.mkdir('/top/free', { recursive: true });
const bridge = ws.filesystem.bind({ pid: 71, cred: { ...USER, groups: [1000], umask: 0o022 } });

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

console.log('async-mount-leases: a SQLite link into a mount reaches it');
