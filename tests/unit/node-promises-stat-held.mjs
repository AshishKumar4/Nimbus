#!/usr/bin/env bun
// In a subtree a node process holds, nothing changes that it has not done:
// fs.promises.stat and lstat answer there from what the process knows, as
// statSync and lstatSync do, and ask the session nothing. Outside it, they
// ask the session. Red before: every async stat asked the session, after
// sending what the process had written there, even where only the process
// could have changed it (fs.promises.cp, which stats each entry, asked
// three times per file).

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';
import { waveSupervisor } from './lib/wave-supervisor.mjs';

const asked = [];
const supervisor = waveSupervisor({
  async writeFile() {},
  async mkdir() {},
  async symlink() {},
  async stat(path) { asked.push(['stat', path]); return path === '/home/user/elsewhere' ? { type: 'file', size: 3, mode: 0o100644, uid: 1000, gid: 1000 } : null; },
  async lstat(path) { asked.push(['lstat', path]); return null; },
  // The process takes the subtree it writes, as the session grants it.
  async fsAcquireExclusiveMutation(path, options) {
    return { root: path.replace(/^\/+/, ''), owner: `grant:${path}`, inos: { first: 1 << 20, end: (1 << 20) + 4096 }, bytes: options?.delegate?.bytes ?? 0, umask: 0o022 };
  },
  fsAwaitRecall: () => new Promise(() => {}),
  async fsRecalled() {},
  async fsReleaseExclusiveMutation() {},
});
const factory = new Function(
  '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  `"use strict";${VFS_WRITE_LEDGER_SOURCE}\n${SHIMS_STORE_PRELUDE + generateShimsCode()}
;return { fs: builtins.fs, client: () => __nimbusProcessFs() };`,
);
const metadata = { 'home/user': { type: 'directory', size: 0, mode: 0o40755, uid: 1000, gid: 1000 } };
const { fs, client } = (declareNamespace({ metadata, manifest: { 'home/user': [] } }), factory(
  {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync('/home/user/p');
for (let i = 0; i < 10; i++) fs.writeFileSync(`/home/user/p/f${i}`, String(i));
await client().flush();
for (let i = 0; i < 200 && client().holder('home/user/p/x') === undefined; i++) await sleep(10);
assert.notEqual(client().held('home/user/p/x'), undefined, `the process did not take the subtree it wrote: ${JSON.stringify(client().stats())}`);

fs.writeFileSync('/home/user/p/data.txt', 'hello', { mode: 0o600 });
fs.symlinkSync('data.txt', '/home/user/p/link');
const shape = (stat) => [stat.isFile(), stat.isSymbolicLink(), stat.size, stat.mode & 0o7777, stat.uid];
asked.length = 0;
assert.deepEqual(shape(await fs.promises.stat('/home/user/p/data.txt')), shape(fs.statSync('/home/user/p/data.txt')));
assert.deepEqual(shape(await fs.promises.lstat('/home/user/p/link')), shape(fs.lstatSync('/home/user/p/link')));
assert.deepEqual(shape(await fs.promises.stat('/home/user/p/link')), shape(fs.statSync('/home/user/p/data.txt')));
await assert.rejects(fs.promises.stat('/home/user/p/nope'), { code: 'ENOENT', syscall: 'stat', path: '/home/user/p/nope' });
await assert.rejects(fs.promises.lstat('/home/user/p/nope'), { code: 'ENOENT', syscall: 'lstat', path: '/home/user/p/nope' });
assert.deepEqual(asked, [], 'nothing was asked of the session for a path in the held subtree');

assert.equal((await fs.promises.stat('/home/user/elsewhere')).size, 3);
assert.deepEqual(asked, [['stat', '/home/user/elsewhere']], 'a path outside it is the session\'s to answer');
console.log('node-promises-stat-held: ok');
process.exit(0);
