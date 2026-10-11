#!/usr/bin/env bun
// A rename whose source the view knows is not there: a sync call answers it
// from the view (ENOENT, nothing logged); an async one in a subtree the
// process does not hold asks the session, which may know the source (a peer
// made it after the view's snapshot) or refuse it with its own ENOENT, which
// create-next-app catches for the `pages` and `styles` it moves only where
// they exist. Red before (recheck): an unheld async rename trusted the view
// and threw ENOENT for a source a peer had made.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';
import { waveSupervisor } from './lib/wave-supervisor.mjs';

const asked = [];
// The session: what it has, the view's snapshot plus a name a peer made since.
const sessionHas = new Set(['/home/user/app', '/home/user/peer']);
const supervisor = waveSupervisor({
  async writeFile() {},
  async mkdir() {},
  async rename(from, to) {
    asked.push(from);
    if (!sessionHas.has(from)) throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`), { code: 'ENOENT' });
    sessionHas.delete(from);
    sessionHas.add(to);
  },
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
await fs.promises.rename('/home/user/peer', '/home/user/src-peer');
await fs.promises.rename('/home/user/app', '/home/user/src-app');
await flushClient();
assert.deepEqual(asked, ['/home/user/styles', '/home/user/peer', '/home/user/app'], 'the session was not asked for each async rename, or was asked for the sync one');
assert.equal(sessionHas.has('/home/user/src-peer'), true, 'a source a peer made was not renamed');
assert.equal(fs.existsSync('/home/user/src-app'), true);

console.log('node-rename-missing-source: ok');
