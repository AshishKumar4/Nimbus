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
import { R2CacheClient, packumentKey } from '../../packages/worker/src/npm/r2-cache.ts';
import { resolveOnePackumentInFacet } from '../../packages/worker/src/npm/resolve-one-facet.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../packages/worker/src/loaders/npm-resolve-preamble.ts';

// The resolve facet reads its policy/semver helpers as bare identifiers
// injected by the loader preamble. Evaluate the real preamble so this test
// exercises the real decisions.
const PREAMBLE_SYMBOLS = [
  'SHOULD_SKIP_PACKAGE', 'SHOULD_SWAP', 'SHOULD_REJECT_FAIL', 'SHOULD_WARN_SKIP_TRANSITIVE',
  'NATIVE_EXECUTABLE_REJECT', 'IS_OPTIONAL_NATIVE_BINDING', 'PARSE_SEMVER', 'COMPARE_SEMVER',
  'SATISFIES_RANGE', 'RESOLVE_VERSION', 'STAGED_ARTIFACT', 'STAGED_ARTIFACT_APPLY',
];
Object.assign(
  globalThis,
  new Function(`${NPM_RESOLVE_PREAMBLE}\nreturn { ${PREAMBLE_SYMBOLS.join(', ')} };`)(),
);
globalThis.__nimbusUseRpcResult = async (promise, use) => use(await promise);

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

// ── 4. The resolve facet holds no cache-write capability and never
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
    { name: 'react', range: '19.0.0', cachedEntries: [], topLevel: true, isOptional: false, frameworkAware: false, fetchTimeoutMs: 15_000, retries: 3 },
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

globalThis.fetch = originalFetch;
console.log('npm-packument-cache-provenance: ok');
