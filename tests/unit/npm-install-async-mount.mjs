#!/usr/bin/env bun
// npm install into a project on an asynchronous mount (no `sync` face, every
// call awaited) installs there, as the invoking user. package.json is read
// through the user's view of the namespace; the batch facet's writes land in
// a staging directory on the engine, and each placed package is put in the
// mounted node_modules whole: copied beside its place and renamed there (on
// a mount with no rename, package.json last). A package that cannot be put
// there fails alone and the next install repairs it; what an install cut
// short left behind is swept by the next. Before, the installer read
// package.json from the engine ("No dependencies to install") and would have
// written node_modules there. A project on SQLite, or one a mount's link
// names, takes the engine's bulk path. Real NpmInstaller; the fan-out RPC is
// the seam.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { makeFanoutEnv } from './npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { asyncMemoryVfs } from './lib/async-memory-vfs.mjs';
import { VfsError } from '../../packages/core/src/vfs/vfs-error.ts';

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
// A mount whose writes of a package's package.json fail while `faults.armed`.
const faults = { armed: false };
const faulty = asyncMemoryVfs();
const writeFaulty = faulty.writeFile.bind(faulty);
faulty.writeFile = async (path, data, options) => {
  if (faults.armed && /\/node_modules\/.+\/package\.json$/.test(path)) throw new VfsError('EIO', 'the device dropped the write', path);
  return await writeFaulty(path, data, options);
};
files.vfs.mount('/f', faulty);
// A mount that cannot rename in place.
const renameless = asyncMemoryVfs();
delete renameless.rename;
files.vfs.mount('/nr', renameless);
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

// ── a mount's link into SQLite installs through the engine there ──────────
{
  const user = vfs.as(CRED_SESSION_USER);
  user.mkdir('home/user/lp', { recursive: true });
  user.writeFile('home/user/lp/package.json', pkgJson);
  await view.symlink('/home/user/lp', '/m/link');
  shardsSeen.length = 0;
  const result = await install('/m/link');
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.deepEqual(shardsSeen, ['is-number']);
  assert.equal(JSON.parse(user.readFileString('home/user/lp/node_modules/is-number/package.json')).version, '7.0.0');
  assert.equal(user.stat('home/user/lp/node_modules/.bin/is-number').uid, CRED_SESSION_USER.uid);
  assert.deepEqual(root.readdir('tmp').map((e) => e.name), [], 'nothing was staged');
  console.log('  a mount\'s link into SQLite installs where it points, through the engine');
}

// ── an install cut short leaves nothing the next one keeps ────────────────
{
  vfs.as(CRED_SESSION_USER).mkdir('tmp/.npm-stage-999-old/node_modules/x', { recursive: true });
  await view.mkdir('/m/q/node_modules/.nimbus-copy-is-number-old', { recursive: true });
  await view.writeFile('/m/q/node_modules/.nimbus-copy-is-number-old/package.json', '{}');
  await view.writeFile('/m/q/package.json', pkgJson);
  const result = await install('/m/q');
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.deepEqual(root.readdir('tmp').map((e) => e.name), [], 'the old staging directory is swept');
  assert.deepEqual((await view.readdir('/m/q/node_modules')).map((e) => e.name).sort(), ['.bin', 'is-number']);
  console.log('  staging and copies an install cut short left are swept by the next');
}

// ── a package replaced on the mount keeps what it held and did not bring ────
{
  await view.mkdir('/m/r/node_modules/is-number/node_modules/keep', { recursive: true });
  await view.writeFile('/m/r/node_modules/is-number/package.json', JSON.stringify({ name: 'is-number', version: '6.0.0' }));
  await view.writeFile('/m/r/node_modules/is-number/old.js', 'old');
  await view.writeFile('/m/r/node_modules/is-number/node_modules/keep/package.json', JSON.stringify({ name: 'keep', version: '1.0.0' }));
  await view.writeFile('/m/r/package.json', pkgJson);
  const result = await install('/m/r');
  assert.deepEqual(result.installed, ['is-number@7.0.0'], log.join('\n'));
  assert.equal(JSON.parse(await view.readFileString('/m/r/node_modules/is-number/package.json')).version, '7.0.0');
  assert.equal(await view.exists('/m/r/node_modules/is-number/old.js'), false, 'the old version\'s files are gone');
  assert.equal(JSON.parse(await view.readFileString('/m/r/node_modules/is-number/node_modules/keep/package.json')).name, 'keep');
  console.log('  a replaced package\'s own node_modules entries the new one does not bring stay');
}

// ── a package the mount drops fails alone, and the next install puts it there ──
{
  await view.mkdir('/f/p', { recursive: true });
  await view.writeFile('/f/p/package.json', pkgJson);
  faults.armed = true;
  log.length = 0;
  const cut = await install('/f/p');
  faults.armed = false;
  assert.deepEqual(cut.installed, [], log.join('\n'));
  assert.deepEqual(cut.failed, ['is-number@7.0.0'], log.join('\n'));
  assert.match(log.join('\n'), /is-number: could not be put in \/f\/p\/node_modules\/is-number: .*EIO/);
  assert.equal(await view.exists('/f/p/node_modules/is-number'), false, 'no part of the package is left in its place');
  assert.deepEqual((await view.readdir('/f/p/node_modules')).filter((e) => e.name.startsWith('.nimbus-copy-')), []);
  assert.deepEqual(root.readdir('tmp').map((e) => e.name), []);
  const again = await install('/f/p');
  assert.deepEqual(again.installed, ['is-number@7.0.0'], log.join('\n'));
  assert.equal(JSON.parse(await view.readFileString('/f/p/node_modules/is-number/package.json')).version, '7.0.0');
  console.log('  a package the mount drops fails alone; the next install puts it there');
}

// ── a mount that cannot rename gets each package in place, package.json last ──
{
  await view.mkdir('/nr/p', { recursive: true });
  await view.writeFile('/nr/p/package.json', pkgJson);
  const result = await install('/nr/p');
  assert.deepEqual(result.installed, ['is-number@7.0.0'], log.join('\n'));
  assert.equal(JSON.parse(await view.readFileString('/nr/p/node_modules/is-number/package.json')).version, '7.0.0');
  assert.deepEqual((await view.readdir('/nr/p/node_modules')).filter((e) => e.name.startsWith('.nimbus-copy-')), []);
  console.log('  a mount that cannot rename installs each package in place, package.json last');
}

await harness.close?.();
console.log('npm-install-async-mount: ok');
