#!/usr/bin/env bun
// npm's cache modes for the packuments an install reads, as npm has them
// (npm-registry-fetch getCacheMode, make-fetch-happen's cache):
// - `--offline` (only-if-cached): any cached copy answers, stale or not; a
//   package with none is ENOTCACHED, and nothing goes to the network.
// - `--prefer-offline` (force-cache): any cached copy answers, stale or not;
//   one with none is fetched.
// - `--prefer-online` (no-cache): the cached copy is asked of the registry
//   again however fresh, on its ETag (a 304 keeps it), and an exact
//   version's session record does not answer in its place.
// - otherwise (default): a fresh copy answers. A copy past its 60 minutes
//   is asked of the registry on its ETag. A stale colo copy reads R2 first,
//   where another colo may have renewed it.
// The deprecated `--cache-max=0` and `--cache-min=9999` are npm's aliases of
// --prefer-online and --prefer-offline. A higher layer's setting wins, as
// npm flattens its layers in order.
//
// Red before: every install read packuments in the default mode (the
// options were accepted and ignored), and a stale colo copy went straight to
// the registry.

import assert from 'node:assert/strict';
import { npmInstallInvocation } from '../../packages/core/src/substrate/lifo/commands/system/npm-install-args.ts';
import { loadNpmConfig } from '../../packages/core/src/substrate/lifo/commands/system/npm-config.ts';
import { PACKUMENT_TTL_MS, R2CacheClient, packumentKey, packumentL2Url, packumentUrl } from '../../packages/worker/src/npm/r2-cache.ts';
import { registryRecord } from '../../packages/worker/src/npm/registry-record.ts';
import { resolveOnePackumentInFacet } from '../../packages/worker/src/npm/resolve-one-facet.ts';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import { withColoCache } from './lib/colo-cache.mjs';
import { packageTarball, sriOf } from './lib/tarball-fixture.mjs';
import './lib/install-facet-scope.mjs';
import './lib/resolve-facet-scope.mjs';

const failures = [];
const check = async (what, run) => {
  try { await run(); console.log(`  ✓ ${what}`); } catch (error) { failures.push(what); console.log(`  ✗ ${what}: ${String(error?.message ?? error).split('\n')[0]}`); }
};

// ── The mode, from npm's configuration ─────────────────────────────────────

/** The cache mode `npm install <args>` reads packuments in, with `env` and `.npmrc` (the user's). */
async function modeOf(args, env = {}, npmrc = null) {
  const files = npmrc === null ? {} : { '/home/user/.npmrc': npmrc };
  const vfs = {
    async exists(path) { return Object.keys(files).some((at) => at === path || at.startsWith(`${path}/`)); },
    async readFileString(path) {
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return files[path];
    },
  };
  return npmInstallInvocation(await loadNpmConfig(vfs, '/home/user/app', { HOME: '/home/user', ...env }, ['install', ...args, 'left-pad'])).cache;
}

await check('each option maps to npm-registry-fetch\'s mode, offline over prefer-offline over prefer-online', async () => {
  const table = [
    [[], {}, null, 'default'],
    [['--prefer-online'], {}, null, 'no-cache'],
    [['--prefer-offline'], {}, null, 'force-cache'],
    [['--offline'], {}, null, 'only-if-cached'],
    [['--prefer-online', '--prefer-offline'], {}, null, 'force-cache'],
    [['--prefer-offline', '--offline'], {}, null, 'only-if-cached'],
    [[], { npm_config_prefer_online: 'true' }, null, 'no-cache'],
    [[], { npm_config_offline: 'true' }, null, 'only-if-cached'],
    [[], {}, 'prefer-offline=true\n', 'force-cache'],
    [['--cache-max=0'], {}, null, 'no-cache'],
    [['--cache-min=9999'], {}, null, 'force-cache'],
    [['--cache-min=10'], {}, null, 'default'],
    // A higher layer's setting wins: the command line's over the environment's.
    [['--no-prefer-online'], { npm_config_cache_max: '0' }, null, 'default'],
    [['--cache-max=0'], { npm_config_prefer_online: 'false' }, null, 'no-cache'],
  ];
  for (const [args, env, npmrc, mode] of table) {
    assert.equal(await modeOf(args, env, npmrc), mode, `${args.join(' ')} ${JSON.stringify(env)} ${npmrc ?? ''}`);
  }
});

