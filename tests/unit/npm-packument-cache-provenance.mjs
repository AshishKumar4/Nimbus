#!/usr/bin/env bun

// The packument cache is the other half of the shared-npm-cache trust
// boundary, and the more dangerous half: a packument dictates the tarball
// URL and integrity digest for every tenant that reads it, so whoever
// controls a cached packument controls what other tenants install —
// content-addressing the tarball store cannot help, because the poisoner
// picks the address too.
//
// The cache therefore has exactly one filler: R2CacheClient's read-through,
// which writes only what registry.npmjs.org served for that exact name.
// There is no caller-supplied packument write anywhere, and the resolve
// facet — which runs attacker-influenced package names — neither fetches
// the registry nor holds any capability to write the cache.

import assert from 'node:assert/strict';
import { workspaceNetwork } from '../../packages/core/src/_shared/workspace-network.ts';
import { PACKUMENT_TTL_MS, R2CacheClient, packumentKey, packumentL2Url } from '../../packages/worker/src/npm/r2-cache.ts';
import { resolveOnePackumentInFacet } from '../../packages/worker/src/npm/resolve-one-facet.ts';
import { withColoCache } from './lib/colo-cache.mjs';
import './lib/resolve-facet-scope.mjs';

// The resolve facet reads its policy/semver helpers as bare identifiers
// injected by the loader preamble. Evaluate the real preamble so this test
// exercises the real decisions.

function fakeBucket() {
  const store = new Map();
  return {
    store,
    async get(key) {
      const value = store.get(key);
      if (!value) return null;
      return {
        text: async () => value.json,
        uploaded: new Date(value.uploaded),
        customMetadata: value.customMetadata,
      };
    },
    async put(key, body, opts) {
      store.set(key, { json: String(body), uploaded: Date.now(), customMetadata: opts?.customMetadata });
    },
    async delete(key) { store.delete(key); },
  };
}

function packumentJson(name, version, tarball) {
  return JSON.stringify({
    name,
    'dist-tags': { latest: version },
    versions: { [version]: { name, version, dist: { tarball, integrity: 'sha512-AAAA' }, dependencies: {} } },
  });
}

const originalFetch = globalThis.fetch;
function recordingFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), accept: init?.headers?.Accept });
    return responder(String(url));
  };
  return calls;
}

// ── 1. The cache is filled only with what the registry served, for the
//       name that was asked for ─────────────────────────────────────────
{
  const bucket = fakeBucket();
  const body = packumentJson('react', '19.0.0', 'https://registry.npmjs.org/react/-/react-19.0.0.tgz');
  const calls = recordingFetch(() => new Response(body, { status: 200 }));

  const client = new R2CacheClient(null, bucket);
  const result = await client.readThroughPackument('react');

  assert.equal(result.json, body);
  assert.equal(result.source, 'network');
  assert.deepEqual(calls, [{ url: 'https://registry.npmjs.org/react', accept: 'application/vnd.npm.install-v1+json' }]);
  assert.deepEqual([...bucket.store.keys()], [packumentKey('react')]);
  assert.equal(bucket.store.get(packumentKey('react')).json, body, 'stored bytes are the registry response, verbatim');

  // Scoped names address one path segment on both the wire and the key.
  const scopedCalls = recordingFetch(() => new Response(packumentJson('@scope/pkg', '1.0.0', 'https://x/'), { status: 200 }));
  await new R2CacheClient(null, bucket).readThroughPackument('@scope/pkg');
  assert.deepEqual(scopedCalls.map((c) => c.url), ['https://registry.npmjs.org/@scope%2Fpkg']);
  assert.ok(bucket.store.has(packumentKey('@scope/pkg')));
}

