#!/usr/bin/env bun
// npm-ci — `npm ci` installs exactly what package-lock.json records.
//
// pi.dev/install.sh's managed install runs `npm ci --omit=dev` in a stage
// directory holding pi's published package.json + package-lock.json. The
// Nimbus npm answered "npm: unknown command 'ci'" and the installer failed.
// npm semantics pinned here: lock versions win over what the ranges would
// resolve today, nested placements are kept, --omit=dev drops dev entries,
// platform-native optional shards are skipped, node_modules is removed
// first, and a lock that is not npm's ideal tree for package.json fails
// before anything changes. Real NpmInstaller over real SQLite; the fan-out RPC is the
// seam, as in npm-install-nested-conflict.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { kernelInstaller, makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;
const tgz = (name, version) => `https://registry.invalid/${name}-${version}.tgz`;

const PACKAGE_JSON = { name: 'fixture', version: '1.0.0', dependencies: { a: '^1.0.0' }, devDependencies: { t: '^1.0.0' } };
const LOCK = {
  name: 'fixture',
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', version: '1.0.0', dependencies: { a: '^1.0.0' }, devDependencies: { t: '^1.0.0' } },
    'node_modules/a': {
      version: '1.0.0', resolved: tgz('a', '1.0.0'), integrity: 'sha512-a',
      dependencies: { b: '^1.0.0' }, optionalDependencies: { 'a-darwin': '1.0.0' }, bin: { 'a-cli': 'cli.js' },
    },
    'node_modules/a/node_modules/b': { version: '1.2.0', resolved: tgz('b', '1.2.0'), integrity: 'sha512-b1' },
    'node_modules/b': { version: '2.0.0', resolved: tgz('b', '2.0.0'), integrity: 'sha512-b2' },
    'node_modules/a-darwin': { version: '1.0.0', resolved: tgz('a-darwin', '1.0.0'), optional: true, os: ['darwin'], cpu: ['arm64'] },
    'node_modules/t': { version: '1.0.0', resolved: tgz('t', '1.0.0'), dev: true },
  },
};

function makeInstaller(pkgJson = PACKAGE_JSON, lock = LOCK, resolve = null, failFor = () => null) {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(PROJ, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify(pkgJson));
  root.writeFile(`${PROJ}/package-lock.json`, JSON.stringify(lock));
  // What an earlier install left behind.
  root.mkdir(`${NM}/stale`, { recursive: true });
  root.writeFile(`${NM}/stale/index.js`, 'module.exports = 1;');
  const resolveAsked = [];
  const shardsSeen = [];
  const log = [];
  const env = makeFanoutEnv({
    root, NM, shardsSeen, failFor,
    resultFor: (name, spec) => {
      resolveAsked.push(name);
      if (resolve) return resolve(name, spec);
      throw new Error(`npm ci must not resolve ${name}`);
    },
  });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });
  return { installer, root, resolveAsked, shardsSeen, log };
}

const versionAt = (root, dir) => JSON.parse(root.readFileString(`${NM}/${dir}/package.json`)).version;

// ── the lock is the tree: pinned versions, nested placement, bins ─────────
{
  const { installer, root, resolveAsked, shardsSeen, log } = makeInstaller();
  const result = await installer.install(PROJ, { pid: 1, fromLockfile: true, production: true });
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.deepEqual(resolveAsked, [], 'no registry resolution: the lock already decided every version');
  assert.equal(versionAt(root, 'a'), '1.0.0');
  assert.equal(versionAt(root, 'b'), '2.0.0');
  assert.equal(versionAt(root, 'a/node_modules/b'), '1.2.0', 'nested placement kept where the lock put it');
  assert.equal(root.exists(`${NM}/t`), false, '--omit=dev leaves dev entries out');
  assert.equal(root.exists(`${NM}/a-darwin`), false, 'a platform-native optional shard is skipped');
  assert.ok(!shardsSeen.includes('a-darwin') && !shardsSeen.includes('t'));
  assert.ok(root.exists(`${NM}/.bin/a-cli`), 'bins from the lock are linked');
  assert.equal(result.installed.length, 3);
  assert.equal(root.exists(`${NM}/stale`), false, 'the previous node_modules is cleared');
}

// ── without --omit=dev the dev entry installs too ─────────────────────────
{
  const { installer, root } = makeInstaller();
  const result = await installer.install(PROJ, { pid: 1, fromLockfile: true });
  assert.deepEqual(result.failed, []);
  assert.equal(versionAt(root, 't'), '1.0.0');
}

