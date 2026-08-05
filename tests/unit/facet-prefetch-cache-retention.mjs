#!/usr/bin/env bun
/**
 * The prefetch cache must not retain a bundle and its serialization at once.
 *
 * `_buildPrefetchBundleCached` serializes the bundle, manifest and metadata and
 * then keeps the entry across execs. It used to keep the raw forms too, so every
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
 * that were never serialized must come through untouched. `spawnNode` and
 * `_stageOpencodeFacet` build their own uncached states and genuinely re-read
 * the raw cells (`_serializeBundleForFacet`,
 * `assertStagedBundleFitsRpcPayload`), so releasing theirs would break them.
 */

import assert from 'node:assert/strict';
import { releaseSerializedSources } from '../../packages/worker/src/facets/manager.ts';

const bundle = () => ({
  '/home/user/p/index.js': 'require("./a");',
  '/home/user/p/a.js': 'module.exports = 1;',
});
const manifest = () => ({ '/home/user/p': ['index.js', 'a.js'] });
const metadata = () => ({ '/home/user/p/index.js': { mode: 0o644, uid: 1000, gid: 1000 } });

// ── A fully serialized state releases its raw halves ────────────────────
{
  const state = {
    bundle: bundle(),
    manifest: manifest(),
    metadata: metadata(),
    reachableCount: 2,
    truncated: false,
    bundleSource: { expression: '{"/home/user/p/index.js":"..."}', imports: '', modules: {} },
    serializedManifest: JSON.stringify(manifest()),
    serializedMetadata: JSON.stringify(metadata()),
    usesNodeSqlite: false,
  };
  const source = state.bundleSource;
  const serializedManifest = state.serializedManifest;
  const serializedMetadata = state.serializedMetadata;

  releaseSerializedSources(state);

  assert.deepEqual(state.bundle, {}, 'raw cells must be released once serialized');
  assert.deepEqual(state.manifest, {}, 'raw manifest must be released once serialized');
  assert.deepEqual(state.metadata, {}, 'raw metadata must be released once serialized');

  // What the facet is actually built from is untouched — this is why the
  // release is invisible to every consumer.
  assert.equal(state.bundleSource, source);
  assert.equal(state.serializedManifest, serializedManifest);
  assert.equal(state.serializedMetadata, serializedMetadata);
  assert.equal(state.usesNodeSqlite, false, 'the memoized answer must survive the release');
}

// ── The memoized node:sqlite answer survives, both ways ─────────────────
for (const usesNodeSqlite of [true, false]) {
  const state = {
    bundle: bundle(), manifest: manifest(), metadata: metadata(),
    reachableCount: 2, truncated: false,
    bundleSource: { expression: '{}', imports: '', modules: {} },
    serializedManifest: '{}', serializedMetadata: '{}',
    usesNodeSqlite,
  };
  releaseSerializedSources(state);
  // _execViaLoader reads this instead of re-scanning the cells. If the release
  // lost it, the fallback would rescan an empty bundle and answer `false` —
  // silently dropping the sqlite.wasm module map entry for a program that
  // imports node:sqlite.
  assert.equal(state.usesNodeSqlite, usesNodeSqlite);
}

// ── An UNSERIALIZED state is untouched ──────────────────────────────────
// spawnNode / _stageOpencodeFacet states reach _serializeBundleForFacet and
// assertStagedBundleFitsRpcPayload with the raw cells still needed.
{
  const state = {
    bundle: bundle(),
    manifest: manifest(),
    metadata: metadata(),
    reachableCount: 2,
    truncated: false,
  };
  releaseSerializedSources(state);
  assert.deepEqual(state.bundle, bundle(), 'unserialized cells must be kept');
  assert.deepEqual(state.manifest, manifest(), 'unserialized manifest must be kept');
  assert.deepEqual(state.metadata, metadata(), 'unserialized metadata must be kept');
}

// ── Each half is released independently ─────────────────────────────────
// buildFacetVfsBundleSource can be present without the manifest having been
// stringified yet; releasing on the strength of the wrong field would discard
// something still needed.
{
  const state = {
    bundle: bundle(),
    manifest: manifest(),
    metadata: metadata(),
    reachableCount: 2,
    truncated: false,
    bundleSource: { expression: '{}', imports: '', modules: {} },
  };
  releaseSerializedSources(state);
  assert.deepEqual(state.bundle, {}, 'the serialized half is released');
  assert.deepEqual(state.manifest, manifest(), 'the unserialized half is kept');
  assert.deepEqual(state.metadata, metadata(), 'the unserialized half is kept');
}

console.log('PASS facet-prefetch-cache-retention');