// ── 2. A fresh entry is served from cache; an expired one is refetched ──
{
  const bucket = fakeBucket();
  const fresh = packumentJson('react', '19.0.0', 'https://registry.npmjs.org/react/-/react-19.0.0.tgz');
  await new R2CacheClient(null, bucket).putPackument('react', fresh);

  let calls = recordingFetch(() => { throw new Error('must not fetch on a fresh cache hit'); });
  const hit = await new R2CacheClient(null, bucket).readThroughPackument('react');
  assert.equal(hit.json, fresh);
  assert.equal(hit.source, 'r2-cache');
  assert.equal(calls.length, 0);

  // Expire it. An expired entry is never served.
  bucket.store.get(packumentKey('react')).customMetadata = { expiresAt: String(Date.now() - 1) };
  const refreshed = packumentJson('react', '19.0.1', 'https://registry.npmjs.org/react/-/react-19.0.1.tgz');
  calls = recordingFetch(() => new Response(refreshed, { status: 200 }));
  const renewed = await new R2CacheClient(null, bucket).readThroughPackument('react');
  assert.equal(renewed.json, refreshed);
  assert.equal(renewed.source, 'network');
  assert.equal(calls.length, 1);
}

// ── 3. Registry failures never write the cache ──────────────────────────
{
  const bucket = fakeBucket();
  recordingFetch(() => new Response('not found', { status: 404 }));
  const missing = await new R2CacheClient(null, bucket).readThroughPackument('does-not-exist');
  assert.equal(missing.json, null);
  assert.equal(missing.status, 404);
  assert.equal(bucket.store.size, 0, '4xx must not be cached');

  recordingFetch(() => new Response('boom', { status: 500 }));
  const failed = await new R2CacheClient(null, bucket).readThroughPackument('flaky', { retries: 0 });
  assert.equal(failed.json, null);
  assert.equal(failed.failure, 'HTTP 500');
  assert.equal(bucket.store.size, 0, 'a failed fetch must not be cached');
}

// ── 4. Another registry (NPM_REGISTRY) reads from that origin and keeps its
//       own cache namespace: it never serves, nor fills, the npmjs entries ──
{
  const bucket = fakeBucket();
  const npmjs = packumentJson('react', '19.0.0', 'https://registry.npmjs.org/react/-/react-19.0.0.tgz');
  await new R2CacheClient(null, bucket).putPackument('react', npmjs);

  const mirror = 'http://npm-registry.invalid';
  const mirrored = packumentJson('react', '19.0.0', `${mirror}/react/-/react-19.0.0.tgz`);
  const calls = recordingFetch(() => new Response(mirrored, { status: 200 }));
  const fromMirror = await new R2CacheClient(null, bucket).readThroughPackument('react', { registry: mirror });

  assert.equal(fromMirror.json, mirrored, 'a warm npmjs entry is not an answer for another registry');
  assert.equal(fromMirror.source, 'network');
  assert.deepEqual(calls.map((c) => c.url), [`${mirror}/react`]);
  assert.equal(bucket.store.get(packumentKey('react')).json, npmjs, 'the npmjs entry is untouched');
  assert.equal(bucket.store.get(packumentKey('react', mirror)).json, mirrored);
  assert.notEqual(packumentKey('react', mirror), packumentKey('react'));
  assert.equal(packumentKey('react', 'https://registry.npmjs.org'), packumentKey('react'), 'the default origin keeps its key');

  const cached = await new R2CacheClient(null, bucket).readThroughPackument('react', { registry: mirror });
  assert.equal(cached.source, 'r2-cache');
  assert.equal(cached.json, mirrored);
}

