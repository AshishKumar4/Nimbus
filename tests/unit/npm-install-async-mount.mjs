#!/usr/bin/env bun
// npm install into a project on an asynchronous mount (no `sync` face, every
// call awaited) installs there, as the invoking user. package.json is read
// through the user's view of the namespace; the batch facet's writes land in
// a staging directory on the engine, and each placed package is put in the
// mounted node_modules whole: copied beside its place and renamed there (on
// a mount with no rename, package.json last). A package that cannot be put
// there fails alone and the next install repairs it; what an install cut
// short left behind is swept by the next. A shard that fails costs only
// what it did not finish. Before, the installer read
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
import { makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { asyncMemoryVfs } from './lib/async-memory-vfs.mjs';
import { VfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { npmRegistry } from './lib/npm-registry.mjs';

const PID = 7;
const { resultFor } = npmRegistry({ 'is-number': { '7.0.0': { bin: { 'is-number': 'cli.js' } } } });

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
const renameless = asyncMemoryVfs({ hide: ['rename'] });
assert.equal(renameless.rename, undefined, 'the package.json-last fixture genuinely lacks rename');
files.vfs.mount('/nr', renameless);
const view = files.view({ pid: PID, cred: CRED_SESSION_USER });
const pkgJson = JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } });

const log = [];
const shardsSeen = [];
// The shards' batch writes are authorized as the invoking process, so they write as the user.
// A shard that fails at the package `crash.at` names, as `crash.when` says (npm-fanout-test-env crashFor).
const crash = { at: null, when: null };
const env = makeFanoutEnv({ root: vfs.as(CRED_SESSION_USER), NM: 'unused', resultFor, shardsSeen, crashFor: (p) => (p.name === crash.at ? crash.when : null) });
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
// ── a shard that fails: what it published is put on the mount, a part of a package is not ──
for (const [when, landed] of [['after', true], ['partial', false]]) {
  const dir = `/m/crash-${when}`;
  await view.mkdir(dir, { recursive: true });
  await view.writeFile(`${dir}/package.json`, pkgJson);
  Object.assign(crash, { at: 'is-number', when });
  const result = await install(dir);
  Object.assign(crash, { at: null, when: null });
  if (landed) {
    assert.deepEqual(result.failed, [], `a package the failed shard published is installed: ${log.join('\n')}`);
    assert.equal(JSON.parse(await view.readFileString(`${dir}/node_modules/is-number/package.json`)).version, '7.0.0', 'and put on the mount');
  } else {
    assert.deepEqual(result.failed, ['is-number@7.0.0'], 'a package the shard did not finish fails');
    assert.equal(await view.exists(`${dir}/node_modules/is-number`), false, 'and nothing of it is put on the mount');
  }
}

// ── a package that fails takes what was staged beneath it: those fail too ──
// a@1 nests x@2 below it (the project has x@1). a's shard fails partway,
// x@2's lands in a's staged folder: it is not on the mount, and is not
// reported installed.
{
  const nestedCrash = { at: null };
  const nestedEnv = makeFanoutEnv({
    root: vfs.as(CRED_SESSION_USER), NM: 'unused',
    resultFor: (name, spec) => {
      const answer = resolved(name, name === 'a' ? '1.0.0' : spec.range);
      answer.pkg.integrity = `sha512-${name}-${answer.pkg.version}`;
      if (name === 'a') answer.pkg.dependencies = { x: '2.0.0' };
      return answer;
    },
    crashFor: (p) => (p.name === nestedCrash.at ? 'partial' : null),
  });
  const nested = new NpmInstaller(files, harness.sql, { env: nestedEnv, ctx, onProgress: (msg) => log.push(msg) });
  await view.mkdir('/m/nested', { recursive: true });
  await view.writeFile('/m/nested/package.json', JSON.stringify({ name: 'n', version: '1.0.0', dependencies: { a: '1.0.0', x: '1.0.0' } }));
  nestedCrash.at = 'a';
  const result = await nested.install('/m/nested', { pid: PID, cred: CRED_SESSION_USER });
  assert.deepEqual([...result.failed].sort(), ['a@1.0.0', 'x@2.0.0'], `what was staged beneath a failed package fails with it: ${log.join('\n')}`);
  assert.ok(!result.installed.includes('x@2.0.0'), 'and is not reported installed');
  assert.equal(await view.exists('/m/nested/node_modules/a'), false, 'nothing of a is on the mount');
}

