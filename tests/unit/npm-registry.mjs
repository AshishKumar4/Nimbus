#!/usr/bin/env bun
// The fixture registry drives production resolution, including its version
// choice, alias identity, cache records and both installer fanout topologies.
import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { npmRegistry } from './lib/npm-registry.mjs';
import { kernelInstaller, makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const registry = npmRegistry({
  target: {
    '2.0.0': {},
    '1.0.0': {},
    '1.4.0': {
      dependencies: { leaf: '^1.0.0' }, optionalDependencies: { extra: '^1.0.0' },
      peerDependencies: { host: '^1.0.0' }, peerDependenciesMeta: { host: { optional: true } },
      bin: 'bin/run.js', main: 'lib/main.js', engines: { node: '>=18' },
      os: ['!win32'], cpu: ['!arm'], libc: ['!musl'], bundleDependencies: [],
    },
    '3.0.0-beta.1': {},
  },
}, { distTags: { target: { latest: '1.0.0', next: '3.0.0-beta.1' } } });

for (const [range, expected] of [
  ['1.0.0', '1.0.0'], ['^1.0.0', '1.4.0'], ['*', '1.0.0'],
  ['latest', '1.0.0'], ['next', '3.0.0-beta.1'],
]) {
  const result = await registry.resultFor('target', { range });
  assert.equal(result.error, undefined, range);
  assert.equal(result.pkg?.version, expected, range);
}
const missing = await registry.resultFor('target', { range: '^9.0.0' });
assert.equal(missing.pkg, null);
assert.equal(missing.error?.type, 'unresolved');
assert.equal((await registry.resultFor('absent')).error?.type, 'unresolved');
assert.equal((await npmRegistry({ p: { '1.0.0': {}, '2.0.0': {}, '1.2.0': {} } }).resultFor('p')).pkg?.version, '2.0.0', 'default latest is the highest version, not the last insertion');

const cold = await registry.resultFor('slot', { range: 'npm:target@^1.0.0' });
assert.equal(cold.error, undefined);
assert.deepEqual(cold.pkg, {
  name: 'slot', registryName: 'target', version: '1.4.0',
  tarballUrl: 'https://registry.invalid/target-1.4.0.tgz', integrity: 'sha512-target-1.4.0',
  dependencies: { leaf: '^1.0.0' }, optionalDependencies: { extra: '^1.0.0' },
  peerDependencies: { host: '^1.0.0' }, peerDependenciesMeta: { host: { optional: true } },
  bin: { target: 'bin/run.js' }, main: 'lib/main.js', engines: { node: '>=18' },
  os: ['!win32'], cpu: ['!arm'], libc: ['!musl'], bundleDependencies: [],
});
assert.deepEqual(cold.cacheWrites.map(({ name, version }) => [name, version]), [['target', '1.4.0']]);
const beforeWarm = registry.asked.length;
const warm = await registry.resultFor('slot', { range: 'npm:target@1.4.0', cachedEntries: cold.cacheWrites });
assert.deepEqual(warm.pkg, cold.pkg, 'the production record preserves the alias and manifest metadata');
assert.equal(warm.packumentSource, 'cache-hit');
assert.equal(registry.asked.length, beforeWarm, 'a warm exact pin needs no packument');

const graph = npmRegistry({
  a: { '2.0.0': {}, '1.0.0': { dependencies: { shared: '^1.0.0', helper: '1.0.0' }, bin: { a: 'cli.js' } } },
  b: { '1.0.0': { dependencies: { shared: '^2.0.0' } } },
  c: { '1.0.0': {} }, d: { '1.0.0': {} }, e: { '1.0.0': {} }, f: { '1.0.0': {} },
  shared: { '1.0.0': {}, '2.0.0': {} }, helper: { '1.0.0': {} },
});
const harness = createSqliteVfsTestHarness();
try {
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  const NM = 'app/node_modules';
  root.mkdir(NM, { recursive: true });
  root.writeFile('app/package.json', JSON.stringify({
    name: 'app', dependencies: { a: '^1.0.0', b: '1.0.0', c: '1.0.0', d: '1.0.0', e: '1.0.0', f: '1.0.0', slot: 'npm:shared@1.0.0' },
  }));
  const env = makeFanoutEnv({ root, NM, resultFor: graph.resultFor });
  const calls = { facet: 0, peer: 0 };
  const loaderGet = env.LOADER.get;
  env.LOADER.get = (...args) => { calls.facet++; return loaderGet(...args); };
  const peerGet = env.NIMBUS_SESSION.get;
  env.NIMBUS_SESSION.get = (...args) => { calls.peer++; return peerGet(...args); };
  const installer = kernelInstaller(vfs, harness.sql, {
    env, ctx: { id: { toString: () => 'registry-test' }, storage: harness.ctx.storage }, onProgress() {},
  });
  assert.deepEqual((await installer.install('app')).failed, []);
  const expected = [
    ['a', '1.0.0'], ['b', '1.0.0'], ['b/node_modules/shared', '2.0.0'],
    ['c', '1.0.0'], ['d', '1.0.0'], ['e', '1.0.0'], ['f', '1.0.0'],
    ['helper', '1.0.0'], ['shared', '1.0.0'], ['slot', '1.0.0'],
  ];
  const lock = installer.npmCache.readLockfile('app');
  assert.deepEqual([...lock].map(([at, entry]) => [at, entry.resolvedVer]).sort(), expected);
  for (const [at, version] of expected) assert.equal(JSON.parse(root.readFileString(`${NM}/${at}/package.json`)).version, version, at);
  assert.equal(lock.get('slot').registryName, 'shared');
  assert.ok(root.exists(`${NM}/.bin/a`), 'the resolved manifest links its bin');
  assert.ok(calls.peer > 0 && calls.facet > 0, 'wide and narrow layers use both fanout topologies');
  const before = graph.asked.length;
  assert.deepEqual((await installer.install('app')).failed, []);
  assert.equal(graph.asked.length, before, 'the installer replays the records and lockfile without resolution');
} finally {
  harness.db.close();
}

console.log('npm-registry: ok');
