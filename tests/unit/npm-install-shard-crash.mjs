#!/usr/bin/env bun
// npm-install-shard-crash — a Worker install whose fetch shard fails.
//
// Every shard settles on its own. What the other shards published, and what
// the failed shard published before it failed, is installed and recorded in
// the lockfile, so the next install's prune sees it; a package whose
// package.json landed although its shard's outcome was lost (a timed-out
// execution) is read back as installed. What did not land fails the install
// where it is required: exit 1, nothing removed, nothing saved; a copy
// that was there before, at the same version, is not taken for it, and a
// replacement of the same name@version is known by the receipt it writes
// after its package.json. Real
// NpmInstaller over real SQLite; the fan-out RPC is the seam.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { registryRecord } from '../../packages/worker/src/npm/registry-record.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { parseRegistryRequest } from '../../packages/core/src/_shared/npm-spec.ts';
import { kernelInstaller, makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;

function project() {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(NM, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'app', version: '1.0.0' }));
  const crash = { at: null, when: null };
  const env = makeFanoutEnv({
    root, NM,
    resultFor: (name) => {
      const pkg = { name, version: '1.0.0', tarballUrl: `https://registry.invalid/${name}-1.0.0.tgz`, integrity: `sha512-${name}`, dependencies: {}, exports: null, main: 'index.js', module: '', bin: {} };
      return { pkg, cacheWrites: [registryRecord(pkg, Date.now())], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [] };
    },
    crashFor: (p) => (p.name === crash.at ? crash.when : null),
  });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} });
  return {
    installer, root, crash,
    locked: () => [...(installer.npmCache.readLockfile(PROJ) ?? new Map()).keys()].sort(),
    declared: () => JSON.parse(root.readFileString(`${PROJ}/package.json`)).dependencies ?? {},
  };
}

// ── a shard that fails before its package lands ──────────────────────────────
{
  const { installer, root, crash, locked, declared } = project();
  Object.assign(crash, { at: 'b', when: 'before' });
  const result = await installer.install(PROJ, { packages: ['a', 'b'] });
  assert.deepEqual(result.failed, ['b@1.0.0'], 'the package that did not land fails the install');
  assert.deepEqual(result.installed, ['a@1.0.0'], 'what the other shard published is installed');
  assert.ok(root.exists(`${NM}/a/package.json`));
  assert.equal(root.exists(`${NM}/b`), false);
  assert.deepEqual(locked(), ['a'], 'the lockfile records what is on disk');
  assert.deepEqual(declared(), {}, 'a failed install saves nothing');

  // The next install's prune sees what landed: nothing declares it, so it goes.
  Object.assign(crash, { at: null, when: null });
  const next = await installer.install(PROJ, {});
  assert.deepEqual(next.failed, []);
  assert.equal(root.exists(`${NM}/a`), false, 'what the failed install published is extraneous to the next');
  assert.deepEqual(locked(), []);
}

// ── a shard whose outcome is lost after its package landed ───────────────────
{
  const { installer, root, crash, locked, declared } = project();
  Object.assign(crash, { at: 'b', when: 'after' });
  const result = await installer.install(PROJ, { packages: ['a', 'b'] });
  assert.deepEqual(result.failed, [], 'read back from disk: b landed');
  assert.deepEqual([...result.installed].sort(), ['a@1.0.0', 'b@1.0.0']);
  assert.ok(root.exists(`${NM}/b/package.json`));
  assert.deepEqual(locked(), ['a', 'b']);
  assert.deepEqual(declared(), { a: '^1.0.0', b: '^1.0.0' });
}

