#!/usr/bin/env bun

// The npm tarball cache is one R2 bucket shared by every tenant, so its
// keyspace is a cross-tenant trust boundary.
//
// It used to be keyed by `name@version`, which a tenant can choose freely:
// npm alias syntax (`npm i react@npm:evil@1.0.0`) makes the INSTALL name
// independent of the REGISTRY package, so evil's tarball was written to
// react's key and passed evil's own integrity check on the way in. Cache
// hits were then consumed without re-hashing, so every later tenant that
// installed react executed evil's code.
//
// These tests pin the two properties that close it, both stated as
// behaviour of the public surface (R2CacheClient + installPackagesInFacet)
// rather than of the key string:
//
//   1. A writer can only ever address its OWN bytes.
//   2. Bytes coming out of the shared store are re-hashed before use, so
//      a fully attacker-controlled store still cannot serve wrong bytes.

import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import {
  R2CacheClient,
  parseTarballAddress,
  tarballKey,
  tarballL2Url,
} from '../../packages/worker/src/npm/r2-cache.ts';
import {
  readableStreamToAsyncIterable,
  streamPackageEntries,
  streamTarEntries,
} from '../../packages/core/src/_shared/tarball-stream.ts';
import {
  decodeWriteBatchStream,
  encodeWriteBatchStream,
} from '../../packages/platform/src/w7-frame.ts';
import { packageTarball, sriOf } from './lib/tarball-fixture.mjs';
import { withColoCache } from './lib/colo-cache.mjs';
import './lib/install-facet-scope.mjs';


// ── tar fixtures ────────────────────────────────────────────────────────

/** A one-file package tarball whose index.js body is `payload`. */
function makeTarball(payload) {
  return packageTarball({
    'package/package.json': '{"name":"react","version":"19.0.0"}',
    'package/index.js': payload,
  });
}


// ── harness ─────────────────────────────────────────────────────────────

/** In-memory stand-in for the shared NPM_TARBALL_CACHE bucket. */
function fakeBucket() {
  const store = new Map();
  return {
    store,
    async get(key) {
      const value = store.get(key);
      if (!value) return null;
      return { arrayBuffer: async () => value.slice().buffer };
    },
    async put(key, body) {
      store.set(key, body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(body));
    },
    async delete(key) { store.delete(key); },
  };
}

/**
 * The supervisor surface the install facet sees, wired to a bucket exactly
 * the way SupervisorRPC wires it (bucket → R2CacheClient → facet).
 */
function supervisorFor(bucket, installedFiles) {
  return {
    async writeBatchStream(stream) {
      const decoded = await decodeWriteBatchStream(stream);
      let paths = 0;
      for await (const record of decoded.records) {
        if (record.type === 'directory' || record.type === 'file-begin') paths++;
        if (record.type === 'file-begin') installedFiles.set(record.inode.path, []);
        if (record.type === 'file-chunk') {
          installedFiles.get(record.path)?.push(new Uint8Array(record.data));
          record.retention.release();
        }
      }
      return { ok: true, committedGroupSequence: paths, committedPathCount: paths, inodes: paths, chunks: 0 };
    },
    async getCachedTarball(integrity) {
      const client = new R2CacheClient(bucket, null);
      const bytes = await client.getTarball(integrity);
      return { bytes, events: client._cacheEvents };
    },
    async putCachedTarball(integrity, bytes) {
      return new R2CacheClient(bucket, null).putTarball(integrity, bytes);
    },
  };
}

function specFor(name, version, integrity, tarballUrl) {
  return {
    name,
    version,
    tarballUrl,
    integrity,
    pkgDir: `node_modules/${name}`,
    installRoot: 'node_modules',
    mtime: 1,
    chunkSize: 65_536,
  };
}

