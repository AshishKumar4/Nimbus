#!/usr/bin/env bun
// One registry record, one codec: what the resolver stages for a version and
// what is read back from it describe the same package.
//   - a warm resolve (the record from the cache) answers what the cold
//     resolve of the same version answered: its required peers, optional
//     dependencies and platform included, so the ABI policy decides alike;
//   - the installer's lockfile reconstruction answers that package too.
//     Red before: it dropped the peers, optional dependencies and platform;
//   - a record from before those columns, or a field that does not parse or
//     has another shape (a 'null' platform, a list of peers), reads as none:
//     a valid-lockfile install over it goes on. Red before: a 'null'
//     platform failed the lockfile's reconstruction.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { resolveOnePackumentInFacet } from '../../packages/worker/src/npm/resolve-one-facet.ts';
import './lib/resolve-facet-scope.mjs';
import { resolvedFromRecord } from '../../packages/worker/src/npm/registry-record.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { kernelInstaller, makeFanoutEnv } from './npm-fanout-test-env.mjs';

// Records as the installer keeps them: read from npm's registry through the isolate's network.
const SOURCE = { registry: 'https://registry.npmjs.org', network: '' };
const spec = (overrides) => ({ cachedEntries: [], fetchTimeoutMs: 1_000, retries: 0, registry: 'https://registry.invalid', ...overrides });
// What a value reads as once it has crossed a wire: an absent field and an undefined one alike.
const plain = (value) => JSON.parse(JSON.stringify(value));

const packument = {
  name: 'pkg',
  'dist-tags': { latest: '2.1.0' },
  versions: {
    '2.1.0': {
      name: 'pkg',
      version: '2.1.0',
      dependencies: { dep: '^1.0.0' },
      optionalDependencies: { opt: '^3.0.0' },
      peerDependencies: { react: '^18.0.0', maybe: '*' },
      peerDependenciesMeta: { maybe: { optional: true } },
      os: ['!win32'],
      cpu: ['!ia32'],
      engines: { node: '>=18', npm: '>=9' },
      exports: { '.': { import: './index.mjs', require: './index.js' } },
      main: 'index.js',
      module: 'index.mjs',
      bin: { pkg: 'bin.js' },
      dist: { tarball: 'https://registry.invalid/pkg-2.1.0.tgz', integrity: 'sha512-pkg' },
    },
  },
};

const cold = await resolveOnePackumentInFacet(spec({ name: 'pkg', range: '^2.0.0' }), {
  SUPERVISOR: { async getPackument() { return { json: JSON.stringify(packument), source: 'network', events: [] }; } },
});
assert.ok(cold.pkg, `the cold resolve answered: ${JSON.stringify(cold.error ?? cold.messages)}`);
assert.deepEqual(plain(cold.pkg.peerDependencies), { react: '^18.0.0', maybe: '*' }, 'the cold resolve keeps every peer');
assert.deepEqual(plain(cold.pkg.peerDependenciesMeta), { maybe: { optional: true } }, 'and which are optional');
assert.deepEqual(plain(cold.pkg.engines), { node: '>=18', npm: '>=9' }, 'and what it asks of node and npm');
const record = cold.cacheWrites.find((entry) => entry.version === '2.1.0');
assert.ok(record, 'the cold resolve staged its version');

const warm = await resolveOnePackumentInFacet(spec({ name: 'pkg', range: '2.1.0', cachedEntries: [record] }), {
  SUPERVISOR: { async getPackument() { throw new Error('a warm resolve reads no packument'); } },
});
assert.equal(warm.packumentSource, 'cache-hit');
assert.deepEqual(plain(warm.pkg), plain(cold.pkg), 'a warm resolve answers what the cold one did');
console.log('  ok  a warm resolve answers what the cold one did');