// ── a replacement whose shard fails before it writes, over a copy at the same version ──
// The copy there before names the version the replacement does: it is no
// evidence the replacement landed (its files are not this batch's), even
// where the clock has not moved since it was written, or the old copy's
// manifest is touched meanwhile. Nor is a copy of the very name@version
// it replaces (another tarball). The install fails, and the tree, the
// lockfile and package.json are as they were.
for (const [clock, touched, replacement] of [['running', false, 'slot@npm:real-b@1.0.0'], ['frozen', false, 'slot@npm:real-b@1.0.0'], ['running', true, 'slot@npm:real-b@1.0.0'], ['running', true, 'slot@npm:real-a@1.0.0']]) {
  const realNow = Date.now;
  if (clock === 'frozen') { const at = realNow(); Date.now = () => at; }
  try {
  const REGISTRY = { 'real-a': { d: '1.0.0' }, 'real-b': {}, d: {} };
  // real-a@1.0.0's tarball, which the registry changes for the last case.
  let realA = 'sha512-real-a';
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(NM, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'app', version: '1.0.0' }));
  const crash = { at: null, when: null };
  const env = makeFanoutEnv({
    root, NM,
    resultFor: (name, spec) => {
      const { registryName } = parseRegistryRequest(name, spec.range);
      const pkg = { name, registryName, version: '1.0.0', tarballUrl: `https://registry.invalid/${registryName}-1.0.0.tgz`, integrity: registryName === 'real-a' ? realA : `sha512-${registryName}`, dependencies: REGISTRY[registryName], exports: null, main: 'index.js', module: '', bin: {} };
      return { pkg, cacheWrites: [registryRecord({ ...pkg, name: registryName }, Date.now())], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [] };
    },
    manifestFor: (p) => ({ name: p.tarballUrl.match(/registry\.invalid\/(.+)-1\.0\.0\.tgz/)[1], version: p.version }),
    crashFor: (p) => {
      if (p.name !== crash.at) return null;
      // Something else touches the manifest there while the shard runs.
      if (touched) root.utimes(`${NM}/slot/package.json`, Date.now() + 1000, Date.now() + 1000);
      return crash.when;
    },
  });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} });
  const lockfile = () => [...installer.npmCache.readLockfile(PROJ)].map(([at, entry]) => `${at}=${entry.registryName}@${entry.resolvedVer}`).sort();

  assert.deepEqual((await installer.install(PROJ, { packages: ['slot@npm:real-a@1.0.0'] })).failed, []);
  const before = { lock: lockfile(), json: root.readFileString(`${PROJ}/package.json`) };
  assert.deepEqual(before.lock, ['d=d@1.0.0', 'slot=real-a@1.0.0']);

  Object.assign(crash, { at: 'slot', when: 'before' });
  realA = 'sha512-real-a-republished';
  const result = await installer.install(PROJ, { packages: [replacement] });
  assert.deepEqual(result.failed, ['slot@1.0.0'], `${replacement} (${clock} clock${touched ? ', touched' : ''}): the replacement did not land`);
  assert.equal(JSON.parse(root.readFileString(`${NM}/slot/package.json`)).name, 'real-a', 'the copy there is the one installed before');
  assert.equal(installer.npmCache.readLockfile(PROJ).get('slot').integrity, 'sha512-real-a', 'and the lockfile says so');
  assert.ok(root.exists(`${NM}/d/package.json`), 'what it needs is kept');
  assert.deepEqual(lockfile(), before.lock, 'the lockfile records what is on disk');
  assert.equal(root.readFileString(`${PROJ}/package.json`), before.json, 'nothing is saved');
  } finally {
    Date.now = realNow;
  }
}