// ── out of sync with package.json: npm's ideal tree over the lock decides ──
//
// A lock whose root declares other dependencies than package.json is
// suspect (load-virtual checkRootEdges): the tree is built over it, fails
// before anything changes where it is not the lock's tree, and otherwise
// installs with its flags found again and what nothing reaches left out.
{
  const leaf = (name, version) => ({
    pkg: { name, version, tarballUrl: tgz(name, version), integrity: `sha512-${name}${version}`, dependencies: {}, exports: null, main: '', module: '', bin: {} },
    cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
  });

  const bumped = { ...PACKAGE_JSON, dependencies: { a: '^2.0.0' } };
  const stale = makeInstaller(bumped, LOCK, (name) => leaf(name, '2.0.0'));
  await assert.rejects(stale.installer.install(PROJ, { pid: 1, fromLockfile: true }), /in sync[\s\S]*Invalid: lock file's a@1\.0\.0 does not satisfy a@2\.0\.0/);
  assert.equal(stale.root.exists(`${NM}/a`), false, 'nothing installed from a stale lock');
  assert.equal(stale.root.exists(`${NM}/stale/index.js`), true, 'a rejected lock leaves the existing node_modules alone');

  const added = { ...PACKAGE_JSON, dependencies: { a: '^1.0.0', z: '^1.0.0' } };
  const missing = makeInstaller(added, LOCK, (name) => leaf(name, '1.0.0'));
  await assert.rejects(missing.installer.install(PROJ, { pid: 1, fromLockfile: true }), /in sync[\s\S]*Missing: z@1\.0\.0 from lock file/);
  assert.equal(missing.root.exists(`${NM}/stale/index.js`), true);

  // A root range the locked version still meets, and a dependency dropped:
  // the lock's tree, but for what nothing reaches any more.
  for (const [label, pkgJson, kept, gone] of [
    ['a narrowed range', { ...PACKAGE_JSON, dependencies: { a: '~1.0.0' } }, ['a', 'a/node_modules/b', 't'], ['b']],
    ['a dropped dependency', { ...PACKAGE_JSON, dependencies: {} }, ['t'], ['a', 'a/node_modules/b', 'b']],
  ]) {
    const { installer, root, resolveAsked, log } = makeInstaller(pkgJson);
    const result = await installer.install(PROJ, { pid: 1, fromLockfile: true });
    assert.deepEqual(result.failed, [], `${label}: ${log.join('\n')}`);
    assert.deepEqual(resolveAsked, [], `${label}: nothing is resolved`);
    for (const at of kept) assert.ok(root.exists(`${NM}/${at}/package.json`), `${label}: ${at} installs`);
    for (const at of gone) assert.equal(root.exists(`${NM}/${at}`), false, `${label}: ${at}, which nothing reaches, does not`);
  }

  const v1 = { lockfileVersion: 1, dependencies: {} };
  await assert.rejects(makeInstaller(PACKAGE_JSON, v1).installer.install(PROJ, { pid: 1, fromLockfile: true }), /lockfileVersion 1/);
}

// ── a swapped package under an alias installs in the folder the lock names ──
// The policy follows the registry identity (esbuild is swapped for its WASM
// build) and placement the declared name: the lock's `node_modules/build`,
// `name: "esbuild"` entry is resolved as the alias `build@npm:esbuild@<locked>`
// and lands in node_modules/build, never node_modules/esbuild.
{
  const pkgJson = { name: 'fixture', version: '1.0.0', dependencies: { build: 'npm:esbuild@^0.21.0' } };
  const lock = {
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0', dependencies: { build: 'npm:esbuild@^0.21.0' } },
      'node_modules/build': { name: 'esbuild', version: '0.21.5', resolved: tgz('esbuild', '0.21.5'), integrity: 'sha512-e' },
    },
  };
  const specs = [];
  const { installer, root, log } = makeInstaller(pkgJson, lock, (name, spec) => {
    specs.push({ name, range: spec.range });
    const pkg = {
      name, version: '0.21.5', tarballUrl: tgz('esbuild-wasm', '0.21.5'), integrity: 'sha512-w',
      dependencies: {}, exports: null, main: 'index.js', module: '', bin: {},
    };
    return {
      pkg,
      cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
    };
  });
  const result = await installer.install(PROJ, { pid: 1, fromLockfile: true });
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.deepEqual(specs, [{ name: 'build', range: 'npm:esbuild@0.21.5' }], 'resolved as an alias under the folder, at the locked version');
  assert.equal(versionAt(root, 'build'), '0.21.5', 'installed where the lock placed it');
  assert.equal(root.exists(`${NM}/esbuild`), false, 'nothing lands under the registry name');
}