{
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir('app/node_modules', { recursive: true });
  const env = makeFanoutEnv({ root, NM: 'app/node_modules', resultFor: () => null });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = kernelInstaller(vfs, harness.sql, { env, ctx });
  installer.npmCache.putRegistryEntries(SOURCE, cold.cacheWrites);
  const entry = { name: 'pkg', registryName: 'pkg', resolvedVer: '2.1.0', integrity: 'sha512-pkg', hoistedPath: 'app/node_modules/pkg' };
  const recordOf = installer.lockRecords(SOURCE);
  assert.deepEqual(plain(resolvedFromRecord(recordOf(entry))), plain(cold.pkg), "a lockfile's package is the one its resolve answered");
  // Another package's record under the name (an alias retargeted) is not this placement's.
  assert.equal(recordOf({ ...entry, integrity: 'sha512-another' }), null, 'a record of another package is none');
  console.log("  ok  a lockfile's package is the one its resolve answered, and only that one");
}

{
  const old = resolvedFromRecord({
    name: 'old', version: '1.0.0', tarballUrl: 'https://registry.invalid/old-1.0.0.tgz', integrity: 'sha512-old',
    depsJson: 'not json', main: 'index.js', binJson: '{}',
  });
  assert.deepEqual(plain(old), {
    name: 'old', version: '1.0.0', tarballUrl: 'https://registry.invalid/old-1.0.0.tgz', integrity: 'sha512-old',
    dependencies: {}, main: 'index.js', bin: {},
  }, 'a pre-migration or malformed record reads as no peers, optional dependencies or platform');
  console.log('  ok  a pre-migration or malformed record reads as none');
}

{
  const record = {
    name: 'odd', version: '1.0.0', tarballUrl: 'https://registry.invalid/odd-1.0.0.tgz', integrity: 'sha512-odd',
    depsJson: '{"a":1}', peerDepsJson: '["react"]', optionalDepsJson: '"x"', platformJson: 'null',
    main: 'index.js', binJson: '5',
  };
  assert.deepEqual(plain(resolvedFromRecord(record)), {
    name: 'odd', version: '1.0.0', tarballUrl: 'https://registry.invalid/odd-1.0.0.tgz', integrity: 'sha512-odd',
    dependencies: {}, main: 'index.js', bin: {},
  }, 'every field of another shape reads as its empty value');
  assert.deepEqual(plain(resolvedFromRecord({ ...record, platformJson: '{"os":"linux","cpu":["x64",1]}' })).os, undefined, 'a platform list of another shape reads as none');

  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir('app/node_modules', { recursive: true });
  const env = makeFanoutEnv({ root, NM: 'app/node_modules', resultFor: () => null });
  const installer = kernelInstaller(vfs, harness.sql, { env, ctx: { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage } });
  // As the facet writes it now: the registry package's own.
  installer.npmCache.putRegistryEntries(SOURCE, [{ ...record, registryName: 'odd' }]);
  // A warm install over it: odd is installed, as the lockfile records, and the plan keeps it.
  root.writeFile('app/package.json', JSON.stringify({ name: 'app', dependencies: { odd: '1.0.0' } }));
  root.mkdir('app/node_modules/odd', { recursive: true });
  root.writeFile('app/node_modules/odd/package.json', JSON.stringify({ name: 'odd', version: '1.0.0' }));
  installer.npmCache.writeLockfile('app', new Map([['odd', { name: 'odd', registryName: 'odd', resolvedVer: '1.0.0', integrity: 'sha512-odd', hoistedPath: 'app/node_modules/odd' }]]), { storage: harness.ctx.storage });
  const log = [];
  const result = await installer.install('app', { onProgress: (line) => log.push(line) });
  assert.deepEqual(result.failed, [], log.join('\n'));
  assert.ok(log.some((line) => line.startsWith('Lockfile valid')), `the install keeps what the lockfile records: ${log.join('\n')}`);
  console.log('  ok  a record of another shape reads as none, and a warm install over it goes on');
}

console.log('npm-registry-record: ok');
