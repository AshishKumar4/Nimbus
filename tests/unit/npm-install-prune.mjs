#!/usr/bin/env bun
// npm-install-prune — `npm install` removes what the project no longer needs.
//
// npm prunes extraneous packages on install ("In normal operation,
// extraneous modules are pruned automatically", npm-prune(1)). Nimbus kept
// every package an earlier install placed: a dependency dropped from
// package.json stayed in node_modules and in the lockfile, and so did the
// optional peers installs added before 0.15. Measured 2026-10-01 in this
// harness: install {a, c}, drop c, install again; c stayed.
//
// Through the real NpmInstaller over real SQLite; the fan-out RPC is the seam.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { resolveVersion } from '../../packages/worker/src/npm/semver.ts';
import { kernelInstaller, makeFanoutEnv, cacheRowForPackage } from './npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;

/** name -> version -> manifest fields beyond name and version. */
const REGISTRY = {
  a: { '1.0.0': { dependencies: { b: '^1.0.0', d: '^1.0.0' } }, '1.1.0': { dependencies: { b: '^1.0.0', d: '^1.0.0' } } },
  b: { '1.0.0': {} },
  c: { '1.0.0': { dependencies: { d: '^2.0.0' }, bin: { 'c-cli': 'cli.js' } } },
  d: { '1.0.0': {}, '2.0.0': {} },
  e: { '1.0.0': { bin: { 'e-cli': 'cli.js' } } },
};

function resolveFromRegistry(name, spec) {
  const versions = REGISTRY[name] ?? {};
  const version = resolveVersion(Object.keys(versions), spec?.range ?? 'latest');
  if (!version) {
    return {
      pkg: null, deps: {}, peerDeps: {}, optionalDeps: {},
      cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
      error: { type: 'unresolved', reason: `no version of ${name} satisfies ${spec?.range}` },
    };
  }
  const { dependencies = {}, bin = {} } = versions[version];
  const pkg = {
    name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: `sha512-${name}-${version}`,
    dependencies, exports: null, main: 'index.js', module: '', bin,
  };
  return {
    pkg, deps: dependencies, peerDeps: {}, optionalDeps: {},
    cacheWrites: [cacheRowForPackage(pkg)],
    messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
  };
}

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
root.mkdir(NM, { recursive: true });
const log = [];
const env = makeFanoutEnv({ root, NM, resultFor: resolveFromRegistry });
const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });

const declare = (dependencies) => root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'fixture', dependencies }));
const install = async (options) => {
  log.length = 0;
  const result = await installer.install(PROJ, { pid: 1, ...options });
  assert.deepEqual(result.failed, [], `nothing fails: ${log.join('\n')}`);
};
const placements = () => [...(installer.npmCache.readLockfile(PROJ)?.keys() ?? [])].sort();
const present = (placement) => root.exists(`${NM}/${placement}/package.json`);
const bins = () => Object.keys(JSON.parse(root.readFileString(`${NM}/.bin/.nimbus-bin-map.json`)).bins).sort();

declare({ a: '^1.0.0', c: '^1.0.0' });
await install();
assert.deepEqual(placements(), ['a', 'b', 'c', 'c/node_modules/d', 'd']);
assert.ok(root.exists(`${NM}/.bin/c-cli`), 'c links its bin');

// ── a dropped dependency goes, with what only it needed and its bin ───────
{
  declare({ a: '^1.0.0' });
  await install();
  assert.ok(log.some((line) => line.startsWith('Lockfile valid')), `the lockfile is replayed: ${log.join('\n')}`);
  assert.deepEqual(placements(), ['a', 'b', 'd'], 'the lockfile holds what the project needs');
  assert.equal(present('c'), false, 'c is removed');
  assert.equal(root.exists(`${NM}/c`), false, 'with its nested copy of d');
  assert.ok(present('a') && present('b') && present('d'), 'what the project still needs stays');
  assert.equal(root.exists(`${NM}/.bin/c-cli`), false, 'c\'s bin is unlinked');
  assert.ok(log.some((line) => line === 'removed 2 extraneous packages: c, c/node_modules/d'), log.join('\n'));
}

// ── a re-resolve prunes too ─────────────────────────────────────────────
{
  declare({ a: '^1.0.0', e: '^1.0.0' });
  await install();
  assert.deepEqual(bins(), ['e-cli']);
  // d@1 is locked; the project now asks for d@2 itself.
  declare({ a: '^1.0.0', d: '^2.0.0' });
  await install();
  assert.ok(log.some((line) => line.startsWith('Lockfile outdated')), `the tree is resolved again: ${log.join('\n')}`);
  assert.deepEqual(placements(), ['a', 'a/node_modules/d', 'b', 'd']);
  assert.equal(present('e'), false, 'e is removed');
  assert.equal(root.exists(`${NM}/.bin/e-cli`), false, 'and its bin');
  assert.equal(root.exists(`${NM}/.bin/.nimbus-bin-map.json`) && bins().includes('e-cli'), false, 'the bin manifest forgets it');
}

// ── `npm install <pkg>` adds and removes nothing else ──────────────────────
{
  await install({ packages: ['e@^1.0.0'] });
  assert.ok(present('a') && present('b') && present('d') && present('e'), 'everything stays');
  assert.ok(!log.some((line) => line.startsWith('removed')), log.join('\n'));
}

// ── an installed tree that matches the project removes nothing ───────────
{
  declare({ a: '^1.0.0', d: '^2.0.0', e: '^1.0.0' });
  await install();
  await install();
  assert.ok(!log.some((line) => line.startsWith('removed')), log.join('\n'));
  assert.deepEqual(placements(), ['a', 'a/node_modules/d', 'b', 'd', 'e']);
}

// ── `npm install <pkg>` keeps the inventory a later prune reads ──────────
{
  declare({ a: '^1.0.0', c: '^1.0.0' });
  await install();
  await install({ packages: ['e@^1.0.0'] });
  assert.ok(placements().includes('c') && placements().includes('e'), 'the lockfile holds the old tree and the addition');
  declare({ a: '^1.0.0', e: '^1.0.0' });
  await install();
  assert.equal(present('c'), false, 'a dependency dropped after an explicit add is still pruned');
  assert.deepEqual(placements(), ['a', 'b', 'd', 'e']);
}

// ── a declared package the resolver could not resolve is not pruned ────────
{
  declare({ a: '^1.0.0', e: '^9.0.0' });
  const result = await installer.install(PROJ, { pid: 1 });
  assert.deepEqual(result.failed, ['e'], 'the install fails for e');
  assert.ok(present('e'), 'and leaves the installed e where it was');
  assert.ok(root.exists(`${NM}/.bin/e-cli`), 'with its bin');
}

// ── a project that needs nothing any more removes everything ──────────────
{
  declare({});
  await install();
  assert.deepEqual(placements(), [], 'the lockfile is empty');
  for (const name of ['a', 'b', 'd', 'e']) assert.equal(present(name), false, `${name} is removed`);
  assert.equal(root.exists(`${NM}/.bin/e-cli`), false, 'and its bin');
}

console.log('npm-install-prune: ok');
