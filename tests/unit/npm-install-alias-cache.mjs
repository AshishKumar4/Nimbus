#!/usr/bin/env bun
// npm-install-alias-cache — one alias name, two registry packages, one cache.
//
// Two projects share a session's registry cache. In A, `slot` is an alias of
// real-a, whose dependency nests below it; in B, `slot` is an alias of
// real-b. A registry record is its registry package's, and a lockfile entry
// keeps the registry identity it installed, so B's install does not change
// what A's lockfile reads: A's unchanged install keeps its tree, a nested
// pin a newer publication would also meet included, as npm keeps it. Real
// NpmInstaller over real SQLite; the fan-out RPC is the seam.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { npmRegistry } from './lib/npm-registry.mjs';
import { kernelInstaller, makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const REGISTRY = {
  'real-a': { '1.0.0': { dependencies: { d: '^1.0.0' } } },
  'real-b': { '1.0.0': {} },
  d: { '1.0.0': {}, '2.0.0': {} },
};
const registry = npmRegistry(REGISTRY);
const asked = [];
const resultFor = (name, spec) => { asked.push(`${name}@${spec.range}`); return registry.resultFor(name, spec); };

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
for (const dir of ['a', 'b']) {
  root.mkdir(`${dir}/node_modules`, { recursive: true });
  root.writeFile(`${dir}/package.json`, JSON.stringify({ name: dir, version: '1.0.0' }));
}
const env = makeFanoutEnv({
  root, NM: 'a/node_modules', resultFor,
  manifestFor: (p) => ({ name: p.tarballUrl.match(/registry\.invalid\/(.+)-\d/)[1], version: p.version }),
});
const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} });
const versionAt = (at) => JSON.parse(root.readFileString(`${at}/package.json`)).version;

assert.deepEqual((await installer.install('a', { packages: ['slot@npm:real-a@1.0.0', 'd@2.0.0'] })).failed, []);
assert.equal(versionAt('a/node_modules/d'), '2.0.0');
assert.equal(versionAt('a/node_modules/slot/node_modules/d'), '1.0.0', "real-a's d nests below it");

// d@1.1.0 is published, and B aliases slot to another package.
REGISTRY.d['1.1.0'] = {};
assert.deepEqual((await installer.install('b', { packages: ['slot@npm:real-b@1.0.0', 'd@1.1.0'] })).failed, []);

asked.length = 0;
const again = await installer.install('a', {});
assert.deepEqual(again.failed, []);
assert.deepEqual(asked, [], "A's lockfile answers every edge: nothing is resolved");
assert.equal(versionAt('a/node_modules/slot/node_modules/d'), '1.0.0', 'the nested pin is kept');
assert.equal(JSON.parse(root.readFileString('a/node_modules/slot/package.json')).name, 'real-a');

console.log('npm-install-alias-cache: ok');
process.exit(0);
