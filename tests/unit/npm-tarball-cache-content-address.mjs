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
import { gzipSync, gunzipSync } from 'node:zlib';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import {
  R2CacheClient,
  parseTarballAddress,
  tarballKey,
} from '../../packages/worker/src/npm/r2-cache.ts';
import {
  readableStreamToAsyncIterable,
  streamTarEntries,
} from '../../packages/worker/src/npm/tarball-stream.ts';
import {
  decodeWriteBatchStream,
  encodeWriteBatchStream,
} from '../../packages/worker/src/_shared/w7-frame.ts';

globalThis.streamTarEntries = streamTarEntries;
globalThis.readableStreamToAsyncIterable = readableStreamToAsyncIterable;
globalThis.encodeWriteBatchStream = encodeWriteBatchStream;
globalThis.__nimbusUseRpcResult = async (promise, use) => use(await promise);
globalThis.DecompressionStream = class DecompressionStream {
  readable;
  writable;

  constructor(format) {
    assert.equal(format, 'gzip');
    const transform = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(gunzipSync(chunk));
      },
    });
    this.readable = transform.readable;
    this.writable = transform.writable;
  }
};

// ── tar fixtures ────────────────────────────────────────────────────────

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function tarFile(name, text) {
  const data = new TextEncoder().encode(text);
  const header = new Uint8Array(512);
  const write = (offset, value, width) => {
    header.set(new TextEncoder().encode(value).subarray(0, width), offset);
  };
  write(0, name, 100);
  write(100, octal(0o644, 8), 8);
  write(108, octal(0, 8), 8);
  write(116, octal(0, 8), 8);
  write(124, octal(data.length, 12), 12);
  write(136, octal(0, 12), 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  write(257, 'ustar\0', 6);
  write(263, '00', 2);
  write(148, octal(header.reduce((sum, byte) => sum + byte, 0), 8), 8);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [header, padded];
}

/** A one-file package tarball whose index.js body is `payload`. */
function makeTarball(payload) {
  const parts = [
    ...tarFile('package/package.json', '{"name":"react","version":"19.0.0"}'),
    ...tarFile('package/index.js', payload),
    new Uint8Array(1024),
  ];
  const tar = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(gzipSync(tar));
}

async function sriOf(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes));
  let bin = '';
  for (const byte of digest) bin += String.fromCharCode(byte);
  return `sha512-${btoa(bin)}`;
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

  // Every SRI algorithm npm emits is addressable.
  for (const [algo, expected] of [['sha512', 'SHA-512'], ['sha384', 'SHA-384'], ['sha256', 'SHA-256'], ['sha1', 'SHA-1']]) {
    const parsed = parseTarballAddress(`${algo}-${btoa('x'.repeat(20))}`);
    assert.ok(parsed, `${algo} must be addressable`);
    assert.equal(parsed.digestAlgo, expected);
  }
}

globalThis.fetch = originalFetch;
console.log('npm-tarball-cache-content-address: ok');