// ── each swapped placement is its own: a nested copy at another version stays nested ──
{
  const pkgJson = { name: 'fixture', version: '1.0.0', dependencies: { esbuild: '^0.21.0', vite: '^5.0.0' } };
  const lock = {
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0', dependencies: { esbuild: '^0.21.0', vite: '^5.0.0' } },
      'node_modules/esbuild': { version: '0.21.5', resolved: tgz('esbuild', '0.21.5'), integrity: 'sha512-e21' },
      'node_modules/vite': { version: '5.0.0', resolved: tgz('vite', '5.0.0'), integrity: 'sha512-v', dependencies: { esbuild: '^0.19.0' } },
      'node_modules/vite/node_modules/esbuild': { version: '0.19.12', resolved: tgz('esbuild', '0.19.12'), integrity: 'sha512-e19' },
    },
  };
  const specs = [];
  const { installer, root, log } = makeInstaller(pkgJson, lock, (name, spec) => {
    specs.push({ name, range: spec.range });
    const version = spec.range.replace(/^npm:[^@]+@/, '');
    const pkg = {
      name, version, tarballUrl: tgz('esbuild-wasm', version), integrity: `sha512-w${version}`,
      dependencies: {}, exports: null, main: 'index.js', module: '', bin: {},
    };
    return {
      pkg,
      cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
    };
  });
  const result = await installer.install(PROJ, { pid: 1, fromLockfile: true });
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.deepEqual(specs.map(({ range }) => range).sort(), ['0.19.12', '0.21.5'], 'each placement resolved at its own locked version');
  assert.equal(versionAt(root, 'esbuild'), '0.21.5');
  assert.equal(versionAt(root, 'vite/node_modules/esbuild'), '0.19.12', 'the nested swap stays where the lock put it');
}

// ── a lock's rollup 3 is installed as locked: only rollup 4 is swapped ────────
// @rollup/wasm-node publishes 4.x only; swapping a pinned 3.29.4 resolved it
// to the target's latest 4.x. Vite 4's lock installs exactly as before.
{
  const pkgJson = { name: 'fixture', version: '1.0.0', dependencies: { rollup: '^3.27.1' } };
  const lock = {
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0', dependencies: { rollup: '^3.27.1' } },
      'node_modules/rollup': { version: '3.29.4', resolved: tgz('rollup', '3.29.4'), integrity: 'sha512-r3' },
    },
  };
  const specs = [];
  const { installer, root, log } = makeInstaller(pkgJson, lock, (name, spec) => {
    specs.push({ name, range: spec.range });
    throw new Error(`a locked rollup 3 is not resolved again (${name}@${spec.range})`);
  });
  const result = await installer.install(PROJ, { pid: 1, fromLockfile: true });
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.deepEqual(specs, [], 'installed from the lock entry, not swapped and re-resolved');
  assert.equal(versionAt(root, 'rollup'), '3.29.4');
}

// ── the command: needs a lock, then hands the clean install to the host ──────
{
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  const calls = [];
  let rejectLock = false;
  ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel, {
    installer: {
      async install(spec) {
        calls.push({ spec });
        if (rejectLock) throw new Error('`npm ci` can only install packages when your package.json and package-lock.json are in sync.');
        return { installed: ['a@1.0.0'], failed: [], totalFiles: 1 };
      },
    },
  }));
  await ws.exec('mkdir -p /home/user/proj/node_modules/stale && echo x > /home/user/proj/node_modules/stale/index.js && echo "{}" > /home/user/proj/package.json');
  const noLock = await ws.exec('cd /home/user/proj && npm ci');
  assert.equal(noLock.exitCode, 1);
  assert.match(noLock.stderr, /package-lock\.json/);
  assert.equal(calls.length, 0);

  await ws.exec('echo "{}" > /home/user/proj/package-lock.json');
  const r = await ws.exec('cd /home/user/proj && npm ci --omit=dev --ignore-scripts --no-audit');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spec.fromLockfile, true);
  assert.equal(calls[0].spec.production, true);
  assert.doesNotMatch(r.stderr, /unknown command/);

  // A lock the host rejects fails the command and leaves the project as it was.
  rejectLock = true;
  const rejected = await ws.exec('cd /home/user/proj && npm ci');
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /in sync/);
  assert.equal(await ws.vfs.as(CRED_KERNEL).exists('/home/user/proj/node_modules/stale/index.js'), true,
    'node_modules is not touched before the lock is accepted');
}

