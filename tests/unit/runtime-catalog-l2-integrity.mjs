#!/usr/bin/env bun

// The runtime catalog's L2 tier is `caches.default` — one per-colo cache
// shared by every tenant on the platform, and one the Worker itself writes.
// Its blobs are interpreters (python, ruby, bash, clang), so bytes that come
// out of it are bytes that execute inside whichever session installed them.
//
// It used to be trusted. `fetchCatalog` and `fetchManifest` shape-validated
// what L2 handed back and checked no digest at all, and `fetchBlob` verified
// only when a caller passed `expectedSha256` — which came from the manifest,
// which came from those unverified reads. Anyone able to write the cache
// could therefore publish a manifest naming an attacker blob key plus an
// attacker-chosen digest, plant matching bytes at that key, and have another
// tenant's session install and execute them.
//
// These tests pin the properties that close it, stated as behaviour of the
// public fetchers rather than of any key string:
//
//   1. Every L2 entry is found under the hash of its own contents, so a
//      writer can only ever address its own bytes.
//   2. Bytes coming out of L2 are re-hashed before use, so a fully
//      attacker-controlled cache still cannot change what gets installed.
//   3. A value whose digest is not known in advance does not enter L2 at
//      all — it is read from R2, the tier no binding can write.
//
// Test 1 below verifies that the key each test poisons is genuinely the key
// the module uses. Without that step every "attack was rejected" assertion
// would also pass against a module that had simply moved its keyspace.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mock } from 'bun:test';

const WORKER_SRC = new URL('../../packages/worker/src/', import.meta.url);
const CATALOG_SRC = new URL('runtime/runtime-catalog.ts', WORKER_SRC);

const enc = (text) => new TextEncoder().encode(text);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ── Fixtures: an honest publish, and an attacker's replacement ──────────

const HONEST_BLOB_KEY = 'blobs/python-1.0/aaa/python.wasm';
const HONEST_BLOB = enc('honest interpreter bytes');

const ATTACKER_BLOB_KEY = 'blobs/python-1.0/bbb/python.wasm';
const ATTACKER_BLOB = enc('attacker interpreter bytes');

const honestManifestText = JSON.stringify({
  name: 'python',
  version: '1.0',
  license: 'MIT',
  wasi_namespace: null,
  files: [{ path: 'python.wasm', content: HONEST_BLOB_KEY, sha256: sha(HONEST_BLOB), size: HONEST_BLOB.length }],
  entrypoints: [{ binName: 'python', runner: 'python-runner', args: [] }],
});

// Shape-valid, and self-consistent: it names the attacker's blob and the
// attacker's digest, so the blob-level check alone would wave it through.
const attackerManifestText = JSON.stringify({
  name: 'python',
  version: '1.0',
  license: 'MIT',
  wasi_namespace: null,
  files: [{ path: 'python.wasm', content: ATTACKER_BLOB_KEY, sha256: sha(ATTACKER_BLOB), size: ATTACKER_BLOB.length }],
  entrypoints: [{ binName: 'python', runner: 'python-runner', args: [] }],
});

const MANIFEST_KEY = 'manifests/python-1.0.json';
const honestManifest = enc(honestManifestText);
const attackerManifest = enc(attackerManifestText);

const catalogEntry = {
  manifest: MANIFEST_KEY,
  manifest_sha256: sha(honestManifest),
  size_bytes: HONEST_BLOB.length,
  license: 'MIT',
};

const honestCatalogText = JSON.stringify({
  version: 1,
  runtimes: { python: { default: '1.0', versions: { '1.0': catalogEntry } } },
});
const honestCatalog = enc(honestCatalogText);

// Points at the same manifest key but vouches for the attacker's bytes.
const attackerCatalogText = JSON.stringify({
  version: 1,
  runtimes: {
    python: {
      default: '1.0',
      versions: {
        '1.0': { manifest: MANIFEST_KEY, manifest_sha256: sha(attackerManifest), size_bytes: 1, license: 'MIT' },
      },
    },
  },
});

// The build-time root of trust, injected before the module under test loads.
mock.module(new URL('runtime-catalog.generated.ts', WORKER_SRC).pathname, () => ({
  RUNTIME_CATALOG_SHA256: sha(honestCatalog),
}));

const { fetchCatalog, fetchManifest, fetchBlob } = await import(CATALOG_SRC.pathname);

// ── Harness ────────────────────────────────────────────────────────────

function installCache() {
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(req) {
        const hit = store.get(req.url);
        return hit ? hit.clone() : undefined;
      },
      async put(req, res) {
        store.set(req.url, res.clone());
      },
    },
  };
  return store;
}

/** R2 holding the honest publish. Records every key read. */
function honestR2() {
  const objects = new Map([
    ['catalog/v1.json', honestCatalog],
    [MANIFEST_KEY, honestManifest],
    [HONEST_BLOB_KEY, HONEST_BLOB],
    [ATTACKER_BLOB_KEY, ATTACKER_BLOB],
  ]);
  const reads = [];
  return {
    reads,
    async get(key) {
      reads.push(key);
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        async text() {
          return new TextDecoder().decode(bytes);
        },
      };
    },
  };
}