// ── the sweep removes each stage as the user who owns it ──────────────────
// Another user's stage in the sticky /tmp still goes. What its owner could
// not remove stays: a directory moved to a stage's name with root's files
// in it (a home holding the runtime store) is not the kernel's to empty.
{
  const OTHER = { uid: 1001, gid: 1001, groups: [1001], umask: 0o022 };
  vfs.as(OTHER).mkdir('tmp/.npm-stage-2-other/node_modules/x', { recursive: true });
  vfs.as(CRED_SESSION_USER).mkdir('tmp/.npm-stage-3-moved', { recursive: true });
  root.mkdir('tmp/.npm-stage-3-moved/.nimbus', { mode: 0o755 });
  root.writeFile('tmp/.npm-stage-3-moved/.nimbus/runtime.wasm', 'root', { mode: 0o644 });
  vfs.as(CRED_SESSION_USER).writeFile('tmp/.npm-stage-3-moved/mine', 'mine');
  await view.mkdir('/m/t', { recursive: true });
  await view.writeFile('/m/t/package.json', pkgJson);
  await install('/m/t');
  assert.equal(root.exists('tmp/.npm-stage-2-other'), false, "another user's stage is swept");
  assert.equal(root.exists('tmp/.npm-stage-3-moved/.nimbus/runtime.wasm'), true, "root's file in a stage is left");
  assert.equal(root.exists('tmp/.npm-stage-3-moved/mine'), false, 'what its owner may remove goes');
  root.removeRecursive('tmp/.npm-stage-3-moved');
  // A stage's group is no proof its owner is in it (a setgid /tmp gives
  // each the directory's): the owner is acted as with no group's authority.
  vfs.as(OTHER).mkdir('tmp/.npm-stage-4-setgid', { recursive: true });
  root.chown('tmp/.npm-stage-4-setgid', OTHER.uid, 0);
  root.mkdir('tmp/.npm-stage-4-setgid/g', { mode: 0o770 });
  root.chmod('tmp/.npm-stage-4-setgid/g', 0o770);
  root.writeFile('tmp/.npm-stage-4-setgid/g/root-group', 'root', { mode: 0o660 });
  await install('/m/t');
  assert.equal(root.exists('tmp/.npm-stage-4-setgid/g/root-group'), true, "a file only root's group may remove is left");
  root.removeRecursive('tmp/.npm-stage-4-setgid');
  // Nor is any other group's: nogroup (65534) is a group like any other.
  vfs.as(OTHER).mkdir('tmp/.npm-stage-5-nogroup', { recursive: true });
  root.mkdir('tmp/.npm-stage-5-nogroup/g', { mode: 0o770 });
  root.chown('tmp/.npm-stage-5-nogroup/g', 0, 65534);
  root.chmod('tmp/.npm-stage-5-nogroup/g', 0o770);
  root.writeFile('tmp/.npm-stage-5-nogroup/g/nogroup', 'root', { mode: 0o660 });
  await install('/m/t');
  assert.equal(root.exists('tmp/.npm-stage-5-nogroup/g/nogroup'), true, "a file only nogroup may remove is left");
  root.removeRecursive('tmp/.npm-stage-5-nogroup');
  // Nor of any gid at all, however its inode came to have it: here one made
  // by a credential whose gid is past any chown's.
  vfs.as(OTHER).mkdir('tmp/.npm-stage-6-any', { recursive: true });
  const odd = { ...CRED_KERNEL, gid: Number.MAX_SAFE_INTEGER + 1, groups: [], umask: 0 };
  vfs.as(odd).mkdir('tmp/.npm-stage-6-any/g', { mode: 0o770 });
  vfs.as(odd).writeFile('tmp/.npm-stage-6-any/g/any', 'root', { mode: 0o660 });
  await install('/m/t');
  assert.equal(root.exists('tmp/.npm-stage-6-any/g/any'), true, 'a file only its group may remove is left, whatever the group');
  root.removeRecursive('tmp/.npm-stage-6-any');
  console.log('  the sweep removes each stage as the user who owns it');
}

console.log('npm-install-async-mount: ok');