function fileText(installedFiles, path) {
  const chunks = installedFiles.get(path) ?? [];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const flat = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { flat.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(flat);
}

const EVIL = makeTarball('globalThis.pwned = true;');
const GOOD = makeTarball('export default 1;');
const EVIL_SRI = await sriOf(EVIL);
const GOOD_SRI = await sriOf(GOOD);

const originalFetch = globalThis.fetch;
function stubFetch(byUrl) {
  globalThis.fetch = async (url) => {
    const bytes = byUrl.get(String(url));
    if (!bytes) return new Response('not found', { status: 404 });
    return new Response(bytes.slice(), { status: 200, headers: { 'content-length': String(bytes.length) } });
  };
}

// ── 1. An aliased install cannot address another package's bytes ────────
{
  const bucket = fakeBucket();
  stubFetch(new Map([['https://evil.invalid/evil-19.0.0.tgz', EVIL]]));

  // `npm install react@npm:evil@19.0.0` — the resolver reports installName
  // 'react' with evil's registry coordinates, which is exactly the spec the
  // install facet receives.
  const attacker = await installPackagesInFacet(
    { packages: [specFor('react', '19.0.0', EVIL_SRI, 'https://evil.invalid/evil-19.0.0.tgz')], concurrency: 1 },
    { SUPERVISOR: supervisorFor(bucket, new Map()) },
  );
  assert.ok(!attacker.perPackage[0].errorText, attacker.perPackage[0].errorText);

  const keys = [...bucket.store.keys()];
  assert.equal(keys.length, 1, 'attacker install writes exactly one cache entry');
  assert.equal(
    keys[0],
    tarballKey(parseTarballAddress(EVIL_SRI)),
    'the entry is addressed by the attacker OWN bytes',
  );
  for (const key of keys) {
    assert.ok(!key.includes('react'), `cache key must not carry an install name: ${key}`);
    assert.ok(!key.includes('19.0.0'), `cache key must not carry a version: ${key}`);
  }

  // A different tenant now installs the real react@19.0.0. Its own digest
  // is not in the store, so the poisoned entry is unreachable: the install
  // goes to the network and gets the genuine bytes.
  stubFetch(new Map([['https://registry.invalid/react-19.0.0.tgz', GOOD]]));
  const victimFiles = new Map();
  const victim = await installPackagesInFacet(
    { packages: [specFor('react', '19.0.0', GOOD_SRI, 'https://registry.invalid/react-19.0.0.tgz')], concurrency: 1 },
    { SUPERVISOR: supervisorFor(bucket, victimFiles) },
  );
  assert.ok(!victim.perPackage[0].errorText, victim.perPackage[0].errorText);
  assert.equal(
    fileText(victimFiles, 'node_modules/react/index.js'),
    'export default 1;',
    'victim must receive the genuine tarball, never the aliased attacker upload',
  );
  assert.equal(victim.facetCounters.pipelinedTarballRaceWins, 0, 'poisoned entry must not serve as a hit');
}

// ── 2. A tampered store entry is rejected on read, not executed ─────────
{
  const bucket = fakeBucket();
  // Simulate the strongest attacker: arbitrary bytes written directly under
  // a legitimate package's key, bypassing every write-side check.
  await bucket.put(tarballKey(parseTarballAddress(GOOD_SRI)), EVIL);

  const client = new R2CacheClient(bucket, null);
  assert.equal(await client.getTarball(GOOD_SRI), null, 'tampered entry must read as a miss');

  stubFetch(new Map([['https://registry.invalid/react-19.0.0.tgz', GOOD]]));
  const files = new Map();
  const result = await installPackagesInFacet(
    { packages: [specFor('react', '19.0.0', GOOD_SRI, 'https://registry.invalid/react-19.0.0.tgz')], concurrency: 1 },
    { SUPERVISOR: supervisorFor(bucket, files) },
  );
  assert.ok(!result.perPackage[0].errorText, result.perPackage[0].errorText);
  assert.equal(
    fileText(files, 'node_modules/react/index.js'),
    'export default 1;',
    'tampered cache bytes must never reach the filesystem',
  );
}

// ── 3. Honest round-trip still hits, and identical bytes still dedup ────
{
  const bucket = fakeBucket();
  const client = new R2CacheClient(bucket, null);
  assert.equal(await client.putTarball(GOOD_SRI, GOOD), true);
  const got = await client.getTarball(GOOD_SRI);
  assert.ok(got && got.length === GOOD.length, 'a verified entry reads back');
  assert.deepEqual([...got.slice(0, 16)], [...GOOD.slice(0, 16)]);

  // Two packages that ship byte-identical tarballs share one entry —
  // cross-tenant dedup survives content addressing.
  assert.equal(await client.putTarball(GOOD_SRI, GOOD), true);
  assert.equal(bucket.store.size, 1, 'identical bytes occupy exactly one key');

  // And an end-to-end second install of the same package hits the cache.
  stubFetch(new Map());
  const files = new Map();
  const result = await installPackagesInFacet(
    { packages: [specFor('react', '19.0.0', GOOD_SRI, 'https://registry.invalid/unreachable.tgz')], concurrency: 1 },
    { SUPERVISOR: supervisorFor(bucket, files) },
  );
  assert.ok(!result.perPackage[0].errorText, result.perPackage[0].errorText);
  assert.equal(result.facetCounters.pipelinedTarballRaceWins, 1, 'warm install must be served by the cache');
  assert.equal(fileText(files, 'node_modules/react/index.js'), 'export default 1;');
}

// ── 4. Nothing unverifiable is ever stored or served ────────────────────
{
  const bucket = fakeBucket();
  const client = new R2CacheClient(bucket, null);

  // Bytes that do not hash to the address they claim.
  assert.equal(await client.putTarball(GOOD_SRI, EVIL), false, 'mismatched bytes are refused');
  assert.equal(bucket.store.size, 0);

  for (const junk of ['', 'not-an-sri', 'sha512-', 'md5-abc', 'deadbeef', 'sha512-not!base64!', 'sha512-AAA sha256-BBB']) {
    assert.equal(parseTarballAddress(junk), null, `must not address on ${JSON.stringify(junk)}`);
    assert.equal(await client.putTarball(junk, GOOD), false, `must not store on ${JSON.stringify(junk)}`);
    assert.equal(await client.getTarball(junk), null, `must not serve on ${JSON.stringify(junk)}`);
  }
  assert.equal(bucket.store.size, 0, 'an unverifiable package never touches the shared store');

  // Every SRI algorithm npm emits is addressable, by a digest of its length;
  // a digest of another length is not one of it.
  for (const [algo, expected, bytes] of [['sha512', 'SHA-512', 64], ['sha384', 'SHA-384', 48], ['sha256', 'SHA-256', 32], ['sha1', 'SHA-1', 20]]) {
    const parsed = parseTarballAddress(`${algo}-${btoa('x'.repeat(bytes))}`);
    assert.ok(parsed, `${algo} must be addressable`);
    assert.equal(parsed.digestAlgo, expected);
    assert.equal(parseTarballAddress(`${algo}-${btoa('x'.repeat(bytes - 1))}`), null, `${algo} of ${bytes - 1} bytes is not addressable`);
  }
}

// ── 5. Stored bytes fill the colo cache as well as R2: the next reader in
//       the colo answers from L2. A fill of R2 alone (a tarball fetched from
//       the registry) sent the next session to R2 for it (5 of 5 such
//       tarballs on a throwaway). Refused bytes reach neither. ────────────
await withColoCache(async (colo) => {
  const bucket = fakeBucket();
  assert.equal(await new R2CacheClient(bucket, null).putTarball(GOOD_SRI, EVIL), false);
  assert.equal(colo.entries.size, 0, 'bytes that do not hash to their address never reach the colo cache');

  assert.equal(await new R2CacheClient(bucket, null).putTarball(GOOD_SRI, GOOD), true);
  const filled = colo.entries.get(tarballL2Url(parseTarballAddress(GOOD_SRI)));
  assert.ok(filled, 'the stored tarball reached the colo cache');
  assert.deepEqual([...filled.body], [...GOOD], 'byte for byte');
  assert.equal(filled.headers['cache-control'], 'public, max-age=31536000, immutable', 'immutable, as its content address is');

  // Another session in the colo, over an R2 that has nothing: the colo answers.
  const reader = new R2CacheClient(fakeBucket(), null);
  const got = await reader.getTarball(GOOD_SRI);
  assert.deepEqual([...got], [...GOOD]);
  assert.deepEqual(reader.stats(), { l2HitsPackument: 0, l3GetsPackument: 0, l2HitsTarball: 1, l3GetsTarball: 0 });
});

globalThis.fetch = originalFetch;
console.log('npm-tarball-cache-content-address: ok');