// ── an optional peer the lock records stays optional ───────────────────
//
// h declares p as an optional peer; p is in the lock as optional. When p's
// tarball fails, npm ci leaves p out and installs h.
{
  const pkgJson = { name: 'opt-peer', version: '1.0.0', dependencies: { h: '1.0.0' }, optionalDependencies: { p: '1.0.0' } };
  const lock = {
    name: 'opt-peer', lockfileVersion: 3,
    packages: {
      '': { name: 'opt-peer', version: '1.0.0', dependencies: { h: '1.0.0' }, optionalDependencies: { p: '1.0.0' } },
      'node_modules/h': { version: '1.0.0', resolved: tgz('h', '1.0.0'), integrity: 'sha512-h', peerDependencies: { p: '1.0.0' }, peerDependenciesMeta: { p: { optional: true } } },
      'node_modules/p': { version: '1.0.0', resolved: tgz('p', '1.0.0'), integrity: 'sha512-p', optional: true },
    },
  };
  const { installer, root, log } = makeInstaller(pkgJson, lock, null, (p) => (p.name === 'p' ? 'integrity mismatch' : null));
  const result = await installer.install(PROJ, { pid: 1, fromLockfile: true });
  assert.deepEqual(result.failed, [], `the optional peer's failure fails nothing: ${log.join('\n')}`);
  assert.equal(versionAt(root, 'h'), '1.0.0');
  assert.equal(root.exists(`${NM}/p`), false, 'p is left out');
}

// ── a stopped npm ci leaves node_modules as it was ───────────────────────
{
  const { installer, root } = makeInstaller();
  const stop = new AbortController();
  stop.abort(new DOMException('stopped', 'AbortError'));
  await assert.rejects(installer.install(PROJ, { pid: 1, fromLockfile: true, signal: stop.signal }), { name: 'AbortError' });
  assert.ok(root.exists(`${NM}/stale/index.js`), 'nothing was cleared');
}

// ── a stop after the plan publishes nothing ──────────────────────────────
{
  const stop = new AbortController();
  const { installer, root, log } = makeInstaller({ name: 'stop', version: '1.0.0', dependencies: { s: '1.0.0' } }, LOCK, (name) => ({
    pkg: { name, version: '1.0.0', tarballUrl: tgz(name, '1.0.0'), integrity: 'sha512-s', dependencies: {}, exports: null, main: '', module: '', bin: {} },
    cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
  }));
  const onProgress = (msg) => { log.push(msg); if (msg.startsWith('To fetch:')) stop.abort(new DOMException('stopped', 'AbortError')); };
  await assert.rejects(installer.install(PROJ, { pid: 1, signal: stop.signal, onProgress }), { name: 'AbortError' });
  assert.equal(root.exists(`${NM}/s`), false, 'nothing is published once the install is stopped');
}

// ── a partial npm ci records what is on disk, not the tree it cleared ───
{
  const pkgJson = { name: 'partial', version: '1.0.0', dependencies: { q: '1.0.0', r: '1.0.0' } };
  const lock = {
    name: 'partial', lockfileVersion: 3,
    packages: {
      '': { name: 'partial', version: '1.0.0', dependencies: { q: '1.0.0', r: '1.0.0' } },
      'node_modules/q': { version: '1.0.0', resolved: tgz('q', '1.0.0'), integrity: 'sha512-q' },
      'node_modules/r': { version: '1.0.0', resolved: tgz('r', '1.0.0'), integrity: 'sha512-r' },
    },
  };
  const { installer, root } = makeInstaller(pkgJson, lock, null, (p) => (p.name === 'r' ? 'integrity mismatch' : null));
  // What an earlier install recorded, in the tree npm ci clears.
  installer.npmCache.writeLockfile(PROJ, new Map([['old', { name: 'old', registryName: 'old', resolvedVer: '1.0.0', integrity: 'sha512-old', depsJson: '{}', hoistedPath: `${NM}/old` }]]), { storage: null });
  const result = await installer.install(PROJ, { pid: 1, fromLockfile: true });
  assert.ok(result.failed.length > 0);
  assert.deepEqual([...installer.npmCache.readLockfile(PROJ).keys()], ['q'], 'the inventory is what this npm ci left on disk');
  assert.equal(root.exists(`${NM}/old`), false);
}

