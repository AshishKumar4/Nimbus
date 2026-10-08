#!/usr/bin/env bun
// A rename whose source the namespace knows is not there is rename(2)'s
// ENOENT, answered at the call, sync or async, before anything is logged:
// never a change logged for the session to refuse later. In a subtree the
// process holds, an async change is answered once it is logged, so a refusal
// only the session gave arrived as a failure at the exit instead of the
// call's ENOENT: create-next-app moves `pages` and `styles` only where they
// exist, catching ENOENT, and so failed ("2 filesystem changes this process
// made did not reach the session"). Red before: renameSync returned, the
// async rename resolved, and the rename was sent.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';
import { waveSupervisor } from './lib/wave-supervisor.mjs';

const renamed = [];
const supervisor = waveSupervisor({
  async writeFile() {},
  async mkdir() {},
  async rename(from, to) { renamed.push([from, to]); },
});
const factory = new Function(
  '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  `"use strict";${VFS_WRITE_LEDGER_SOURCE}\n${SHIMS_STORE_PRELUDE + generateShimsCode()}
;return { fs: builtins.fs, flushClient: () => __nimbusProcessFs().flush() };`,
);
const metadata = {
  'home/user': { type: 'directory', size: 0, mode: 0o40755, uid: 1000, gid: 1000 },
  'home/user/app': { type: 'directory', size: 0, mode: 0o40755, uid: 1000, gid: 1000 },
};
const { fs, flushClient } = (declareNamespace({ metadata, manifest: { 'home/user': ['app'], 'home/user/app': [] } }), factory(
  {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
));

assert.throws(() => fs.renameSync('/home/user/pages', '/home/user/src-pages'), (error) => error.code === 'ENOENT' && error.syscall === 'rename', 'renameSync of a missing source returned');
await assert.rejects(fs.promises.rename('/home/user/styles', '/home/user/src-styles'), (error) => error.code === 'ENOENT', 'an async rename of a missing source resolved');
// One that is there moves.
await fs.promises.rename('/home/user/app', '/home/user/src-app');
await flushClient();
assert.deepEqual(renamed, [['/home/user/app', '/home/user/src-app']], 'a rename of a missing source was sent');
assert.equal(fs.existsSync('/home/user/src-app'), true);

console.log('node-rename-missing-source: ok');
