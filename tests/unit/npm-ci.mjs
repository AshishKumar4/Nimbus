#!/usr/bin/env bun
// npm-ci — `npm ci` installs exactly what package-lock.json records.
//
// pi.dev/install.sh's managed install runs `npm ci --omit=dev` in a stage
// directory holding pi's published package.json + package-lock.json. The
// Nimbus npm answered "npm: unknown command 'ci'" and the installer failed.
// npm semantics pinned here: lock versions win over what the ranges would
// resolve today, nested placements are kept, --omit=dev drops dev entries,
// platform-native optional shards are skipped, node_modules is removed
// first, and a lock out of sync with package.json fails instead of
// re-resolving. Real NpmInstaller over real SQLite; the fan-out RPC is the
// seam, as in npm-install-nested-conflict.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { makeFanoutEnv } from './npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

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

function makeInstaller(pkgJson = PACKAGE_JSON, lock = LOCK, resolve = null) {
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
    root, NM, shardsSeen,
    resultFor: (name, spec) => {
      resolveAsked.push(name);
      if (resolve) return resolve(name, spec);
      throw new Error(`npm ci must not resolve ${name}`);
    },
  });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = new NpmInstaller(vfs, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });
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

// ── out of sync with package.json: fail, never re-resolve ─────────────────
{
  const bumped = { ...PACKAGE_JSON, dependencies: { a: '^2.0.0' } };
  const { installer, root, resolveAsked } = makeInstaller(bumped);
  await assert.rejects(installer.install(PROJ, { pid: 1, fromLockfile: true }), /in sync[\s\S]*a@\^2\.0\.0/);
  assert.deepEqual(resolveAsked, []);
  assert.equal(root.exists(`${NM}/a`), false, 'nothing installed from a stale lock');
  assert.equal(root.exists(`${NM}/stale/index.js`), true, 'a rejected lock leaves the existing node_modules alone');

  const removed = { ...PACKAGE_JSON, dependencies: {} };
  await assert.rejects(makeInstaller(removed).installer.install(PROJ, { pid: 1, fromLockfile: true }), /in sync[\s\S]*\ba\b.*package\.json does not declare/);

  const added = { ...PACKAGE_JSON, dependencies: { a: '^1.0.0', z: '^1.0.0' } };
  await assert.rejects(makeInstaller(added).installer.install(PROJ, { pid: 1, fromLockfile: true }), /in sync[\s\S]*z@\^1\.0\.0/);

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
      pkg, deps: {}, peerDeps: {}, optionalDeps: {}, allPeerDependencies: {},
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
      pkg, deps: {}, peerDeps: {}, optionalDeps: {}, allPeerDependencies: {},
      cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
    };
  });
  const result = await installer.install(PROJ, { pid: 1, fromLockfile: true });
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.deepEqual(specs.map(({ range }) => range).sort(), ['0.19.12', '0.21.5'], 'each placement resolved at its own locked version');
  assert.equal(versionAt(root, 'esbuild'), '0.21.5');
  assert.equal(versionAt(root, 'vite/node_modules/esbuild'), '0.19.12', 'the nested swap stays where the lock put it');
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
  await ws.exec('mkdir -p /proj/node_modules/stale && echo x > /proj/node_modules/stale/index.js && echo "{}" > /proj/package.json');
  const noLock = await ws.exec('cd /proj && npm ci');
  assert.equal(noLock.exitCode, 1);
  assert.match(noLock.stderr, /package-lock\.json/);
  assert.equal(calls.length, 0);

  await ws.exec('echo "{}" > /proj/package-lock.json');
  const r = await ws.exec('cd /proj && npm ci --omit=dev --ignore-scripts --no-audit');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spec.fromLockfile, true);
  assert.equal(calls[0].spec.production, true);
  assert.doesNotMatch(r.stderr, /unknown command/);

  // A lock the host rejects fails the command and leaves the project as it was.
  rejectLock = true;
  const rejected = await ws.exec('cd /proj && npm ci');
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /in sync/);
  assert.equal(await ws.vfs.as(CRED_KERNEL).exists('/proj/node_modules/stale/index.js'), true,
    'node_modules is not touched before the lock is accepted');
}

console.log('npm-ci: ok');
process.exit(0);