// ── a lock in step with package.json keeps its own flags ─────────────────
//
// load-virtual keeps what the lock says of each entry, and --omit reads
// those flags: a devDependency the lock does not mark dev installs, a
// dependency it marks dev does not, and an extraneous dev entry is kept but
// omitted. Once the lock's root disagrees with package.json, the flags are
// found again and what nothing reaches goes.
{
  const entry = (name, extra = {}) => ({ version: '1.0.0', resolved: tgz(name, '1.0.0'), integrity: `sha512-${name}`, ...extra });
  const pkgJson = { name: 'flags', version: '1.0.0', dependencies: { p: '1.0.0' }, devDependencies: { d: '1.0.0' } };
  const lock = {
    name: 'flags', lockfileVersion: 3,
    packages: {
      '': { name: 'flags', version: '1.0.0', dependencies: { p: '1.0.0' }, devDependencies: { d: '1.0.0' } },
      'node_modules/p': entry('p', { dev: true }),
      'node_modules/d': entry('d'),
      'node_modules/x': entry('x', { dev: true, extraneous: true }),
      'node_modules/y': entry('y', { extraneous: true }),
    },
  };
  const omitDev = makeInstaller(pkgJson, lock);
  assert.deepEqual((await omitDev.installer.install(PROJ, { pid: 1, fromLockfile: true, production: true })).failed, [], omitDev.log.join('\n'));
  assert.deepEqual(['p', 'd', 'x', 'y'].filter((name) => omitDev.root.exists(`${NM}/${name}`)), ['d', 'y'], 'the lock\'s dev flags decide what --omit=dev leaves out');

  const suspect = makeInstaller({ ...pkgJson, dependencies: { p: '^1.0.0' } }, lock);
  assert.deepEqual((await suspect.installer.install(PROJ, { pid: 1, fromLockfile: true, production: true })).failed, [], suspect.log.join('\n'));
  assert.deepEqual(['p', 'd', 'x', 'y'].filter((name) => suspect.root.exists(`${NM}/${name}`)), ['p'], 'a suspect lock\'s flags are found again, and what nothing reaches goes');
}

// ── a trusted lock's flags decide what a failure costs, and what --omit=peer leaves out ──
//
// reify leaves a failed package out only where it is optional
// (_handleOptionalFailure): a package a required dev path and an optional
// one share is devOptional, not optional, and its failure fails npm ci. A
// package the lock marks peer is left out by --omit=peer.
{
  const entry = (name, extra = {}) => ({ version: '1.0.0', resolved: tgz(name, '1.0.0'), integrity: `sha512-${name}`, ...extra });
  const shared = (flags) => {
    const pkgJson = { name: 'shared', version: '1.0.0', devDependencies: { dev: '1.0.0' }, optionalDependencies: { opt: '1.0.0' } };
    return [pkgJson, {
      name: 'shared', lockfileVersion: 3,
      packages: {
        '': { name: 'shared', version: '1.0.0', devDependencies: { dev: '1.0.0' }, optionalDependencies: { opt: '1.0.0' } },
        'node_modules/dev': entry('dev', { dev: true, dependencies: { shared: '1.0.0' } }),
        'node_modules/opt': entry('opt', { optional: true, dependencies: { shared: '1.0.0' } }),
        'node_modules/shared': entry('shared', flags),
      },
    }];
  };
  const failShared = (p) => (p.name === 'shared' ? 'integrity mismatch for shared' : null);

  const required = makeInstaller(...shared({ devOptional: true }), null, failShared);
  const failed = await required.installer.install(PROJ, { pid: 1, fromLockfile: true });
  assert.deepEqual(failed.failed, ['shared@1.0.0'], `a devOptional package's failure fails npm ci: ${required.log.join('\n')}`);

  const optional = makeInstaller(...shared({ optional: true }), null, failShared);
  const left = await optional.installer.install(PROJ, { pid: 1, fromLockfile: true });
  assert.deepEqual(left.failed, [], `an optional package's failure leaves it out: ${optional.log.join('\n')}`);
  assert.equal(optional.root.exists(`${NM}/shared`), false);

  const pkgJson = { name: 'peers', version: '1.0.0', dependencies: { host: '1.0.0' } };
  const lock = {
    name: 'peers', lockfileVersion: 3,
    packages: {
      '': { name: 'peers', version: '1.0.0', dependencies: { host: '1.0.0' } },
      'node_modules/host': entry('host', { peerDependencies: { peer: '1.0.0' } }),
      'node_modules/peer': entry('peer', { peer: true }),
    },
  };
  const omitPeer = makeInstaller(pkgJson, lock);
  assert.deepEqual((await omitPeer.installer.install(PROJ, { pid: 1, fromLockfile: true, omitPeer: true })).failed, [], omitPeer.log.join('\n'));
  assert.ok(omitPeer.root.exists(`${NM}/host/package.json`));
  assert.equal(omitPeer.root.exists(`${NM}/peer`), false, '--omit=peer leaves out what the lock marks peer');
}

