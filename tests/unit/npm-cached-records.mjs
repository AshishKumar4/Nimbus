#!/usr/bin/env bun
// The session's cached registry records (npm/cache.ts) answer a resolve only
// for what they can know:
// - NPM-6: an exact version's record answers that version; a range is never
//   chosen from cached records, which hold some versions of a package and
//   never the registry's whole list (npm-pick-manifest needs every one).
//   Red before: an exact 2.0.0 install left 2.0.0 and five 3.x records, and
//   a fresh `^2` came back 2.0.0 although the registry has 2.1.0.
// - NPM-5: a record is the answer of the registry it was read from, through
//   the network it was read through, and of no other. Red before: records
//   were keyed by name@version alone, so an install against registry B took
//   registry A's tarball and dependencies.

import assert from 'node:assert/strict';
import { NpmCache } from '../../packages/worker/src/npm/cache.ts';
import { registryRecord } from '../../packages/worker/src/npm/registry-record.ts';
import { resolveOnePackumentInFacet } from '../../packages/worker/src/npm/resolve-one-facet.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import './lib/resolve-facet-scope.mjs';

const VERSIONS = ['2.0.0', '2.1.0', '3.0.0', '3.1.0', '3.2.0', '3.3.0', '3.4.0'];
const manifest = (version, registry = 'https://registry.npmjs.org') => ({
  name: 'p', version, dependencies: {}, dist: { tarball: `${registry}/p/-/p-${version}.tgz`, integrity: `sha512-${version}` },
});
const packument = JSON.stringify({ name: 'p', 'dist-tags': { latest: '3.4.0' }, versions: Object.fromEntries(VERSIONS.map((v) => [v, manifest(v)])) });
const record = (version, registry) => registryRecord({
  name: 'p', version, registryName: 'p', tarballUrl: `${registry}/p/-/p-${version}.tgz`, integrity: `sha512-${version}`,
  dependencies: {}, main: '', bin: {},
}, 1);
globalThis.fetch = async () => { throw new Error('the resolve facet must not perform network I/O'); };

/** Resolve p@range with `cachedEntries`, the registry's packument behind getPackument; the version and whether the packument was read. */
async function resolve(range, cachedEntries) {
  let asked = 0;
  const supervisor = { async getPackument() { asked++; return { json: packument, source: 'r2-cache', events: [] }; } };
  const result = await resolveOnePackumentInFacet(
    { name: 'p', range, cachedEntries, fetchTimeoutMs: 15_000, retries: 3, registry: 'https://registry.npmjs.org' },
    { SUPERVISOR: supervisor },
  );
  return { version: result.pkg?.version, asked };
}

// ── NPM-6: a range is the registry's whole list's to answer ─────────────
{
  const cached = ['2.0.0', '3.0.0', '3.1.0', '3.2.0', '3.3.0', '3.4.0'].map((v) => record(v, 'https://registry.npmjs.org'));
  const ranged = await resolve('^2', cached);
  assert.equal(ranged.version, '2.1.0', 'a range was chosen from cached records, not the registry\'s versions');
  assert.equal(ranged.asked, 1);
  const exact = await resolve('2.0.0', cached);
  assert.deepEqual(exact, { version: '2.0.0', asked: 0 }, 'an exact version\'s record answers it without the packument');
}

// ── NPM-5: a record answers only the registry and network it was read from ──
{
  const cache = new NpmCache(createSqliteVfsTestHarness().sql);
  const A = { registry: 'https://a.example', network: '' };
  const B = { registry: 'https://b.example', network: '' };
  const egress = { registry: 'https://a.example', network: 'egress-1' };
  assert.deepEqual(cache.putRegistryEntries(A, [record('2.0.0', 'https://a.example')]), { written: 1, failed: 0 });
  assert.equal(cache.getRegistryEntry(A, 'p', '2.0.0')?.tarballUrl, 'https://a.example/p/-/p-2.0.0.tgz');
  assert.equal(cache.getRegistryEntry(B, 'p', '2.0.0'), null, 'registry A\'s record answered for registry B');
  assert.equal(cache.getRegistryEntry(egress, 'p', '2.0.0'), null, 'a record read through the isolate\'s network answered through an egress');
  cache.putRegistryEntries(B, [record('2.0.0', 'https://b.example')]);
  assert.equal(cache.getRegistryEntry(B, 'p', '2.0.0')?.tarballUrl, 'https://b.example/p/-/p-2.0.0.tgz');
  assert.equal(cache.getRegistryEntry(A, 'p', '2.0.0')?.tarballUrl, 'https://a.example/p/-/p-2.0.0.tgz', 'B\'s record replaced A\'s');
  const both = cache.getRegistryEntries(B, [['p', '2.0.0'], ['p', '2.1.0']]);
  assert.equal(both.get('p@2.0.0')?.tarballUrl, 'https://b.example/p/-/p-2.0.0.tgz');
  assert.equal(both.get('p@2.1.0'), null);
}

console.log('npm-cached-records: ok');
