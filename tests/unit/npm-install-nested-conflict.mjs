#!/usr/bin/env bun
// npm-install-nested-conflict — two dependents that need incompatible
// versions of one package both get the version they asked for.
//
// Measured live (2026-09, staging session dotted-fox-3461): a fresh
// `nuxi init` + `npm install` (758 packages, exit 0) put confbox@0.2.4 at
// node_modules/confbox while node_modules/pkg-types/package.json (2.3.3)
// declares `confbox: ^0.3.1`. The installer resolved one version per NAME,
// so the first range seen won and pkg-types was installed broken: 0.2.4 has
// no `./json` export and `nuxt dev` died with
// `Cannot find module 'confbox/json'`. Real npm installs 0.3.x under
// pkg-types/node_modules/confbox, which is where Node's upward
// node_modules walk from pkg-types finds it first.
//
// Modelled here as `app` → a@1, b@1; a → c@^1; b → c@^2. Whichever major
// wins root, the other dependent must carry its own copy, nested under
// itself and nowhere higher. Through the real NpmInstaller over real
// SQLite; the fan-out RPC is the seam.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { registryEntryFromResolved } from '../../packages/worker/src/npm/resolver.ts';
import { resolveVersion } from '../../packages/worker/src/npm/semver.ts';
import { makeFanoutEnv } from './npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;

/** The synthetic registry: name → version → dependencies (or { dependencies, peerDependencies }). */
const REGISTRY = {
  a: { '1.0.0': { c: '^1.0.0', d: '^2.0.0', e: '^1.0.0' } },
  b: { '1.0.0': { c: '^2.0.0' } },
  c: { '1.0.0': {}, '2.0.0': { d: '^1.0.0', e: '^1.0.0' } },
  d: { '1.0.0': {}, '2.0.0': {} },
  e: { '1.0.0': {} },
};

/** Answer a resolve task the way the packument facet would: max satisfying version. */
function resolveFromRegistry(name, spec) {
  const versions = REGISTRY[name] ?? {};
  const version = resolveVersion(Object.keys(versions), spec?.range ?? 'latest');
  if (!version) {
    return {
      pkg: null, deps: {}, peerDeps: {}, optionalDeps: {}, allPeerDependencies: {},
      cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
      error: { type: 'unresolved', reason: `no version of ${name} satisfies ${spec?.range}` },
    };
  }
  const entry = versions[version];
  const dependencies = entry.dependencies ?? entry;
  const peerDependencies = entry.peerDependencies;
  const pkg = {
    name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: `sha512-${name}-${version}`,
    dependencies, peerDependencies, exports: null, main: 'index.js', module: '', bin: {},
  };
  return {
    pkg, deps: pkg.dependencies, peerDeps: peerDependencies ?? {}, optionalDeps: {}, allPeerDependencies: peerDependencies ?? {},
    // The registry cache is what the next install's lock-check reads edges from.
    cacheWrites: [registryEntryFromResolved(pkg)],
    messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
  };
}

function makeInstaller(dependencies = { a: '^1.0.0', b: '^1.0.0' }) {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(NM, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'fixture', dependencies }));
  const log = [];
  const shardsSeen = [];
  const env = makeFanoutEnv({ root, NM, resultFor: resolveFromRegistry, shardsSeen });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = new NpmInstaller(vfs, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });
  return { installer, log, root, shardsSeen };
}

const versionAt = (root, dir) => JSON.parse(root.readFileString(`${NM}/${dir}/package.json`)).version;

const { installer, log, root, shardsSeen } = makeInstaller();
const first = await installer.install(PROJ, { pid: 1 });
assert.deepEqual(first.failed, [], `nothing fails: ${log.join('\n')}`);