// ── 5. The resolve facet holds no cache-write capability and never
//       reaches the network itself ────────────────────────────────────
{
  const body = packumentJson('react', '19.0.0', 'https://registry.npmjs.org/react/-/react-19.0.0.tgz');
  const reached = [];
  // Any supervisor method other than getPackument is a hard failure: the
  // facet resolves attacker-chosen package names, so the only capability
  // it may hold is "read metadata".
  const supervisor = new Proxy({
    async getPackument(name, options) {
      assert.equal(name, 'react');
      assert.equal(typeof options.retries, 'number');
      assert.equal(typeof options.timeoutMs, 'number');
      assert.equal(options.registry, 'http://npm-registry.invalid', 'the facet asks for the install\'s registry');
      return { json: body, source: 'r2-cache', events: [{ kind: 'hit', tier: 'L3', cacheKind: 'packument', bytes: body.length }] };
    },
  }, {
    get(target, prop) {
      if (typeof prop === 'string') reached.push(prop);
      return target[prop];
    },
  });
  globalThis.fetch = async () => { throw new Error('the resolve facet must not perform network I/O'); };

  const result = await resolveOnePackumentInFacet(
    { name: 'react', range: '19.0.0', cachedEntries: [], isOptional: false, fetchTimeoutMs: 15_000, retries: 3, registry: 'http://npm-registry.invalid' },
    { SUPERVISOR: supervisor },
  );

  assert.equal(result.pkg?.name, 'react');
  assert.equal(result.pkg?.version, '19.0.0');
  assert.equal(result.packumentSource, 'r2-cache');
  assert.deepEqual(result.cacheStatEvents, [{ kind: 'hit', tier: 'L3', cacheKind: 'packument', bytes: body.length }]);
  assert.deepEqual(
    [...new Set(reached)],
    ['getPackument'],
    `facet touched more of the supervisor than metadata reads: ${[...new Set(reached)]}`,
  );
}

// ── 6. What the registry served fills the colo cache as well as R2, and
//       both expire together: the next reader in the colo answers from L2.
//       A fill of R2 alone left the colo cold until a later session read R2
//       back (Markflow's 818 packuments: resolve 27.9 s from the registry,
//       then 22.6 s from R2, then 6.4 s from L2, a session each). ─────────
await withColoCache(async (colo) => {
  const bucket = fakeBucket();
  const body = packumentJson('react', '19.0.0', 'https://registry.npmjs.org/react/-/react-19.0.0.tgz');
  recordingFetch(() => new Response(body, { status: 200 }));
  const before = Date.now();
  await new R2CacheClient(null, bucket).readThroughPackument('react');

  const filled = colo.entries.get(packumentL2Url('react'));
  assert.ok(filled, 'the registry fill wrote the colo cache');
  assert.equal(new TextDecoder().decode(filled.body), body, 'with the registry response, verbatim');
  assert.equal(filled.headers['x-nimbus-expiresat'], bucket.store.get(packumentKey('react')).customMetadata.expiresAt,
    'the colo copy expires when the R2 copy does');
  const maxAge = Number(/^public, max-age=(\d+)$/.exec(filled.headers['cache-control'])?.[1]);
  assert.ok(maxAge <= PACKUMENT_TTL_MS / 1000 && maxAge >= (PACKUMENT_TTL_MS - (Date.now() - before)) / 1000 - 1,
    `the colo keeps it for the packument TTL: ${filled.headers['cache-control']}`);

  // Another session in the colo, over an R2 that has nothing: the colo answers.
  const calls = recordingFetch(() => { throw new Error('must not fetch: the colo cache holds it'); });
  const reader = new R2CacheClient(null, fakeBucket());
  const next = await reader.readThroughPackument('react');
  assert.equal(next.json, body);
  assert.equal(next.source, 'r2-cache');
  assert.equal(calls.length, 0);
  assert.deepEqual(reader.stats(), { l2HitsPackument: 1, l3GetsPackument: 0, l2HitsTarball: 0, l3GetsTarball: 0 });

  // What an egress answered is the workspace's: it fills neither tier.
  colo.entries.clear();
  const egressBucket = fakeBucket();
  const egress = { async fetch() { return new Response(body, { status: 200 }); } };
  const own = await new R2CacheClient(null, egressBucket).readThroughPackument('react', { retries: 0 }, workspaceNetwork(egress));
  assert.equal(own.source, 'network');
  assert.equal(colo.entries.size, 0, 'an egress answer reached the colo cache');
  assert.equal(egressBucket.store.size, 0, 'an egress answer reached R2');
});

globalThis.fetch = originalFetch;
console.log('npm-packument-cache-provenance: ok');
