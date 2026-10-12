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
import { fakeColoCache, withColoCache } from './lib/colo-cache.mjs';
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

// R2 as it stores an object: each put a new version (`etag`), and a put
// `onlyIf` another version writes nothing. `gate`, where set, holds a
// conditional put until it is opened.
function fakeBucket() {
  const entries = new Map();
  let reads = 0;
  let writes = 0;
  let version = 0;
  const bucket = {
    entries,
    gate: null,
    get reads() { return reads; },
    get writes() { return writes; },
    async get(key) {
      reads++;
      const entry = entries.get(key);
      return entry ? { text: async () => entry.json, uploaded: entry.uploaded, customMetadata: entry.customMetadata, etag: entry.etag } : null;
    },
    async put(key, body, options) {
      if (options?.onlyIf && bucket.gate) await bucket.gate.held();
      if (options?.onlyIf && entries.get(key)?.etag !== options.onlyIf.etagMatches) return null;
      writes++;
      entries.set(key, { json: String(body), uploaded: new Date(now), customMetadata: options?.customMetadata, etag: `r2-${++version}` });
      return {};
    },
    async delete() { throw new Error('no cache eviction is part of freshness'); },
  };
  return bucket;
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
  assert.equal(stored.customMetadata.etag, '"fixture-1"', "with the registry's ETag");
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
// ── an expired entry is refetched on its ETag: a 304 keeps the cached body ──
// Fresh reads never reach the registry. At expiry the refetch is
// conditional; an unchanged packument (304) is kept as a fresh answer would
// be, without its body. An entry cached without an ETag is used, and
// refetched, as before. A version nothing publishes is asked about once,
// and is no published version; one the cache answers is not asked at all.
if (!expiredControl) {
  delete globalThis.caches;
  Date.now = () => now;
  try {
    now = START;
    const bucket = fakeBucket();
    const registry = fakeRegistry();
    const client = () => new R2CacheClient(null, bucket);
    const read = (options = {}) => client().readThroughPackument(NAME, { registry: REGISTRY, retries: 0, ...options });
    const resolve = (range) => resolveOnePackumentInFacet(
      { name: NAME, range, cachedEntries: [], fetchTimeoutMs: 1_000, retries: 0, registry: REGISTRY },
      { SUPERVISOR: { async getPackument(packageName, options) { const c = client(); return { ...await c.readThroughPackument(packageName, options), events: c._cacheEvents }; } } },
    );
    assert.equal((await read()).source, 'network');
    now = START + PACKUMENT_TTL_MS - 1_000;
    assert.equal((await read()).source, 'r2-cache');
    assert.equal(registry.requests.length, 1, 'a fresh entry is not asked about');

    now = START + PACKUMENT_TTL_MS + 1_000;
    const renewed = await read();
    assert.equal(renewed.source, 'r2-cache', 'unchanged: the cached body stands');
    assert.equal(registry.requests.at(-1).ifNoneMatch, '"fixture-1"', 'refetched on its ETag');
    const stored = bucket.entries.get(packumentKey(NAME, REGISTRY));
    assert.equal(Number(stored.customMetadata.expiresAt), now + PACKUMENT_TTL_MS, 'kept as a fresh answer would be');
    assert.equal(stored.customMetadata.etag, '"fixture-1"');
    now += 1_000;
    assert.equal((await read()).source, 'r2-cache');
    assert.equal(registry.requests.length, 2, 'and not asked again while fresh');

    // An entry from before ETags were kept: used while fresh, then refetched plainly.
    bucket.entries.set(packumentKey(NAME, REGISTRY), { json: registry.json(), uploaded: new Date(now), customMetadata: { expiresAt: String(now + 1_000) } });
    assert.equal((await read()).source, 'r2-cache');
    assert.equal(registry.requests.length, 2);
    now += 2_000;
    assert.equal((await read()).source, 'network');
    assert.equal(registry.requests.at(-1).ifNoneMatch, null, 'plainly');
    assert.equal(bucket.entries.get(packumentKey(NAME, REGISTRY)).customMetadata.etag, '"fixture-1"');

    const asked = registry.requests.length;
    const met = await resolve('^1.0.0');
    assert.equal(met.pkg?.version, '1.0.0');
    assert.equal(registry.requests.length, asked, 'a range the cache answers is not asked about');
    const missing = await resolve('^9.0.0');
    assert.equal(missing.pkg, null);
    assert.match(missing.error?.reason ?? '', /no published version/);
    assert.equal(registry.requests.length, asked + 1, 'asked once');
    assert.equal(registry.requests.at(-1).ifNoneMatch, '"fixture-1"');

    // A colo copy promoted from R2 keeps its ETag: a read past the cache
    // from it is conditional, and an unchanged packument answers 304.
    await withColoCache(async () => {
      const promoted = await resolve('^1.0.0');
      assert.equal(promoted.pkg?.version, '1.0.0');
      const requests = registry.requests.length;
      assert.ok(globalThis.caches.default.entries.has(packumentL2Url(NAME, REGISTRY)), 'promoted to the colo');
      await resolve('^9.0.0');
      assert.equal(registry.requests.length, requests + 1);
      assert.equal(registry.requests.at(-1).ifNoneMatch, '"fixture-1"', 'conditional on the ETag the promotion kept');
    });

    // A 304 renews an entry only where it still holds what was validated.
    // A reads revision 1 expired and is told it is unchanged; before A's
    // renewal lands, revision 2 is published and B caches it, in A's colo
    // or another: A's renewal writes nothing over it in R2, nor revision 1
    // into A's colo once R2's renewal did not hold.
    for (const where of ['R2', 'colo', 'another colo']) {
      const colo = where !== 'R2';
      const race = async () => {
        now = START;
        const raced = fakeBucket();
        const published = fakeRegistry();
        const readRaced = () => new R2CacheClient(null, raced).readThroughPackument(NAME, { registry: REGISTRY, retries: 0 });
        await readRaced();
        if (colo) globalThis.caches.default.entries.clear();
        now = START + PACKUMENT_TTL_MS + 1_000;
        let entered;
        let open;
        const held = new Promise((resolve) => { open = resolve; });
        const reached = new Promise((resolve) => { entered = resolve; });
        raced.gate = { held: () => { entered(); return held; } };
        const a = readRaced();
        assert.equal(await Promise.race([reached.then(() => 'held'), a.then(() => 'renewed')]), 'held', 'the renewal is made conditional on what was read');
        assert.equal(published.requests.at(-1).ifNoneMatch, '"fixture-1"');
        published.publish('2.0.0');
        raced.gate = null;
        const mine = globalThis.caches;
        if (where === 'another colo') globalThis.caches = { default: fakeColoCache() };
        const b = await readRaced();
        globalThis.caches = mine;
        assert.equal(b.source, 'network');
        open();
        assert.equal((await a).source, 'r2-cache');
        const stored = raced.entries.get(packumentKey(NAME, REGISTRY));
        assert.ok(JSON.parse(stored.json).versions['2.0.0'], `${where}: the newer body stays in R2`);
        assert.equal(stored.customMetadata.etag, '"fixture-2"');
        const copy = colo ? globalThis.caches.default.entries.get(packumentL2Url(NAME, REGISTRY)) : undefined;
        if (where === 'colo') assert.equal(copy.headers['x-nimbus-etag'], '"fixture-2"', 'and in the colo');
        if (where === 'another colo') assert.equal(copy, undefined, "A's colo is not given the body R2 no longer holds");
      };
      if (colo) await withColoCache(race);
      else await race();
    }
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
    else delete globalThis.caches;
  }
}

console.log(`npm-packument-cache-freshness: ${expiredControl ? 'expired control' : 'regression'} ok`);