// ── The packuments read in each mode ───────────────────────────────────────

const NAME = '@fixture/cache-mode';
const REGISTRY = 'https://registry-fixture.invalid';
const START = 1_800_000_000_000;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now = START;
Date.now = () => now;

/** R2 as it stores an object: each put a new version, and a put `onlyIf` another version writes nothing. */
function fakeBucket() {
  const entries = new Map();
  let version = 0;
  let reads = 0;
  return {
    entries,
    get reads() { return reads; },
    async get(key) {
      reads++;
      const entry = entries.get(key);
      return entry ? { text: async () => entry.json, uploaded: entry.uploaded, customMetadata: entry.customMetadata, etag: entry.etag } : null;
    },
    async put(key, body, options) {
      if (options?.onlyIf && entries.get(key)?.etag !== options.onlyIf.etagMatches) return null;
      entries.set(key, { json: String(body), uploaded: new Date(now), customMetadata: options?.customMetadata, etag: `r2-${++version}` });
      return {};
    },
    async delete() { throw new Error('no eviction here'); },
  };
}

/** The registry, answering on its ETag as registry.npmjs.org does. */
function fakeRegistry() {
  const versions = {};
  let latest;
  let revision = 0;
  const requests = [];
  const json = () => JSON.stringify({ name: NAME, 'dist-tags': { latest }, versions });
  const publish = (version) => {
    latest = version;
    revision++;
    versions[version] = { name: NAME, version, dependencies: {}, dist: { tarball: `${REGISTRY}/fixture-${version}.tgz`, integrity: 'sha512-AAAA' } };
  };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, packumentUrl(NAME, REGISTRY), 'no real network I/O is allowed');
    requests.push({ ifNoneMatch: request.headers.get('if-none-match'), cacheControl: request.headers.get('cache-control') });
    const headers = { ETag: `"fixture-${revision}"`, 'Cache-Control': 'public, max-age=300' };
    if (request.headers.get('if-none-match') === headers.ETag) return new Response(null, { status: 304, headers });
    return new Response(json(), { status: 200, headers });
  };
  publish('1.0.0');
  return { publish, requests };
}

/** A session reading packuments through one bucket and the colo cache in place; `resolve(range, cache, cachedEntries)` resolves NAME. */
function session(bucket) {
  return (range, cache, cachedEntries = []) => resolveOnePackumentInFacet(
    { name: NAME, range, cachedEntries, fetchTimeoutMs: 1_000, retries: 0, registry: REGISTRY, ...(cache === undefined ? {} : { cache }) },
    { SUPERVISOR: { async getPackument(name, options) {
      const client = new R2CacheClient(null, bucket);
      return { ...await client.readThroughPackument(name, options), events: client._cacheEvents };
    } } },
  );
}

