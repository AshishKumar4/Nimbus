#!/usr/bin/env bun
// In a subtree a node process holds, a file's async rename is answered once
// it is logged, but a directory's is the session's to answer: the names it
// holds move with it there (a copyFile's among them, which this view never
// held), and only that answer shows them where they went. Red before: the
// directory's rename resolved at once, and create-next-app's next write into
// the moved directory (src/app/page.tsx) was refused ENOENT by the view.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';
import { waveSupervisor } from './lib/wave-supervisor.mjs';

const gate = Promise.withResolvers();
const renamed = [];
const supervisor = waveSupervisor({
  async writeFile() {},
  async mkdir() {},
  async rename(from, to) { if (from.endsWith('/app')) await gate.promise; renamed.push([from, to]); },
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
assert.equal(client().holder('home/user/p/x') !== undefined, true, `the process did not take the subtree it wrote: ${JSON.stringify(client().stats())}`);
fs.mkdirSync('/home/user/p/app');
fs.writeFileSync('/home/user/p/app/page.tsx', 'page');
fs.writeFileSync('/home/user/p/one.txt', '1');
// A file's rename is answered once logged.
await fs.promises.rename('/home/user/p/one.txt', '/home/user/p/two.txt');
const moved = fs.promises.rename('/home/user/p/app', '/home/user/p/src-app');
assert.equal(await Promise.race([moved.then(() => 'answered'), sleep(50).then(() => 'waiting')]), 'waiting', 'a directory\'s rename was answered before the session moved it');
gate.resolve();
await moved;
await client().flush();
assert.deepEqual(renamed.map(([from]) => from), ['/home/user/p/one.txt', '/home/user/p/app']);
console.log('node-rename-directory-held: ok');
process.exit(0);