// ── bundled entries: what a package bundles comes in its archive; what the project bundles installs ──
//
// npm records `inBundle` for both (node.inBundle); only a package's bundle
// is left out of separate extraction (inDepBundle).
{
  const pkgJson = { name: 'bundling', version: '1.0.0', dependencies: { own: '1.0.0', carrier: '1.0.0' }, bundleDependencies: ['own'] };
  const lock = {
    name: 'bundling', lockfileVersion: 3,
    packages: {
      '': { name: 'bundling', version: '1.0.0', dependencies: { own: '1.0.0', carrier: '1.0.0' }, bundleDependencies: ['own'] },
      'node_modules/own': { version: '1.0.0', resolved: tgz('own', '1.0.0'), integrity: 'sha512-own', inBundle: true },
      'node_modules/carrier': { version: '1.0.0', resolved: tgz('carrier', '1.0.0'), integrity: 'sha512-carrier', dependencies: { inner: '1.0.0' }, bundleDependencies: ['inner'] },
      'node_modules/carrier/node_modules/inner': { version: '1.0.0', inBundle: true },
    },
  };
  const { installer, root, resolveAsked, shardsSeen, log } = makeInstaller(pkgJson, lock);
  const result = await installer.install(PROJ, { pid: 1, fromLockfile: true });
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.deepEqual(resolveAsked, []);
  assert.equal(versionAt(root, 'own'), '1.0.0', "what the project bundles is installed");
  assert.deepEqual([...shardsSeen].sort(), ['carrier', 'own'], "what a package bundles is not fetched on its own");
}

// ── a lock that does not meet its own dependencies fails before anything changes ──
//
// npm ci builds the ideal tree over the lock and checks it is the lock's
// (validate-lockfile): a package the lock lacks, or one an edge it records
// does not accept, fails the command before node_modules is cleared.
for (const [label, entries, line] of [
  ['a dependency the lock lacks', {}, /Missing: b@1\.2\.0 from lock file/],
  // npm places the copy a accepts at the highest folder it fits, the root,
  // and keeps the nested one (an older copy does not dedupe a newer).
  ['a dependency the lock holds at a version its dependent does not accept', {
    'node_modules/a/node_modules/b': { version: '2.0.0', resolved: tgz('b', '2.0.0'), integrity: 'sha512-b2' },
  }, /Missing: b@1\.2\.0 from lock file/],
]) {
  const pkgJson = { name: 'unsound', version: '1.0.0', dependencies: { a: '1.0.0' } };
  const lock = {
    name: 'unsound', lockfileVersion: 3,
    packages: {
      '': { name: 'unsound', version: '1.0.0', dependencies: { a: '1.0.0' } },
      'node_modules/a': { version: '1.0.0', resolved: tgz('a', '1.0.0'), integrity: 'sha512-a', dependencies: { b: '^1.0.0' } },
      ...entries,
    },
  };
  const { installer, root } = makeInstaller(pkgJson, lock, (name) => ({
    pkg: { name, version: '1.2.0', tarballUrl: tgz(name, '1.2.0'), integrity: `sha512-${name}`, dependencies: {}, exports: null, main: '', module: '', bin: {} },
    cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
  }));
  await assert.rejects(installer.install(PROJ, { pid: 1, fromLockfile: true }), line, label);
  assert.ok(root.exists(`${NM}/stale/index.js`), `${label}: node_modules is left as it was`);
}

console.log('npm-ci: ok');
process.exit(0);
