#!/usr/bin/env bun
// A registry publishes after the shared cache is filled. A new install
// asks for the new version while that packument's TTL still has time left:
// cached absence is not proof that no published version meets the request.
// Exercise the real HTTP read-through and the real resolving consumer,
// with both R2 and the colo copy, without any live registry or bucket.
//
// Diagnostic control, not the regression's normal invocation:
//   bun tests/unit/npm-packument-cache-freshness.mjs --expired-control
// Changes only elapsed time, to prove the same HTTP seam and version
// picker work once the cache's unconditional fresh-hit return is removed.

import assert from 'node:assert/strict';
import { PACKUMENT_TTL_MS, R2CacheClient, packumentKey, packumentL2Url, packumentUrl } from '../../packages/worker/src/npm/r2-cache.ts';
import { resolveOnePackumentInFacet } from '../../packages/worker/src/npm/resolve-one-facet.ts';
import { withColoCache } from './lib/colo-cache.mjs';
import './lib/resolve-facet-scope.mjs';

const expiredControl = process.argv.includes('--expired-control');
const NAME = '@fixture/published-after-cache-fill';
const REGISTRY = 'https://registry-fixture.invalid';
const START = 1_800_000_000_000;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
let now = START;
Date.now = () => now;

function fakeBucket() {
  const entries = new Map();
  let reads = 0;
  let writes = 0;
  return {
    entries,
    get reads() { return reads; },
    get writes() { return writes; },
    async get(key) {
      reads++;
      const entry = entries.get(key);
      return entry ? { text: async () => entry.json, uploaded: entry.uploaded, customMetadata: entry.customMetadata } : null;
    },
    async put(key, body, options) {
      writes++;
      entries.set(key, { json: String(body), uploaded: new Date(now), customMetadata: options?.customMetadata });
    },
    async delete() { throw new Error('no cache eviction is part of freshness'); },
  };
}

function fakeRegistry() {
  const versions = {};
  let latest;
  let revision = 0;
  const requests = [];
  const json = () => JSON.stringify({ name: NAME, 'dist-tags': { latest }, versions });
  const publish = (version) => {
    latest = version;
    revision++;
    versions[version] = {
      name: NAME, version, dependencies: {},
      dist: { tarball: `${REGISTRY}/fixture-${version}.tgz`, integrity: 'sha512-AAAA' },
    };
  };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.method, 'GET');
    assert.equal(request.url, packumentUrl(NAME, REGISTRY), 'no real network I/O is allowed');
    assert.match(request.headers.get('accept'), /application\/vnd\.npm\.install-v1\+json/);
    requests.push({ url: request.url, ifNoneMatch: request.headers.get('if-none-match'), revision });
    const headers = { ETag: `"fixture-${revision}"`, 'Cache-Control': 'public, max-age=300' };
    if (request.headers.get('if-none-match') === headers.ETag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(json(), { status: 200, headers });
  };
  publish('1.0.0');
  return { publish, requests, json };
}

async function scenario(tier, request, colo) {
  now = START;
  const bucket = fakeBucket();
  const registry = fakeRegistry();
  const resolve = async (name, range) => resolveOnePackumentInFacet(
    { name, range, cachedEntries: [], fetchTimeoutMs: 1_000, retries: 0, registry: REGISTRY },
    { SUPERVISOR: {
      async getPackument(packageName, options) {
        const client = new R2CacheClient(null, bucket);
        return { ...await client.readThroughPackument(packageName, options), events: client._cacheEvents };
      },
    } },
  );

  // Fill from the fake registry, not by injecting a caller-written packument.
  const first = await resolve(NAME, '^1.0.0');
  assert.equal(first.pkg?.version, '1.0.0');
  assert.equal(first.packumentSource, 'network');
  assert.equal(registry.requests.length, 1);
  assert.equal(bucket.writes, 1);
  const key = packumentKey(NAME, REGISTRY);
  const stored = bucket.entries.get(key);
  assert.equal(stored.json, registry.json());
  const expiresAt = Number(stored.customMetadata.expiresAt);
  assert.equal(expiresAt, START + PACKUMENT_TTL_MS);
  if (colo) {
    assert.ok(colo.entries.has(packumentL2Url(NAME, REGISTRY)), 'the first registry response filled L2 as well');
  }

  // Publish while the old snapshot is unexpired. Only the diagnostic
  // control advances beyond the existing TTL; neither path deletes a key.
  registry.publish('1.0.1');
  now = expiredControl ? expiresAt + 1 : START + 1_000;
  const beforeReads = bucket.reads;
  const second = await resolve(request.name, request.range);
  console.log(`${tier}/${request.label}/${expiredControl ? 'expired-control' : 'unexpired'}: ${JSON.stringify({
    version: second.pkg?.version ?? null, error: second.error?.reason ?? null,
    source: second.packumentSource, requests: registry.requests.length,
    ttlRemainingMs: expiresAt - now,
  })}`);
  if (colo) assert.equal(bucket.reads, beforeReads, 'the second lookup really reached the warm colo copy, not R2');
  assert.equal(second.pkg?.version, '1.0.1',
    `${tier}/${request.label}: a cached packument that cannot satisfy the requested version must be revalidated before ETARGET`);
  assert.equal(second.pkg?.name, request.name);
  assert.equal(second.error, undefined);
  assert.equal(registry.requests.length, 2, 'one revalidation, no resolution retry loop');
  assert.equal(bucket.writes, 2, 'only the registry response replaces the shared entry');
  assert.equal(bucket.entries.get(key).json, registry.json(), 'the new snapshot reached R2');

  // A third fresh session sees the updated snapshot with no extra network
  // read, proving freshness repairs the shared cache rather than only one
  // caller's result.
  const third = await resolve(request.name, request.range);
  assert.equal(third.pkg?.version, '1.0.1');
  assert.equal(registry.requests.length, 2);
}

const failures = [];
try {
  delete globalThis.caches;
  for (const request of [
    { label: 'range', name: NAME, range: '^1.0.1' },
    { label: 'exact', name: NAME, range: '1.0.1' },
    { label: 'alias', name: 'fresh-alias', range: `npm:${NAME}@^1.0.1` },
  ]) {
    for (const tier of ['L3', 'L2']) {
      try {
        if (tier === 'L2') await withColoCache((colo) => scenario(tier, request, colo));
        else await scenario(tier, request);
      } catch (error) {
        failures.push(`${tier}/${request.label}: ${error.message}`);
      }
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
  else delete globalThis.caches;
}
assert.equal(failures.length, 0, failures.join('\n'));
console.log(`npm-packument-cache-freshness: ${expiredControl ? 'expired control' : 'regression'} ok`);
