#!/usr/bin/env bun
// One registry record, one codec: what the resolver stages for a version and
// what is read back from it describe the same package.
//   - a warm resolve (the record from the cache) answers what the cold
//     resolve of the same version answered: its required peers, optional
//     dependencies and platform included, so the ABI policy decides alike;
//   - the installer's lockfile reconstruction answers that package too.
//     Red before: it dropped the peers, optional dependencies and platform;
//   - a record from before those columns, or a field that does not parse,
//     reads as none.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { resolveOnePackumentInFacet } from '../../packages/worker/src/npm/resolve-one-facet.ts';
import './lib/resolve-facet-scope.mjs';
import { resolvedFromRecord } from '../../packages/worker/src/npm/registry-record.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { kernelInstaller, makeFanoutEnv } from './npm-fanout-test-env.mjs';

const spec = (overrides) => ({ cachedEntries: [], isOptional: false, fetchTimeoutMs: 1_000, retries: 0, registry: 'https://registry.invalid', ...overrides });
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
assert.deepEqual(plain(cold.pkg.peerDependencies), { react: '^18.0.0' }, 'the cold resolve keeps the required peers');
const record = cold.cacheWrites.find((entry) => entry.version === '2.1.0');
assert.ok(record, 'the cold resolve staged its version');

const warm = await resolveOnePackumentInFacet(spec({ name: 'pkg', range: '^2.0.0', cachedEntries: [record] }), {
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
  installer.npmCache.putRegistryEntries(cold.cacheWrites);
  const lockfile = new Map([['pkg', { name: 'pkg', resolvedVer: '2.1.0', integrity: 'sha512-pkg', depsJson: '{"dep":"^1.0.0"}', hoistedPath: 'app/node_modules/pkg' }]]);
  const { resolved } = installer.lockfileToResolved(lockfile);
  assert.deepEqual(plain(resolved.get('pkg')), plain(cold.pkg), "a lockfile's package is the one its resolve answered");
  console.log("  ok  a lockfile's package is the one its resolve answered");
}

{
  const old = resolvedFromRecord({
    name: 'old', version: '1.0.0', tarballUrl: 'https://registry.invalid/old-1.0.0.tgz', integrity: 'sha512-old',
    depsJson: 'not json', exportsJson: '', main: 'index.js', moduleField: '', binJson: '{}', fetchedAt: 0,
  });
  assert.deepEqual(plain(old), {
    name: 'old', version: '1.0.0', tarballUrl: 'https://registry.invalid/old-1.0.0.tgz', integrity: 'sha512-old',
    dependencies: {}, exports: null, main: 'index.js', module: '', bin: {},
  }, 'a pre-migration or malformed record reads as no peers, optional dependencies or platform');
  console.log('  ok  a pre-migration or malformed record reads as none');
}

console.log('npm-registry-record: ok');
