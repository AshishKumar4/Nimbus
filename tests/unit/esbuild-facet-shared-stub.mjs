#!/usr/bin/env bun
// A Durable Object's builds and `esbuild` commands share one esbuild facet stub
// (facets/esbuild-transform.ts): callers that overlap wait on one facet load,
// and a stub that failed is dropped so the next call gets a working one.
// Transforms run in the transform facet (oxc-facet-shared-stub.mjs).
//
// The facet is the module production loads (esbuildFacetWorkerCode over the
// staged assets), evaluated here (lib/esbuild-facet-harness.mjs).

import assert from 'node:assert/strict';
import { esbuildBuildHost } from '../../packages/worker/src/facets/esbuild-transform.ts';
import { durableObject, freshFacetClass, releaseFacetHarness, resetEsbuilds } from './lib/esbuild-facet-harness.mjs';

// ── A stub that threw is dropped: the next caller mints a fresh one ─────────
{
  resetEsbuilds();
  // A build drops the stub it failed on; the next call gets a sound one.
  {
    const { ctx, env, counts } = durableObject(await freshFacetClass(), { brokenStubs: 1 });
    await assert.rejects(esbuildBuildHost(ctx, env)({}, {}), /stub 1 disconnected/);
    assert.deepEqual(await esbuildBuildHost(ctx, env)({}, {}), { built: true });
    assert.equal(counts.stubs, 2);
  }
  // Builds that overlap wait on one facet load: one LOADER.get, one stub.
  {
    const { ctx, env, counts } = durableObject(await freshFacetClass());
    const [first, second] = await Promise.all([esbuildBuildHost(ctx, env)({}, {}), esbuildBuildHost(ctx, env)({}, {})]);
    assert.deepEqual([first, second], [{ built: true }, { built: true }]);
    assert.equal(counts.loaderGets, 1);
    assert.equal(counts.stubs, 1);
  }
  console.log('  ok  builds share one stub and drop it when it fails');
}

releaseFacetHarness();
console.log('esbuild-facet-shared-stub OK');
