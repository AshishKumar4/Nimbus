#!/usr/bin/env bun
// npm install into a project on an asynchronous mount (no `sync` face, every
// call awaited) installs there, as the invoking user. package.json is read
// through the user's view of the namespace; the batch facet's writes land in
// a staging directory on the engine, and each placed package is copied into
// the mounted node_modules, its bin link included. Nothing is left in SQLite.
// Before, the installer read package.json from the engine ("No dependencies
// to install") and would have written node_modules there. A package already
// on the mount is not fetched again, and a project on SQLite still takes the
// engine's bulk path. Real NpmInstaller; the fan-out RPC is the seam.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { makeFanoutEnv } from './npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { asyncMemoryVfs } from './lib/async-memory-vfs.mjs';

const PID = 7;
const resolved = (name, version) => ({
  pkg: {
    name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: 'sha512-fixture',
    dependencies: {}, exports: null, main: 'index.js', module: '', bin: { [name]: 'cli.js' },
  },
  deps: {}, peerDeps: {}, optionalDeps: {}, allPeerDependencies: {},
  cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
});

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
root.mkdir('tmp');
root.chmod('tmp', 0o1777);
root.mkdir('home/user', { recursive: true, mode: 0o755 });
root.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const files = new ProcessFiles(vfs);
files.vfs.mount('/m', asyncMemoryVfs());
const view = files.view({ pid: PID, cred: CRED_SESSION_USER });
const pkgJson = JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } });

const log = [];
const shardsSeen = [];
// The shards' batch writes are authorized as the invoking process, so they write as the user.
const env = makeFanoutEnv({ root: vfs.as(CRED_SESSION_USER), NM: 'unused', resultFor: (name) => resolved(name, '7.0.0'), shardsSeen });
const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
const installer = new NpmInstaller(files, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });
const install = (dir) => installer.install(dir, { pid: PID, cred: CRED_SESSION_USER });

// ── a mounted project installs on the mount ─────────────────────────────
{
  await view.mkdir('/m/p', { recursive: true });
  await view.writeFile('/m/p/package.json', pkgJson);
  const result = await install('/m/p');
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.deepEqual(result.installed, ['is-number@7.0.0'], log.join('\n'));
  assert.equal(JSON.parse(await view.readFileString('/m/p/node_modules/is-number/package.json')).version, '7.0.0');
  const shim = await view.stat('/m/p/node_modules/.bin/is-number');
  assert.equal(shim?.type, 'file', 'the bin link is on the mount');
  assert.equal(shim.mode & 0o777, 0o755);
  assert.match(await view.readFileString('/m/p/node_modules/.bin/is-number'), /require\("\.\.\/is-number\/cli\.js"\)/);
  assert.equal(root.exists('m'), false, 'nothing of the mounted project in SQLite');
  assert.deepEqual(root.readdir('tmp').map((e) => e.name), [], 'the staging directory is gone');
  console.log('  a mounted project installs on the mount, bin link included, as the user');
}

// ── what is on the mount is not fetched again ─────────────────────────────
{
  shardsSeen.length = 0;
  log.length = 0;
  const result = await install('/m/p');
  assert.deepEqual(result.failed, []);
  assert.equal(result.cachedHits, 1, log.join('\n'));
  assert.deepEqual(shardsSeen, [], 'the installed package is read from the mount, not fetched');
  console.log('  a package already on the mount is not fetched again');
}

// ── a project on SQLite keeps the engine's bulk path, as the user ───────────
{
  const user = vfs.as(CRED_SESSION_USER);
  user.mkdir('home/user/p', { recursive: true });
  user.writeFile('home/user/p/package.json', pkgJson);
  const result = await install('/home/user/p');
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.equal(JSON.parse(user.readFileString('home/user/p/node_modules/is-number/package.json')).version, '7.0.0');
  assert.equal(user.stat('home/user/p/node_modules/.bin/is-number').uid, CRED_SESSION_USER.uid, 'the bin link is the user\'s');
  assert.deepEqual(root.readdir('tmp').map((e) => e.name), [], 'nothing was staged');
  console.log('  a project on SQLite installs through the engine');
}

await harness.close?.();
console.log('npm-install-async-mount: ok');
