#!/usr/bin/env bun
// The session's persistent build caches follow the code that built them
// (npm/cache-keys.ts). pkg_esm_bundles and user_module_transforms outlive an
// isolate and a deploy; when they were keyed on BUNDLER_VERSION alone, core
// 0.15.1 changed the transform's output (an unused `import React` dropped)
// and warm sessions kept serving 0.15.0's. Here: each key changes with each
// engine identity it stands for; those identities carry the engines' builds;
// and the Vite dev server neither serves a transform nor a pre-bundle that
// another engine made, while it does serve its own.

import assert from 'node:assert/strict';
import { BUNDLER_VERSION, EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { canonicalJson, prebundleCacheKey, prebundleRequest, serviceBuildCacheKey, userModuleTransformCacheKey } from '../../packages/worker/src/npm/cache-keys.ts';
import { NpmCache } from '../../packages/worker/src/npm/cache.ts';
import { BUILD_FACET_WORKER_ID } from '../../packages/worker/src/facets/build-facet.ts';
import { OXC_FACET_WORKER_ID } from '../../packages/worker/src/facets/oxc-transform.ts';
import { ESBUILD_FACET_WORKER_ID, TRANSFORM_HOST_ID, supervisorEsbuildService } from '../../packages/worker/src/facets/esbuild-transform.ts';
import { OXC_WASM_BUILD_ID } from '../../packages/worker/src/oxc-wasm-artifact.generated.ts';
import { OXC_FACET_BUILD_ID } from '../../packages/worker/src/oxc-facet-artifact.generated.ts';
import { ROLLDOWN_FACET_BUILD_ID } from '../../packages/worker/src/rolldown-facet-artifact.generated.ts';
import { ViteDevServer } from '../../packages/worker/src/facets/vite-dev-server.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// ── Each key follows each identity it stands for ────────────────────────
{
  const distinct = async (label, ...keys) => {
    const values = await Promise.all(keys);
    assert.equal(new Set(values).size, values.length, `${label}: ${values.join(' ')}`);
    for (const value of values) assert.ok(value.startsWith(`${BUNDLER_VERSION}:`), `${label}: ${value} names BUNDLER_VERSION`);
  };
  const request = prebundleRequest('pkg', []);
  const transform = { transform: { loader: 'tsx' } };
  await distinct('pre-bundle, by build facet', prebundleCacheKey(request, 'facet-a'), prebundleCacheKey(request, 'facet-b'));
  await distinct('user transform, by transform host',
    userModuleTransformCacheKey('host-a', transform, 'pipe'), userModuleTransformCacheKey('host-b', transform, 'pipe'), userModuleTransformCacheKey(null, transform, 'pipe'));
  await distinct('user transform, by pipeline', userModuleTransformCacheKey('host', transform, 'pipe-a'), userModuleTransformCacheKey('host', transform, 'pipe-b'));
  await distinct('service build, by each',
    serviceBuildCacheKey('host-a', request, 'facet', 'pipe'), serviceBuildCacheKey('host-b', request, 'facet', 'pipe'),
    serviceBuildCacheKey('host-a', request, 'facet-b', 'pipe'), serviceBuildCacheKey('host-a', request, 'facet', 'pipe-b'));
  // Different caches never share a key for the same identity.
  await distinct('across caches', prebundleCacheKey(request, 'x'), userModuleTransformCacheKey('x', request, 'x'), serviceBuildCacheKey('x', request, 'x', 'x'));
  assert.equal(await prebundleCacheKey(request, 'same'), await prebundleCacheKey(request, 'same'), 'a key is a function of its identity');
  assert.equal(await prebundleCacheKey(request), await prebundleCacheKey(request, BUILD_FACET_WORKER_ID), 'pre-bundles are keyed by the build facet\'s identity');
  console.log('  ok  each key changes with each engine identity it stands for');
}

// ── And with each part of the request ────────────────────────────────────
{
  const distinct = async (label, ...keys) => {
    const values = await Promise.all(keys);
    assert.equal(new Set(values).size, values.length, `${label}: ${values.join(' ')}`);
  };
  const request = prebundleRequest('pkg', [['/n/pkg/package.json', '{"version":"1"}']]);
  await distinct('pre-bundle, by each part',
    prebundleCacheKey(request),
    prebundleCacheKey({ ...request, options: { ...request.options, define: { ...request.options.define, X: '1' } } }),
    prebundleCacheKey({ ...request, options: { ...request.options, platform: 'node' } }),
    prebundleCacheKey({ ...request, externals: ['react'] }),
    prebundleCacheKey({ ...request, manifests: [['/n/pkg/package.json', '{"version":"2"}']] }),
    prebundleCacheKey({ ...request, manifests: [['/n/pkg/package.json', null]] }));
  await distinct('user transform, by each part',
    userModuleTransformCacheKey('h', { transform: { define: { A: '1' } }, rewrite: null }),
    userModuleTransformCacheKey('h', { transform: { define: { A: '2' } }, rewrite: null }),
    userModuleTransformCacheKey('h', { transform: { define: { A: '1' } }, rewrite: { base: '/p' } }));
  // A request is its content, not the order its keys were written in.
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { f: 1, e: 2 }], c: 2 } }), '{"a":{"c":2,"d":[1,{"e":2,"f":1}]},"b":1}');
  assert.equal(await userModuleTransformCacheKey('h', { a: 1, b: 2 }), await userModuleTransformCacheKey('h', { b: 2, a: 1 }));
  console.log('  ok  each key changes with each part of the request it stands for');
}

