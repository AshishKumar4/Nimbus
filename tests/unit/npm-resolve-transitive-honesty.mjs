#!/usr/bin/env bun
// npm-resolve-transitive-honesty — what the per-package resolver task does
// with a transitive dependency must be visible and correct.
//
// Measured live (2026-09-14, json-server@1.0.0-beta.15): `npm install`
// reported "40/40 packages, Done!" and exit 0 while chokidar and readdirp
// were absent from node_modules, so the bin failed at runtime with
// "Cannot find module 'chokidar'". Per-wave instrumentation of the write
// path showed every wave committed exactly what it was sent; the packages
// were never dispatched because the resolver dropped them:
//
//   1. `chokidar` was on SKIP_PACKAGES ("real-vite intercepts") — but
//      real-vite ships its own chokidar shim in its facet module map and
//      never needs the user's copy to be absent;
//   2. a transitive policy skip returned 'skipped' with no message and no
//      event, unlike every other skip path;
//   3. the cache fast-path picked versions with a prerelease-blind helper,
//      so a second install in the same session resolved the exact pin
//      `json-server@1.0.0-beta.15` to `1.0.0-alpha.1`.
//
// Pinned here through resolveOnePackumentInFacet, the task the resolver
// fan-out runs per package, with the real preamble installed.

import assert from 'node:assert/strict';
import { resolveOnePackumentInFacet } from '../../packages/worker/src/npm/resolve-one-facet.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../packages/worker/src/loaders/npm-resolve-preamble.ts';
import { PACKAGE_ABI_POLICY } from '../../packages/worker/src/facets/wasm-swap-registry.ts';

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

const spec = (overrides = {}) => ({
  cachedEntries: [],
  topLevel: false,
  isOptional: false,
  frameworkAware: false,
  fetchTimeoutMs: 1_000,
  retries: 0,
  ...overrides,
});
const envReturning = (result) => ({ SUPERVISOR: { async getPackument() { return { events: [], ...result }; } } });
const versionEntry = (name, version, dependencies = {}) => ({
  name, version, dependencies,
  dist: { tarball: `https://registry.invalid/${name}-${version}.tgz`, integrity: `sha512-${version}` },
});
const packument = (name, versions, distTags = {}) => JSON.stringify({ name, 'dist-tags': distTags, versions });
const cacheEntry = (name, version) => ({
  name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: `sha512-${version}`,
  depsJson: '{}', peerDepsJson: '{}', exportsJson: 'null', main: 'index.js', moduleField: '', binJson: '{}',
  platformJson: '{}', optionalDepsJson: '{}', fetchedAt: 0,
});

// ── 1. chokidar is a dependency like any other ──────────────────────────────
{
  assert.equal(PACKAGE_ABI_POLICY.skipPackages.includes('chokidar'), false, 'chokidar is not on the skip list');
  const res = await resolveOnePackumentInFacet(
    spec({ name: 'chokidar', range: '^5.0.0' }),
    envReturning({
      json: packument('chokidar', {
        '4.0.3': versionEntry('chokidar', '4.0.3', { readdirp: '^4.0.1' }),
        '5.0.0': versionEntry('chokidar', '5.0.0', { readdirp: '^5.0.0' }),
      }, { latest: '5.0.0' }),
      source: 'network',
    }),
  );
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.pkg?.version, '5.0.0', 'a transitive chokidar resolves');
  assert.deepEqual(res.pkg?.dependencies, { readdirp: '^5.0.0' }, 'and its subtree is walked from it');
  assert.equal(res.packumentSource, 'network');
  console.log('  chokidar resolves transitively, with its subtree');
}