const run = (what, body) => check(what, async () => {
  now = START;
  try {
    await withColoCache((colo) => body(colo));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await run('--prefer-online asks the registry again on its ETag however fresh the copy, and a 304 keeps it', async () => {
  const registry = fakeRegistry();
  const resolve = session(fakeBucket());
  assert.equal((await resolve('^1.0.0')).pkg?.version, '1.0.0');
  now = START + 1_000;
  const again = await resolve('^1.0.0', 'no-cache');
  assert.equal(again.pkg?.version, '1.0.0');
  assert.equal(registry.requests.length, 2, 'a fresh copy was not asked of the registry again');
  assert.deepEqual(registry.requests[1], { ifNoneMatch: '"fixture-1"', cacheControl: null }, 'conditional on its ETag, as npm asks');
  registry.publish('1.0.1');
  assert.equal((await resolve('^1.0.0', 'no-cache')).pkg?.version, '1.0.1', 'the version published since');
  assert.equal((await resolve('^1.0.0')).pkg?.version, '1.0.1', 'and the cache holds it after');
  assert.equal(registry.requests.length, 3);
});

await run('--prefer-online reads the packument where an exact version\'s session record would answer', async () => {
  const registry = fakeRegistry();
  const resolve = session(fakeBucket());
  const record = registryRecord({ name: NAME, version: '1.0.0', registryName: NAME, tarballUrl: `${REGISTRY}/fixture-1.0.0.tgz`, integrity: 'sha512-AAAA', dependencies: {}, main: '', module: '', bin: {} }, 1);
  assert.equal((await resolve('1.0.0', 'default', [record])).pkg?.version, '1.0.0');
  assert.equal(registry.requests.length, 0, 'the record answers in the default mode');
  assert.equal((await resolve('1.0.0', 'no-cache', [record])).pkg?.version, '1.0.0');
  assert.equal(registry.requests.length, 1, 'the record answered in place of the registry');
});

await run('--prefer-offline answers a stale copy without the network, and fetches a missing one', async (colo) => {
  const registry = fakeRegistry();
  const resolve = session(fakeBucket());
  assert.equal((await resolve('^1.0.0')).pkg?.version, '1.0.0');
  registry.publish('1.0.1');
  now = START + PACKUMENT_TTL_MS + 1_000;
  assert.equal((await resolve('^1.0.0', 'force-cache')).pkg?.version, '1.0.0', 'the stale copy answers');
  assert.equal((await resolve('1.0.1', 'force-cache')).error?.type, 'unresolved', 'and is not asked again where it lacks the version');
  assert.equal(registry.requests.length, 1, 'the network was asked');
  // Another session, in another colo: no copy anywhere.
  colo.entries.clear();
  const missing = session(fakeBucket());
  assert.equal((await missing('^1.0.0', 'force-cache')).pkg?.version, '1.0.1', 'a package with no copy is fetched');
  assert.equal(registry.requests.length, 2);
});

await run('--offline answers a stale copy, and refuses a missing one as npm does (ENOTCACHED), without the network', async (colo) => {
  const registry = fakeRegistry();
  const resolve = session(fakeBucket());
  assert.equal((await resolve('^1.0.0')).pkg?.version, '1.0.0');
  registry.publish('1.0.1');
  now = START + PACKUMENT_TTL_MS + 1_000;
  assert.equal((await resolve('^1.0.0', 'only-if-cached')).pkg?.version, '1.0.0', 'the stale copy answers');
  assert.equal((await resolve('1.0.1', 'only-if-cached')).error?.type, 'unresolved', 'and is not asked again where it lacks the version');
  colo.entries.clear();
  const missing = await session(fakeBucket())('^1.0.0', 'only-if-cached');
  assert.equal(missing.pkg, null);
  assert.match(missing.error?.reason ?? '', new RegExp(`request to ${packumentUrl(NAME, REGISTRY).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed: cache mode is 'only-if-cached' but no cached response is available\\.`));
  assert.equal(registry.requests.length, 1, 'the network was asked');
});

await run('a stale colo copy reads R2 before the registry: a copy another colo renewed answers', async (colo) => {
  const registry = fakeRegistry();
  const bucket = fakeBucket();
  const resolve = session(bucket);
  assert.equal((await resolve('^1.0.0')).pkg?.version, '1.0.0');
  // Another colo renewed R2's copy; this colo's is past its TTL.
  now = START + PACKUMENT_TTL_MS + 1_000;
  const key = packumentKey(NAME, REGISTRY);
  const stored = bucket.entries.get(key);
  stored.customMetadata = { ...stored.customMetadata, expiresAt: String(now + PACKUMENT_TTL_MS) };
  const readsBefore = bucket.reads;
  assert.equal((await resolve('^1.0.0')).pkg?.version, '1.0.0');
  assert.equal(registry.requests.length, 1, 'the registry was asked although R2 held a fresh copy');
  assert.equal(bucket.reads, readsBefore + 1, 'R2 was read');
  assert.equal(Number(colo.entries.get(packumentL2Url(NAME, REGISTRY))?.headers['x-nimbus-expiresat']), now + PACKUMENT_TTL_MS, 'the colo holds R2\'s renewed copy');
});

await run('a stale colo copy over a stale R2 copy is asked of the registry on R2\'s ETag, and a 304 renews R2', async () => {
  const registry = fakeRegistry();
  const bucket = fakeBucket();
  const resolve = session(bucket);
  assert.equal((await resolve('^1.0.0')).pkg?.version, '1.0.0');
  now = START + PACKUMENT_TTL_MS + 1_000;
  assert.equal((await resolve('^1.0.0')).pkg?.version, '1.0.0');
  assert.deepEqual(registry.requests.slice(1), [{ ifNoneMatch: '"fixture-1"', cacheControl: null }]);
  assert.equal(Number(bucket.entries.get(packumentKey(NAME, REGISTRY)).customMetadata.expiresAt), now + PACKUMENT_TTL_MS, 'R2 renewed by the 304');
});

// ── The tarballs read in each mode ─────────────────────────────────────────

const TARBALL = packageTarball({ 'package/package.json': '{"name":"left-pad","version":"1.3.0"}', 'package/index.js': 'export default 1;' });
const TARBALL_URL = `${REGISTRY}/left-pad-1.3.0.tgz`;
const PACKAGE = { name: 'left-pad', version: '1.3.0', tarballUrl: TARBALL_URL, integrity: await sriOf(TARBALL), pkgDir: 'node_modules/left-pad', installRoot: 'node_modules', mtime: 1, chunkSize: 65_536 };

/** One package installed in `cache` mode, the cache holding `cached` (null: not) and answering after `delayMs`; with the registry requests it made. */
async function installTarball(cache, cached, delayMs = 0) {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(TARBALL.slice(), { status: 200, headers: { 'content-length': String(TARBALL.length) } });
  };
  const supervisor = {
    async writeBatchStream(stream) {
      await new Response(stream).arrayBuffer();
      return { ok: true, committedGroupSequence: 0, committedPathCount: 0, inodes: 0, chunks: 0 };
    },
    async getCachedTarball() {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { bytes: cached, events: [] };
    },
    async putCachedTarball() { return true; },
  };
  try {
    const result = await installPackagesInFacet({ packages: [PACKAGE], concurrency: 1, ...(cache === undefined ? {} : { cache }) }, { SUPERVISOR: supervisor });
    return { failed: result.perPackage[0].errorText, requests };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await check('--offline installs a tarball the cache has, and refuses one it does not as npm does (ENOTCACHED), without the network', async () => {
  const hit = await installTarball('only-if-cached', TARBALL);
  assert.equal(hit.failed, undefined);
  assert.equal(hit.requests, 0);
  const miss = await installTarball('only-if-cached', null);
  assert.equal(miss.failed, `request to ${TARBALL_URL} failed: cache mode is 'only-if-cached' but no cached response is available.`);
  assert.equal(miss.requests, 0, 'the registry was asked for a tarball');
  // A cache slow to answer: no download is started in its place.
  const slow = await installTarball('only-if-cached', null, 200);
  assert.equal(slow.failed, miss.failed);
  assert.equal(slow.requests, 0, 'a download was started while the cache was asked');
  // Every other mode fetches what the cache does not have.
  for (const mode of [undefined, 'force-cache', 'no-cache']) assert.deepEqual(await installTarball(mode, null), { failed: undefined, requests: 1 }, String(mode));
});

Date.now = originalNow;
globalThis.fetch = originalFetch;
assert.deepEqual(failures, []);
console.log('npm-cache-mode: ok');