// ── Those identities are the engines' builds ─────────────────────────────
{
  // A rebuilt wasm or facet runtime changes the id, so the key, with no hand-bumped constant.
  assert.ok(OXC_FACET_WORKER_ID.includes(OXC_WASM_BUILD_ID) && OXC_FACET_WORKER_ID.includes(OXC_FACET_BUILD_ID), OXC_FACET_WORKER_ID);
  assert.ok(TRANSFORM_HOST_ID.includes(OXC_FACET_WORKER_ID) && TRANSFORM_HOST_ID.includes(ESBUILD_FACET_WORKER_ID), TRANSFORM_HOST_ID);
  assert.ok(BUILD_FACET_WORKER_ID.includes(ROLLDOWN_FACET_BUILD_ID) && /rolldown-[0-9.]+-[0-9a-f]{16}/.test(BUILD_FACET_WORKER_ID), BUILD_FACET_WORKER_ID);
  // The dev server keys its transforms by its service's host: the session's is the supervisor's.
  assert.equal(supervisorEsbuildService({}, {}, null).transformHostId, TRANSFORM_HOST_ID);
  console.log('  ok  the identities carry the transform and build engines\' builds');
}

// ── The Vite dev server serves only what this code made ──────────────────
{
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  const root = 'home/user/app';
  const write = (path, content) => {
    kernel.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
    kernel.writeFile(path, new TextEncoder().encode(content), { mode: 0o644 });
  };
  write(`${root}/package.json`, JSON.stringify({ name: 'app', dependencies: { pkg: '1.0.0' } }));
  write(`${root}/src/App.tsx`, 'export const App = () => <div>app</div>;\n');
  write(`${root}/node_modules/pkg/package.json`, JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.js' }));
  write(`${root}/node_modules/pkg/index.js`, "export default 'built now';\n");

  // A transform engine that says which it is, and counts its calls.
  const calls = new Map();
  const engine = (id) => async (requests) => {
    calls.set(id, (calls.get(id) ?? 0) + requests.length);
    return requests.map(() => ({ code: `export const engine = ${JSON.stringify(id)};\n`, map: '', warnings: [] }));
  };
  const serve = async (id, path) => {
    const esbuild = new EsbuildService(undefined, { transformHost: engine(id), transformHostId: id });
    const server = new ViteDevServer({ vfs, cred: CRED_KERNEL, esbuild, root, sql: harness.sql, onHmrMessage() {}, basePath: '/preview', port: 5173 });
    try {
      const response = await server.handleRequest(new Request(`http://localhost/preview${path}`), path);
      return { status: response.status, body: await response.text() };
    } finally {
      server.stop?.();
    }
  };

  const first = await serve('engine-a', '/src/App.tsx');
  assert.match(first.body, /"engine-a"/, first.body);
  // The same engine in a new server (a new isolate): served from the row, not transformed again.
  const again = await serve('engine-a', '/src/App.tsx');
  assert.match(again.body, /"engine-a"/, again.body);
  assert.equal(calls.get('engine-a'), 1, 'engine-a\'s own row is served without transforming again');
  // Another build of the transform engine: the row engine-a left is not its.
  const other = await serve('engine-b', '/src/App.tsx');
  assert.match(other.body, /"engine-b"/, `a transform another engine made is not served: ${other.body}`);
  assert.equal(calls.get('engine-b'), 1);
  // A row as 0.15.1 and before wrote it, keyed on BUNDLER_VERSION alone: not served.
  harness.sql.exec('UPDATE user_module_transforms SET bundler_version = ?, code = ?', BUNDLER_VERSION, 'export const engine = "0.15.1";\n');
  const upgraded = await serve('engine-b', '/src/App.tsx');
  assert.match(upgraded.body, /"engine-b"/, `a row keyed on BUNDLER_VERSION alone is not served: ${upgraded.body}`);
  console.log('  ok  the dev server serves no user-module transform another engine made, and its own from the cache');

  // A pre-bundle another build facet made is not served; one this one made is.
  const cache = new NpmCache(harness.sql);
  const seed = async (bundleHash) => cache.putEsmBundle({
    specifier: 'pkg', bundleHash, esmCode: "export default 'from the cache';", builtAt: Date.now(), inputHash: '',
    sources,
  });
  // The request this server makes for pkg, from what it was built from.
  const sources = [`/${root}/node_modules/pkg/index.js`];
  const request = prebundleRequest('pkg', [[`/${root}/node_modules/pkg/package.json`, kernel.readFileString(`${root}/node_modules/pkg/package.json`)]]);
  for (const key of [await prebundleCacheKey(request, 'another-build-facet'), BUNDLER_VERSION]) {
    // Another build facet's, and one as 0.15.1 and before wrote it (BUNDLER_VERSION alone).
    await seed(key);
    const stale = await serve('engine-a', '/@modules/pkg');
    assert.equal(stale.body.includes('from the cache'), false, `a pre-bundle keyed ${key} is not served (status ${stale.status})`);
  }
  await seed(await prebundleCacheKey(request));
  const own = await serve('engine-a', '/@modules/pkg');
  assert.equal(own.status, 200, own.body);
  assert.ok(own.body.includes('from the cache'), `this build facet's own pre-bundle is served: ${own.body.slice(0, 200)}`);
  console.log('  ok  the dev server serves no pre-bundle another build facet made, and its own');
}

console.log('build-cache-keys OK');