// ── 2. a transitive policy skip is loud ─────────────────────────────────────
//
// The list is empty today; the gate stays, and stays loud, for whatever is
// ever put back on it. Exercised through a preamble built from a policy
// that names typescript.
{
  const skipping = NPM_RESOLVE_PREAMBLE.replace('"skipPackages":[]', '"skipPackages":["typescript"]');
  assert.notEqual(skipping, NPM_RESOLVE_PREAMBLE, 'the preamble carries the policy JSON');
  const { SHOULD_SKIP_PACKAGE } = new Function(`${skipping}\nreturn { SHOULD_SKIP_PACKAGE };`)();
  const restore = globalThis.SHOULD_SKIP_PACKAGE;
  globalThis.SHOULD_SKIP_PACKAGE = SHOULD_SKIP_PACKAGE;
  const res = await resolveOnePackumentInFacet(
    spec({ name: 'typescript', range: '^5.0.0' }),
    envReturning({ json: null, source: 'network', status: 404 }),
  );
  globalThis.SHOULD_SKIP_PACKAGE = restore;
  assert.equal(res.pkg, null);
  assert.equal(res.error, undefined, 'a policy skip is still not a failure');
  assert.equal(res.packumentSource, 'skipped');
  assert.ok(res.messages.some((m) => /\[skip\].*typescript/.test(m)), `the install log names the skip: ${JSON.stringify(res.messages)}`);
  assert.deepEqual(
    res.events.filter((e) => e.type === 'transitive-skip').map((e) => e.from),
    ['typescript'],
    'and a transitive-skip event carries it to the registry telemetry',
  );
  console.log('  a transitive policy skip prints a [skip] line and emits an event');
}

// ── 3. an exact prerelease pin resolves to itself on both paths ────────────
{
  // Cache path: the session cache lists alpha.1 first (publish order).
  const cached = await resolveOnePackumentInFacet(
    spec({
      name: 'json-server', range: '1.0.0-beta.15',
      cachedEntries: [cacheEntry('json-server', '1.0.0-alpha.1'), cacheEntry('json-server', '1.0.0-beta.3'), cacheEntry('json-server', '1.0.0-beta.15')],
    }),
    envReturning({ json: null, source: 'network', status: 500 }),
  );
  assert.equal(cached.error, undefined, JSON.stringify(cached.error));
  assert.equal(cached.pkg?.version, '1.0.0-beta.15', 'the cache fast-path honours the exact prerelease pin');
  assert.equal(cached.packumentSource, 'cache-hit');

  // Network path, and a caret on a prerelease: the highest of that line.
  const network = await resolveOnePackumentInFacet(
    spec({ name: '@polka/url', range: '^1.0.0-next.24' }),
    envReturning({
      json: packument('@polka/url', Object.fromEntries(['1.0.0-next.0', '1.0.0-next.24', '1.0.0-next.29', '1.0.0-next.3']
        .map((v) => [v, versionEntry('@polka/url', v)])), { latest: '1.0.0-next.29' }),
      source: 'network',
    }),
  );
  assert.equal(network.error, undefined, JSON.stringify(network.error));
  assert.equal(network.pkg?.version, '1.0.0-next.29', 'the network path picks the highest satisfying prerelease');
  console.log('  prerelease pins resolve correctly on the cache and network paths');
}

// ── 4. the cache fast-path never reduces a range to its base version ────────
//
// `^3.0.0` used to be stripped to `3.0.0` and answered by a cached 3.0.0
// even with 3.0.1 sitting beside it — the second install in a session
// came back with lower versions than the first (measured: totalist,
// readdirp, mrmime, milliparsec, dot-prop, eta).
{
  const res = await resolveOnePackumentInFacet(
    spec({ name: 'totalist', range: '^3.0.0', cachedEntries: [cacheEntry('totalist', '3.0.1'), cacheEntry('totalist', '3.0.0'), cacheEntry('totalist', '2.0.0')] }),
    envReturning({ json: null, source: 'network', status: 500 }),
  );
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.pkg?.version, '3.0.1', 'the highest cached version satisfying the range wins');
  assert.equal(res.packumentSource, 'cache-hit');
  const exact = await resolveOnePackumentInFacet(
    spec({ name: 'totalist', range: '3.0.0', cachedEntries: [cacheEntry('totalist', '3.0.1'), cacheEntry('totalist', '3.0.0')] }),
    envReturning({ json: null, source: 'network', status: 500 }),
  );
  assert.equal(exact.pkg?.version, '3.0.0', 'a bare exact version still resolves to itself');
  console.log('  the cache fast-path picks the highest cached version satisfying the range');
}

console.log('npm-resolve-transitive-honesty: ok');