const envWith = (r2) => ({ NIMBUS_RUNTIME_CACHE: r2 });
const text = (bytes) => new TextDecoder().decode(bytes);

function poison(store, url, bytes) {
  store.set(url, new Response(bytes, { headers: { 'Cache-Control': 'public, max-age=31536000' } }));
}

// ── 1. The keys these tests poison are the keys the module uses ─────────
//
// Every later test writes attacker bytes to a URL and asserts they are not
// served. If the module keyed L2 differently, those writes would land
// nowhere and every assertion would pass without exercising anything. So
// first: drive an honest fetch against an empty cache and read the keyspace
// back off it.

const keys = await (async () => {
  const store = installCache();
  const r2 = honestR2();
  const catalog = await fetchCatalog(envWith(r2));
  const entry = catalog.runtimes.python.versions['1.0'];
  const manifest = await fetchManifest(envWith(r2), entry);
  await fetchBlob(envWith(r2), manifest.files[0]);

  const urls = [...store.keys()];
  assert.equal(urls.length, 3, `expected catalog+manifest+blob in L2, got ${JSON.stringify(urls)}`);

  const find = (scope) => {
    const url = urls.find((u) => u.includes(`/${scope}/`));
    assert.ok(url, `module wrote no ${scope} entry; keyspace is ${JSON.stringify(urls)}`);
    return url;
  };
  return { catalog: find('catalog'), manifest: find('manifest'), blob: find('blob') };
})();

// Each entry sits under the hash of its own contents. This is the property
// that makes the keyspace unpoisonable: a writer cannot reach another
// value's key without producing bytes that hash to it.
assert.ok(keys.catalog.endsWith(`/${sha(honestCatalog)}`), `catalog key is not its digest: ${keys.catalog}`);
assert.ok(keys.manifest.endsWith(`/${sha(honestManifest)}`), `manifest key is not its digest: ${keys.manifest}`);
assert.ok(keys.blob.endsWith(`/${sha(HONEST_BLOB)}`), `blob key is not its digest: ${keys.blob}`);

// The keyspace moved when the reads became verified; anything cached under
// the old scheme was written to a key its contents never had to match.
for (const url of Object.values(keys)) {
  assert.ok(
    !url.includes('nimbus-runtime-cache.invalid'),
    `L2 namespace was not bumped, so pre-hardening entries are still trusted: ${url}`,
  );
}

// ── 2. A poisoned manifest in L2 is not served ─────────────────────────

{
  const store = installCache();
  const r2 = honestR2();
  poison(store, keys.manifest, attackerManifest);

  const manifest = await fetchManifest(envWith(r2), catalogEntry);

  assert.equal(
    manifest.files[0].content,
    HONEST_BLOB_KEY,
    'a poisoned L2 manifest was served: the install would fetch the attacker blob key',
  );
  assert.ok(r2.reads.includes(MANIFEST_KEY), 'the rejected cache entry did not fall through to R2');
}

// ── 3. A poisoned blob in L2 is not served ─────────────────────────────

{
  const store = installCache();
  const r2 = honestR2();
  poison(store, keys.blob, ATTACKER_BLOB);

  const bytes = await fetchBlob(envWith(r2), JSON.parse(honestManifestText).files[0]);

  assert.equal(text(bytes), text(HONEST_BLOB), 'a poisoned L2 blob was executed');
  assert.ok(r2.reads.includes(HONEST_BLOB_KEY), 'the rejected cache entry did not fall through to R2');
}

// ── 4. A poisoned catalog in L2 is not served ──────────────────────────

{
  const store = installCache();
  const r2 = honestR2();
  poison(store, keys.catalog, enc(attackerCatalogText));

  const catalog = await fetchCatalog(envWith(r2));

  assert.equal(
    catalog.runtimes.python.versions['1.0'].manifest_sha256,
    sha(honestManifest),
    'a poisoned L2 catalog was served: it would vouch for the attacker manifest',
  );
  assert.ok(r2.reads.includes('catalog/v1.json'), 'the rejected cache entry did not fall through to R2');
}

// ── 5. A fully attacker-controlled L2 cannot change what is installed ───
//
// The whole chain poisoned at once, each entry internally consistent: the
// catalog vouches for the attacker manifest, which names the attacker blob
// and its true digest. Every individual document verifies against the one
// above it. Only the pinned root breaks the chain.

{
  const store = installCache();
  const r2 = honestR2();
  poison(store, keys.catalog, enc(attackerCatalogText));
  poison(store, keys.manifest, attackerManifest);
  poison(store, keys.blob, ATTACKER_BLOB);

  const catalog = await fetchCatalog(envWith(r2));
  const entry = catalog.runtimes.python.versions['1.0'];
  const manifest = await fetchManifest(envWith(r2), entry);
  const bytes = await fetchBlob(envWith(r2), manifest.files[0]);

  assert.equal(
    text(bytes),
    text(HONEST_BLOB),
    'cross-tenant RCE: an attacker-controlled colo cache changed the interpreter bytes a session installs',
  );
}

// ── 6. Nothing unverified is ever written to L2 ────────────────────────