// ── the conflict: root holds one major, the other dependent nests its own ──
{
  const rootMajor = versionAt(root, 'c').split('.')[0];
  assert.ok(rootMajor === '1' || rootMajor === '2', `root c is one of the two majors, got ${versionAt(root, 'c')}`);
  const [loser, wanted] = rootMajor === '1' ? ['b', '2.0.0'] : ['a', '1.0.0'];
  const winner = loser === 'b' ? 'a' : 'b';
  assert.equal(versionAt(root, `${loser}/node_modules/c`), wanted, `${loser} gets the c it declared, nested under itself`);
  assert.equal(root.exists(`${NM}/${winner}/node_modules/c`), false, 'the dependent root satisfies gets no copy');
  console.log(`  root c@${versionAt(root, 'c')}; ${loser}/node_modules/c@${wanted}`);
}

// ── transitive: the nested copy's own unsatisfied edge nests under IT ──────
{
  assert.equal(versionAt(root, 'd'), '2.0.0', 'root d is what a asked for');
  assert.equal(versionAt(root, 'b/node_modules/c/node_modules/d'), '1.0.0', 'nested c@2 gets d@1 under its own placement');
  assert.equal(root.exists(`${NM}/b/node_modules/d`), false, 'never higher than the dependent that needs it');
}

// ── reuse: an edge root already satisfies creates no duplicate ─────────────
{
  assert.equal(versionAt(root, 'e'), '1.0.0');
  assert.equal(root.exists(`${NM}/b/node_modules/c/node_modules/e`), false, 'nested c@2 reuses root e@1');
  assert.equal(root.exists(`${NM}/b/node_modules/e`), false);
}

// ── the lockfile records placements; the summary names the nested count ────
{
  const lock = installer.npmCache.readLockfile(PROJ);
  const placements = [...lock.keys()].sort();
  assert.deepEqual(placements, ['a', 'b', 'b/node_modules/c', 'b/node_modules/c/node_modules/d', 'c', 'd', 'e'], 'lockfile lists both placements of c and of d');
  assert.equal(lock.get('b/node_modules/c').name, 'c');
  assert.equal(lock.get('b/node_modules/c').resolvedVer, '2.0.0');
  assert.equal(lock.get('b/node_modules/c').hoistedPath, `${NM}/b/node_modules/c`);
  const summary = log.find((l) => l.startsWith('Done!'));
  assert.ok(summary, `a Done! line: ${log.join('\n')}`);
  assert.match(summary, /^Done! 7 packages \(2 nested\),/, summary);
  assert.equal(first.installed.length, 7, 'every placement counts');
  console.log(`  ${summary}`);
}

// ── a second install is a lock-check no-op, and keeps the tree ─────────────
{
  const shardsBefore = shardsSeen.length;
  log.length = 0;
  const second = await installer.install(PROJ, { pid: 1 });
  assert.deepEqual(second.failed, []);
  assert.ok(log.some((l) => l.startsWith('Lockfile valid')), `lock-check accepts the nested tree: ${log.join('\n')}`);
  assert.equal(shardsSeen.length, shardsBefore, 'nothing is re-fetched');
  assert.equal(second.cachedHits, 7, 'every placement is already installed');
  assert.equal(versionAt(root, 'b/node_modules/c'), '2.0.0', 'the nested copy survives');
  const summary = log.find((l) => l.startsWith('Done!'));
  assert.match(summary, /^Done! 7 packages \(2 nested\),/, summary);
  console.log('  second install: lock-check no-op, tree intact');
}

// ── a peer edge never nests: the host provides it, mismatched or not ────────
//
// A nested duplicate of a peer is worse than a mismatched shared copy (two
// Reacts break hooks; npm refuses with ERESOLVE rather than duplicating).
// `pc` peers on c@^2 while root holds c@1.0.0: no nested c, one warn line
// the way npm warns, one c row in the lockfile.
{
  Object.assign(REGISTRY, { pc: { '1.0.0': { dependencies: {}, peerDependencies: { c: '^2.0.0' } } } });
  const peer = makeInstaller({ a: '^1.0.0', pc: '^1.0.0' });
  const result = await peer.installer.install(PROJ, { pid: 1 });
  assert.deepEqual(result.failed, [], peer.log.join('\n'));
  assert.equal(versionAt(peer.root, 'c'), '1.0.0');
  assert.equal(peer.root.exists(`${NM}/pc/node_modules/c`), false, 'a peer edge is never nested');
  const warn = peer.log.find((l) => /\[warn\] peer c@\^2\.0\.0 from pc is met by c@1\.0\.0 \(c\)/.test(l));
  assert.ok(warn, `the mismatch is warned once: ${peer.log.join('\n')}`);
  assert.equal(peer.log.filter((l) => /\[warn\] peer c@/.test(l)).length, 1);
  const lock = peer.installer.npmCache.readLockfile(PROJ);
  assert.deepEqual([...lock.keys()].filter((k) => lock.get(k).name === 'c'), ['c'], 'one c row');
  assert.ok(!peer.log.some((l) => /nested\)/.test(l)), 'nothing nested');
  console.log(`  peer: ${warn.trim()}`);
}