// ── a replacement of the same name@version whose shard's answer is lost after it landed ──
// The copy there before names the package already, so the batch reads its
// receipt back: it landed, and is installed; nothing of the receipts is
// left. Touched meanwhile or not, one whose shard wrote nothing did not.
for (const [when, touched] of [['after', false], ['after', true], ['before', true]]) {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(NM, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'app', version: '1.0.0' }));
  let integrity = 'sha512-x';
  const crash = { at: null };
  const env = makeFanoutEnv({
    root, NM,
    resultFor: (name) => {
      const pkg = { name, registryName: name, version: '1.0.0', tarballUrl: `https://registry.invalid/${name}-1.0.0.tgz`, integrity, dependencies: {}, exports: null, main: 'index.js', module: '', bin: {} };
      return { pkg, cacheWrites: [registryRecord(pkg, Date.now())], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [] };
    },
    manifestFor: (p) => ({ name: p.name, version: p.version, integrity: p.integrity }),
    crashFor: (p) => {
      if (p.name !== crash.at) return null;
      if (touched) root.utimes(`${NM}/x/package.json`, Date.now() + 1000, Date.now() + 1000);
      return when;
    },
  });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} });
  assert.deepEqual((await installer.install(PROJ, { packages: ['x@1.0.0'] })).failed, []);

  // The registry's x@1.0.0 is another tarball now.
  integrity = 'sha512-x-republished';
  crash.at = 'x';
  const result = await installer.install(PROJ, { packages: ['x@1.0.0'] });
  const label = `${when}${touched ? ', touched' : ''}`;
  const landed = when === 'after';
  assert.deepEqual(result.failed, landed ? [] : ['x@1.0.0'], `${label}: ${landed ? 'its receipt says it landed' : 'no receipt: it did not'}`);
  assert.equal(JSON.parse(root.readFileString(`${NM}/x/package.json`)).integrity, landed ? 'sha512-x-republished' : 'sha512-x', label);
  assert.equal(installer.npmCache.readLockfile(PROJ).get('x').integrity, landed ? 'sha512-x-republished' : 'sha512-x', `${label}: the lockfile records what is on disk`);
  assert.equal(root.exists(`${NM}/.nimbus-receipts`), false, `${label}: no receipt is left`);
}

// ── receipts go through the namespace: one mounted where they go is read there ──
// The waves write through the invoking principal's namespace, so a mount at
// the receipts folder holds them; read back and removed through the same
// namespace, the replacement is known to have landed, and the mount is left
// with nothing of the batch.
{
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(`${NM}/.nimbus-receipts`, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'app', version: '1.0.0' }));
  const files = new ProcessFiles(vfs);
  const mounted = new MemoryVFS({ uid: 0, gid: 0 });
  files.vfs.mount(`/${NM}/.nimbus-receipts`, mounted);
  let integrity = 'sha512-x';
  const crash = { at: null };
  const env = makeFanoutEnv({
    root, NM,
    resultFor: (name) => {
      const pkg = { name, registryName: name, version: '1.0.0', tarballUrl: `https://registry.invalid/${name}-1.0.0.tgz`, integrity, dependencies: {}, exports: null, main: 'index.js', module: '', bin: {} };
      return { pkg, cacheWrites: [registryRecord(pkg, Date.now())], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [] };
    },
    manifestFor: (p) => ({ name: p.name, version: p.version, integrity: p.integrity }),
    crashFor: (p) => (p.name === crash.at ? 'after' : null),
    writeReceipt: (path) => mounted.writeFile(path.slice(`${NM}/.nimbus-receipts`.length), new Uint8Array(0)),
  });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = new NpmInstaller(files, harness.sql, { env, ctx, onProgress: () => {} });
  const install = (options) => installer.install(PROJ, { pid: 1, cred: CRED_KERNEL, ...options });
  assert.deepEqual((await install({ packages: ['x@1.0.0'] })).failed, []);
  integrity = 'sha512-x-republished';
  crash.at = 'x';
  assert.deepEqual((await install({ packages: ['x@1.0.0'] })).failed, [], 'the receipt the namespace holds says it landed');
  assert.equal(installer.npmCache.readLockfile(PROJ).get('x').integrity, 'sha512-x-republished');
  assert.deepEqual(mounted.readdir('/').map(({ name }) => name), [], 'and nothing of the batch is left in the mount');
}

console.log('npm-install-shard-crash: ok');
process.exit(0);
