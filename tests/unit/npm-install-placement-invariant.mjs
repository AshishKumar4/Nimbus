#!/usr/bin/env bun
// npm-install-placement-invariant — every dependency edge in an installed
// tree is met by the copy Node's walk from the dependent finds first.
//
// The nested-placement rule (npm-install-nested-conflict.mjs) is only
// correct if a copy nested under a package can never shadow, for something
// beneath that package, a higher copy that thing was decided against. The
// walk makes that structurally impossible: a copy nested under P is decided
// in the layer right after P resolves, before anything beneath P can
// resolve, so a descendant's edge always sees it pending (and waits) or
// placed. Rather than trust the argument, this runs seeded random
// registries through the real NpmInstaller and checks the invariant on the
// lockfile it wrote: for every placement Q and every edge (name, range) of
// the package at Q that some registry version could satisfy, the nearest
// placement of `name` visible from Q exists and satisfies `range`. A
// violation prints the registry that produced it so it can be pinned.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { visiblePlacements } from '../../packages/worker/src/npm/placement.ts';
import { registryEntryFromResolved } from '../../packages/worker/src/npm/resolver.ts';
import { resolveVersion, satisfiesRange } from '../../packages/worker/src/npm/semver.ts';
import { makeFanoutEnv } from './npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const VERSIONS = ['1.0.0', '2.0.0', '3.0.0'];
const RANGES = ['^1.0.0', '^2.0.0', '^3.0.0', '*'];

let seed = 20260921;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (list) => list[Math.floor(rnd() * list.length)];

function genRegistry() {
  const registry = {};
  for (const name of NAMES) {
    registry[name] = {};
    for (const version of VERSIONS) {
      if (rnd() < 0.3) continue;
      const deps = {};
      for (const dep of NAMES) if (dep !== name && rnd() < 0.3) deps[dep] = pick(RANGES);
      registry[name][version] = deps;
    }
    if (Object.keys(registry[name]).length === 0) registry[name]['1.0.0'] = {};
  }
  return registry;
}

async function install(registry, deps) {
  const resultFor = (name, spec) => {
    const versions = registry[name] ?? {};
    const version = resolveVersion(Object.keys(versions), spec?.range ?? 'latest');
    const base = { deps: {}, peerDeps: {}, optionalDeps: {}, allPeerDependencies: {}, cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [] };
    if (!version) return { ...base, pkg: null, error: { type: 'unresolved', reason: `no version of ${name} satisfies ${spec?.range}` } };
    const pkg = {
      name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: `sha512-${name}-${version}`,
      dependencies: versions[version], exports: null, main: 'index.js', module: '', bin: {},
    };
    return { ...base, pkg, deps: pkg.dependencies, cacheWrites: [registryEntryFromResolved(pkg)] };
  };
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(NM, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'fuzz', dependencies: deps }));
  const env = makeFanoutEnv({ root, NM, resultFor });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = new NpmInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} });
  const result = await installer.install(PROJ, { pid: 1 });
  return { result, lock: installer.npmCache.readLockfile(PROJ) };
}

const RUNS = 120;
let nestedTrees = 0;
let edgesChecked = 0;
for (let run = 0; run < RUNS; run++) {
  const registry = genRegistry();
  const deps = {};
  for (const name of NAMES) if (rnd() < 0.5) deps[name] = pick(RANGES);
  if (Object.keys(deps).length === 0) deps.a = '*';
  const { result, lock } = await install(registry, deps);
  if (!lock) {
    // A tree that resolved nothing writes no lockfile; that is a failure the
    // install must have reported, and there are no placements to check.
    assert.ok(result.failed.length > 0, `run ${run}: no lockfile and no failure`);
    continue;
  }
  const placed = new Map([...lock].map(([placement, entry]) => [placement, entry]));
  if ([...placed.keys()].some((p) => p.includes('/node_modules/'))) nestedTrees++;
  for (const [placement, entry] of placed) {
    for (const [depName, range] of Object.entries(registry[entry.name][entry.resolvedVer])) {
      if (!Object.keys(registry[depName]).some((v) => satisfiesRange(v, range))) continue;
      edgesChecked++;
      const near = visiblePlacements(placement, depName).find((p) => placed.has(p));
      const detail = () => `run ${run}: ${placement} → ${depName}@${range}\nregistry=${JSON.stringify(registry)}\ndeps=${JSON.stringify(deps)}`;
      if (!near) {
        assert.ok(result.failed.length > 0, `a satisfiable edge with no visible copy must fail the install: ${detail()}`);
        continue;
      }
      assert.ok(
        satisfiesRange(placed.get(near).resolvedVer, range),
        `nearest visible copy ${near}@${placed.get(near).resolvedVer} does not satisfy: ${detail()}`,
      );
    }
  }
}
assert.ok(nestedTrees > RUNS / 4, `the fuzz exercises nesting (${nestedTrees}/${RUNS} trees nested)`);
console.log(`  ${RUNS} trees (${nestedTrees} with nesting), ${edgesChecked} edges met by their nearest visible copy`);
console.log('npm-install-placement-invariant: ok');
