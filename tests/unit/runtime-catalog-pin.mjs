#!/usr/bin/env bun
// The catalog a deployment installs from is the one its
// NIMBUS_RUNTIME_CATALOG_SHA256 var names, read by that digest
// (catalog/sha256/<digest>.json) and served only when its bytes hash to it
// (packages/worker/src/runtime/runtime-catalog.ts fetchCatalog). A publish for
// one deployment therefore never changes what another reads, and there is no
// unpinned read to fall back to:
//
//   - no var, or one that is not a digest: the install fails, saying which
//     var and how to get its value, and nothing is read;
//   - the object by digest: served, and cached under that digest;
//   - catalog/v1.json, the key deployments that predate this read: never read;
//   - the object missing, or holding other bytes: the install fails naming
//     the key, and nothing unverified is served or cached;
//   - a planted cache entry under the digest: not served.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { fetchCatalog, CATALOG_PIN_MISSING } = await import(new URL('../../packages/worker/src/runtime/runtime-catalog.ts', import.meta.url).pathname);

const enc = (text) => new TextEncoder().encode(text);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const honest = enc(JSON.stringify({
  version: 1,
  runtimes: { python: { default: '1.0', versions: { '1.0': { manifest: 'manifests/python-1.0.json', size_bytes: 1, license: 'MIT' } } } },
}));
const attacker = enc(JSON.stringify({
  version: 1,
  runtimes: { evil: { default: '1.0', versions: { '1.0': { manifest: 'manifests/evil.json', size_bytes: 1, license: 'MIT' } } } },
}));
const PIN = sha(honest);
const KEY = `catalog/sha256/${PIN}.json`;

const store = new Map();
globalThis.caches = {
  default: {
    async match(req) { const hit = store.get(req.url); return hit ? hit.clone() : undefined; },
    async put(req, res) { store.set(req.url, new Response(await res.arrayBuffer())); },
  },
};
/** An R2 bucket holding `objects`, recording every key read. */
function bucket(objects) {
  const reads = [];
  return {
    reads,
    async get(key) {
      reads.push(key);
      const bytes = objects[key];
      if (bytes === undefined) return null;
      return { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
    },
  };
}
const pinnedCache = 'https://nimbus-runtime-cache-v2.invalid/catalog/' + PIN;

// No var, or not a digest: fail, naming the var and where its value comes from; read nothing.
for (const pin of [undefined, '', 'latest']) {
  const r2 = bucket({ [KEY]: honest, 'catalog/v1.json': honest });
  await assert.rejects(fetchCatalog({ NIMBUS_RUNTIME_CACHE: r2, NIMBUS_RUNTIME_CATALOG_SHA256: pin }), (error) => {
    assert.ok(error.message.includes(CATALOG_PIN_MISSING), error.message);
    assert.match(error.message, /NIMBUS_RUNTIME_CATALOG_SHA256/);
    assert.match(error.message, /nimbus runtime sync/);
    return true;
  });
  assert.deepEqual(r2.reads, [], `nothing is read without a pin (${JSON.stringify(pin)})`);
}
assert.equal(store.size, 0);

// By digest: served, cached under it; catalog/v1.json is never read.
{
  const r2 = bucket({ [KEY]: honest, 'catalog/v1.json': attacker });
  const catalog = await fetchCatalog({ NIMBUS_RUNTIME_CACHE: r2, NIMBUS_RUNTIME_CATALOG_SHA256: PIN });
  assert.deepEqual(Object.keys(catalog.runtimes), ['python']);
  assert.deepEqual(r2.reads, [KEY]);
  assert.ok(store.has(pinnedCache), 'cached under its digest');
  // Served from the cache next time, without R2.
  const again = bucket({});
  assert.deepEqual(Object.keys((await fetchCatalog({ NIMBUS_RUNTIME_CACHE: again, NIMBUS_RUNTIME_CATALOG_SHA256: PIN })).runtimes), ['python']);
  assert.deepEqual(again.reads, []);
  store.clear();
}

// Missing, or other bytes: fail naming the key; nothing unverified is served or cached.
{
  const missing = bucket({ 'catalog/v1.json': honest });
  await assert.rejects(fetchCatalog({ NIMBUS_RUNTIME_CACHE: missing, NIMBUS_RUNTIME_CATALOG_SHA256: PIN }),
    (error) => error.message.includes(KEY) && /does not hold/.test(error.message));
  assert.deepEqual(missing.reads, [KEY], 'no fallback to catalog/v1.json');
  const forged = bucket({ [KEY]: attacker });
  await assert.rejects(fetchCatalog({ NIMBUS_RUNTIME_CACHE: forged, NIMBUS_RUNTIME_CATALOG_SHA256: PIN }),
    (error) => error.message.includes(KEY) && error.message.includes(sha(attacker)));
  assert.equal(store.size, 0, 'nothing unverified was cached');
}

// A planted cache entry under the digest is not served: the read goes on to R2.
{
  store.set(pinnedCache, new Response(attacker));
  const r2 = bucket({ [KEY]: honest });
  assert.deepEqual(Object.keys((await fetchCatalog({ NIMBUS_RUNTIME_CACHE: r2, NIMBUS_RUNTIME_CATALOG_SHA256: PIN })).runtimes), ['python']);
  assert.deepEqual(r2.reads, [KEY]);
}

console.log('runtime-catalog-pin: ok');