{
  const store = installCache();
  const r2 = honestR2();
  const catalog = await fetchCatalog(envWith(r2));
  const manifest = await fetchManifest(envWith(r2), catalog.runtimes.python.versions['1.0']);
  await fetchBlob(envWith(r2), manifest.files[0]);

  assert.ok(store.size > 0, 'nothing was cached, so this proves nothing about what caching allows');
  for (const [url, res] of store) {
    const cached = new Uint8Array(await res.clone().arrayBuffer());
    assert.equal(sha(cached), url.slice(url.lastIndexOf('/') + 1), `L2 entry does not hash to its key: ${url}`);
  }
}

// ── 7. R2 disagreeing with the digest above it is fatal ────────────────
//
// R2 is the trusted tier, so a mismatch there is not a stale cache to route
// around — it is a publish that is internally inconsistent, and serving it
// would mean executing bytes nothing vouched for.

{
  installCache();
  const r2 = honestR2();
  await assert.rejects(
    () => fetchManifest(envWith(r2), { ...catalogEntry, manifest_sha256: sha(attackerManifest) }),
    /sha256 mismatch for manifest/,
    'a manifest whose R2 bytes contradict the catalog was accepted',
  );
}

{
  installCache();
  const r2 = honestR2();
  const file = { ...JSON.parse(honestManifestText).files[0], sha256: sha(ATTACKER_BLOB) };
  await assert.rejects(
    () => fetchBlob(envWith(r2), file),
    /sha256 mismatch for blob/,
    'a blob whose R2 bytes contradict the manifest was accepted',
  );
}

// ── 8. fetchBlob has no unverified mode ────────────────────────────────
//
// The digest used to be an optional third argument, so the unverified read
// was the one you got by forgetting it. It is now part of the manifest entry
// the fetch takes, which makes the unsafe call unwritable — `npm run
// typecheck` is what enforces that. This pins the runtime half, for entries
// that reach the fetcher from parsed JSON rather than from a call site.

{
  installCache();
  const r2 = honestR2();
  const file = JSON.parse(honestManifestText).files[0];

  for (const bad of ['', 'not-a-digest', 'z'.repeat(64), 'a'.repeat(63)]) {
    await assert.rejects(
      () => fetchBlob(envWith(r2), { ...file, sha256: bad }),
      /no usable sha256/,
      `fetchBlob accepted a manifest entry whose digest is ${JSON.stringify(bad)}`,
    );
  }
  assert.deepEqual(r2.reads, [], 'an unverifiable blob was fetched before being refused');
}

// ── 9. What cannot be verified does not enter L2 ───────────────────────
//
// A catalog published before manifest digests were recorded carries no
// digest for its manifest. That manifest is read from R2 and neither read
// from nor written to the shared cache — the same posture r2-cache.ts takes
// for a tarball whose integrity string it cannot parse. Degrading to a cache
// miss is the only safe way to not know a digest.

{
  const store = installCache();
  const r2 = honestR2();
  const { manifest_sha256: _omitted, ...undigested } = catalogEntry;

  poison(store, keys.manifest, attackerManifest);
  // Key → bytes: a write that overwrites the planted key would leave the
  // key set identical, so comparing keys alone would not see it.
  const snapshot = async () => {
    const out = [];
    for (const [url, res] of store) out.push([url, sha(new Uint8Array(await res.clone().arrayBuffer()))]);
    return out.sort();
  };
  const before = await snapshot();

  const manifest = await fetchManifest(envWith(r2), undigested);

  assert.equal(manifest.files[0].content, HONEST_BLOB_KEY, 'an undigested manifest was read from L2 anyway');
  assert.deepEqual(await snapshot(), before, 'an unverifiable manifest was written into the shared cache');
}

// ── 10. The Cache API is reachable only through the checked helpers ────
//
// Both properties above live in `l2Get` / `l2Put`. A future read path that
// touches `caches.default` directly would bypass them while every test above
// still passed, so pin the module's access to those two functions.

{
  const source = readFileSync(CATALOG_SRC, 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  // Guard the guard: if comment-stripping ate the module, the count below
  // would be trivially satisfied.
  assert.ok(code.includes('export async function fetchBlob'), 'comment stripping removed the code under test');
  assert.ok(!code.includes('trust model'), 'comment stripping left doc comments behind');

  const start = code.indexOf('async function l2Get(');
  const end = code.indexOf('function l2Url(');
  assert.ok(start > 0 && end > start, 'could not locate the L2 helpers; this check is not running');

  const helpers = code.slice(start, end);
  assert.ok((helpers.match(/\bcaches\b/g) ?? []).length > 0, 'the helpers do not reach the Cache API');

  // Everything but the helpers and the type alias naming the global.
  const outside = (code.slice(0, start) + code.slice(end))
    .split('\n')
    .filter((line) => !line.startsWith('type CacheGlobal'))
    .join('\n');
  assert.deepEqual(
    outside.match(/\bcaches\b/g) ?? [],
    [],
    'the module reaches the Cache API outside l2Get/l2Put, skipping the digest checks',
  );
}

console.log('runtime-catalog-l2-integrity: ok');
