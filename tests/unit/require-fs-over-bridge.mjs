#!/usr/bin/env bun
// requireFsOverBridge: the one adapter from a process's bound bridge to what
// the resolver and a launch builder read. A missing path is null (or false)
// to every probe, however the bridge reports it; stat follows links, lstat
// does not; readBytes returns the file's bytes; readFileString of a missing
// file is ENOENT; any other error is the bridge's own.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { requireFsOverBridge } from '../../packages/core/src/runtime/require-resolver.ts';
import { processFiles } from './lib/process-bridge.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const root = raw.as(CRED_KERNEL);
root.mkdir('home/user/pkg', { recursive: true });
root.writeFile('home/user/pkg/index.js', 'module.exports = 1;\n');
root.symlink('index.js', 'home/user/pkg/main.js');
root.symlink('nowhere.js', 'home/user/pkg/dangling.js');
root.mkdir('secret', { mode: 0o700 });
root.writeFile('secret/x', 'x');
const bridge = processFiles(raw).bind({ pid: 7, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
const fs = requireFsOverBridge(bridge);

assert.equal((await fs.stat('/home/user/pkg/main.js')).type, 'file', 'stat follows the link');
assert.equal((await fs.lstat('/home/user/pkg/main.js')).type, 'symlink', 'lstat does not');
assert.equal((await fs.lstat('/home/user/pkg/dangling.js')).type, 'symlink');
assert.equal(await fs.stat('/home/user/pkg/dangling.js'), null);
assert.equal(await fs.lstat('/home/user/pkg/missing.js'), null);
assert.equal(await fs.stat('/home/user/missing/deeper.js'), null);
assert.deepEqual(await fs.readBytes('/home/user/pkg/main.js'), new TextEncoder().encode('module.exports = 1;\n'));
assert.equal(await fs.readBytes('/home/user/pkg/missing.js'), null);
assert.equal(await fs.exists('/home/user/pkg'), true);
assert.equal(await fs.isDirectory('/home/user/pkg/index.js'), false);
await assert.rejects(async () => fs.readFileString('/home/user/pkg/missing.js'), { code: 'ENOENT' });
// Not absence: the bridge's own error.
await assert.rejects(async () => fs.readBytes('/secret/x'), { code: 'EACCES' });

console.log('require-fs-over-bridge: ok');
