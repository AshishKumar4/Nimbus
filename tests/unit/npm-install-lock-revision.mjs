#!/usr/bin/env bun
// npm-install-lock-revision — the installed tree is the lockfile's, whoever wrote it.
//
// An installer keeps the installed tree of the lockfile revision it last
// read or wrote. When another writer changes the lockfile (a second
// installer over the same storage), the next install reads the tree the
// lockfile now records: what the other one installed is kept, nothing is
// resolved again, and nothing it placed is pruned as extraneous. Real
// NpmInstaller over real SQLite; the fan-out RPC is the seam.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { registryRecord } from '../../packages/worker/src/npm/registry-record.ts';
import { kernelInstaller, makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;
const asked = [];
const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
root.mkdir(NM, { recursive: true });
root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { a: '1.0.0' } }));
const env = makeFanoutEnv({
  root, NM,
  resultFor: (name) => {
    asked.push(name);
    const pkg = { name, registryName: name, version: '1.0.0', tarballUrl: `https://registry.invalid/${name}-1.0.0.tgz`, integrity: `sha512-${name}`, dependencies: name === 'b' ? { c: '1.0.0' } : {}, main: 'index.js', bin: {} };
    return { pkg, cacheWrites: [registryRecord(pkg, Date.now())], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [] };
  },
});
const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
const first = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} });
const second = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} });

assert.deepEqual((await first.install(PROJ, {})).failed, []);
// The other installer adds b (and its c), and saves it.
assert.deepEqual((await second.install(PROJ, { packages: ['b@1.0.0'] })).failed, []);
assert.ok(root.exists(`${NM}/c/package.json`));

asked.length = 0;
const log = [];
const again = await first.install(PROJ, { onProgress: (line) => log.push(line) });
assert.deepEqual(again.failed, [], log.join('\n'));
assert.deepEqual(asked, [], 'the lockfile the other installer wrote answers every edge');
for (const name of ['a', 'b', 'c']) assert.ok(root.exists(`${NM}/${name}/package.json`), `${name} is kept`);
assert.deepEqual([...first.npmCache.readLockfile(PROJ).keys()].sort(), ['a', 'b', 'c']);

console.log('npm-install-lock-revision: ok');
process.exit(0);