// ── shadowing: a copy nested under an ancestor cannot break what is beneath ──
//
// `app → a@1 → c@^2`, `app → c@^1`, `a → b@^1 → c@^1` with `app → b@2` so b
// nests under a. Root c@1 and a/node_modules/c@2; a/node_modules/b's walk
// now finds a/node_modules/c first, which does not satisfy ^1, so b gets
// its own c@1 beneath it.
{
  Object.assign(REGISTRY, {
    sa: { '1.0.0': { c: '^2.0.0', sb: '^1.0.0' } },
    sb: { '1.0.0': { c: '^1.0.0' }, '2.0.0': {} },
  });
  const sh = makeInstaller({ c: '^1.0.0', sa: '^1.0.0', sb: '^2.0.0' });
  const result = await sh.installer.install(PROJ, { pid: 1 });
  assert.deepEqual(result.failed, [], sh.log.join('\n'));
  assert.equal(versionAt(sh.root, 'c'), '1.0.0');
  assert.equal(versionAt(sh.root, 'sb'), '2.0.0');
  assert.equal(versionAt(sh.root, 'sa/node_modules/c'), '2.0.0');
  assert.equal(versionAt(sh.root, 'sa/node_modules/sb'), '1.0.0');
  assert.equal(versionAt(sh.root, 'sa/node_modules/sb/node_modules/c'), '1.0.0', 'sb beneath sa is not left against sa/node_modules/c@2');
  console.log('  shadow: sa/node_modules/sb/node_modules/c@1.0.0 beneath sa/node_modules/c@2.0.0');
}

// ── a cycle with mutually incompatible ranges ends, and says why ───────────
//
// x@1 → y@^2, y@2 → x@^2, x@2 → y@^1, y@1 → x@^1: every copy needs a copy of
// the other under it, so no finite tree satisfies every edge. The walk must
// stop at its depth cap and fail the install with a reason, not spin.
{
  Object.assign(REGISTRY, {
    x: { '1.0.0': { y: '^2.0.0' }, '2.0.0': { y: '^1.0.0' } },
    y: { '1.0.0': { x: '^1.0.0' }, '2.0.0': { x: '^2.0.0' } },
  });
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const cycleRoot = vfs.as(CRED_KERNEL);
  cycleRoot.mkdir(NM, { recursive: true });
  cycleRoot.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'cycle', dependencies: { x: '1.0.0' } }));
  const cycleLog = [];
  const env = makeFanoutEnv({ root: cycleRoot, NM, resultFor: resolveFromRegistry });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const cycleInstaller = new NpmInstaller(vfs, harness.sql, { env, ctx, onProgress: (msg) => cycleLog.push(msg) });
  const result = await cycleInstaller.install(PROJ, { pid: 1 });
  assert.ok(result.failed.length > 0, `the unsatisfiable edge is a failure: ${cycleLog.join('\n')}`);
  const reason = cycleLog.find((l) => /nest deeper than/.test(l));
  assert.ok(reason, `the reason names the cycle: ${cycleLog.join('\n')}`);
  assert.ok(!cycleLog.some((l) => l.startsWith('Done!')), 'no success line over a broken tree');
  console.log(`  cycle: ${reason.trim()}`);
}

console.log('npm-install-nested-conflict: ok');
