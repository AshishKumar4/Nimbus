#!/usr/bin/env bun
/**
 * The prefetch cache must not retain a bundle and its serialization at once.
 *
 * `_buildProcessBundle` serializes the bundle and then keeps the entry across
 * launches. It used to keep the raw forms too, so every
 * cached entry cost twice what it needed to for its whole lifetime. Measured for
 * pi at 502af77, per entry: raw 17,253,610 + source 18,262,324 + manifest
 * 600,060 + metadata 3,841,244 = 39,957,238 B — and the only thing anything
 * downstream still wanted the raw cells for was one boolean, `usesNodeSqlite`.
 *
 * That mattered because the supervisor DO builds all of it synchronously on its
 * own event loop inside a 128 MiB isolate. `81f3047` measured the DO resetting
 * three times under prefetch-bundle construction.
 *
 * The safety property is the second half and is the one worth guarding: states
 * that were never serialized must come through untouched. `_stageOpencodeFacet`
 * builds its own uncached state and genuinely re-reads the raw cells
 * (`assertStagedBundleFitsRpcPayload`), so releasing its would break it.
 */

import assert from 'node:assert/strict';
import { releaseSerializedSources } from '../../packages/worker/src/facets/manager.ts';

const bundle = () => ({
  '/home/user/p/index.js': 'require("./a");',
  '/home/user/p/a.js': 'module.exports = 1;',
});
// ── A serialized state releases its raw cells ───────────────────────────
{
  const state = {
    bundle: bundle(),
    reachableCount: 2,
    truncated: false,
    bundleSource: { expression: '{"/home/user/p/index.js":"..."}', imports: '', modules: {} },
    usesNodeSqlite: false,
  };
  const source = state.bundleSource;

  releaseSerializedSources(state);

  assert.deepEqual(state.bundle, {}, 'raw cells must be released once serialized');
  // What the facet is actually built from is untouched: this is why the
  // release is invisible to every consumer.
  assert.equal(state.bundleSource, source);
  assert.equal(state.usesNodeSqlite, false, 'the memoized answer must survive the release');
}

// ── The memoized node:sqlite answer survives, both ways ─────────────────
for (const usesNodeSqlite of [true, false]) {
  const state = {
    bundle: bundle(),
    reachableCount: 2, truncated: false,
    bundleSource: { expression: '{}', imports: '', modules: {} },
    usesNodeSqlite,
  };
  releaseSerializedSources(state);
  assert.equal(state.usesNodeSqlite, usesNodeSqlite, 'the memoized node:sqlite answer survives the release');
}

// ── An UNSERIALIZED state is untouched ──────────────────────────────────
// spawnNode / _stageOpencodeFacet states reach _serializeBundleForFacet and
// assertStagedBundleFitsRpcPayload with the raw cells still needed.
{
  const state = { bundle: bundle(), reachableCount: 2, truncated: false };
  releaseSerializedSources(state);
  assert.deepEqual(state.bundle, bundle(), 'unserialized cells must be kept');
}

console.log('PASS facet-prefetch-cache-retention');
