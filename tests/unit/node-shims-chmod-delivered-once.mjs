#!/usr/bin/env bun
// A sync chmod reaches the authority on the next flush of its path, once.
// It used to be re-sent on EVERY flush, and every async read flushes first, so
// each read of the file was a chmod: a real mutation that bumped the path's
// revision, made the next ACQUIRE evict the process's own cell, and made the
// refetch chmod again. create-astro's readFileSync(README.md) landed in one of
// those evictions and failed EAGAIN.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const enc = new TextEncoder();
const dec = new TextDecoder();
const dir = '/home/user/app';
const file = `${dir}/README.md`;
vfs.mkdir(dir, { recursive: true });
vfs.writeFile(file, enc.encode('# app'));

let chmods = 0;
const supervisor = {
  readFile: async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; },
  writeFile: (p, c) => bridge.writeFile(p, c),
  stat: (p, o) => bridge.stat(p, o), lstat: (p) => bridge.stat(p, { followSymlinks: false }),
  readdir: (p) => bridge.readdir(p), exists: async (p) => (await bridge.stat(p)) !== null,
  access: (p, m) => bridge.access(p, m), mkdir: (p, o) => bridge.mkdir(p, o ?? { recursive: true }),
  chmod: (p, m) => { chmods++; return bridge.chmod(p, m); },
  fsReadRange: (p, o, l) => bridge.readRange(p, o, l),
  fsAcquire: (epoch, cursor) => bridge.acquire(epoch, cursor),
};
globalThis.__nimbusVfsCursor = { epoch: rawVfs.epoch, rev: rawVfs.revision() };

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() + '\n;return { fs: __fsMod };',
);
const { fs } = factory(
  { 'home/user/app/README.md': '# app' },
  {
    'home/user/app': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 },
    'home/user/app/README.md': { type: 'file', size: 5, mode: 0o644, uid: 1000, gid: 1000 },
  },
  {}, { 'home/user/app': ['README.md'] }, supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, dir, [], {}, `${dir}/x.js`, dir,
);

fs.chmodSync(file, 0o600);
assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the mode is visible to the process at once');

await fs.promises.readFile(file, 'utf8');
assert.equal(chmods, 1, 'the first flush delivers the mode');
assert.equal((await bridge.stat(file)).mode & 0o777, 0o600, 'and the authority has it');
const revisionAfterDelivery = rawVfs.revision(file);

for (let i = 0; i < 5; i++) assert.equal(await fs.promises.readFile(file, 'utf8'), '# app');
assert.equal(chmods, 1, `reads must not re-send the mode (sent ${chmods})`);
assert.equal(rawVfs.revision(file), revisionAfterDelivery, 'reads must not mutate the file');
assert.equal(fs.readFileSync(file, 'utf8'), '# app', 'the sync view still serves the file');
assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'and still shows the mode');

fs.chmodSync(file, 0o640);
await fs.promises.readFile(file, 'utf8');
assert.equal(chmods, 2, 'a later chmod is delivered too');
assert.equal((await bridge.stat(file)).mode & 0o777, 0o640);

console.log('ok - node-shims-chmod-delivered-once');
