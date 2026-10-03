#!/usr/bin/env bun
// A Durable Object's `esbuild` commands and the transforms too deep for Oxc
// share one esbuild facet stub (facets/esbuild-transform.ts): callers that
// overlap wait on one facet load, and a stub that failed is dropped so the
// next call gets a working one. Builds run in the build facet (build-facet.mjs).
//
// The facet is the module production loads (esbuildFacetWorkerCode over the
// staged assets), evaluated here (lib/esbuild-facet-harness.mjs).

import assert from 'node:assert/strict';
import { esbuildStackFallbackHost } from '../../packages/worker/src/facets/esbuild-transform.ts';
import { durableObject, freshFacetClass, releaseFacetHarness, resetEsbuilds } from './lib/esbuild-facet-harness.mjs';

// ── A stub that threw is dropped: the next caller mints a fresh one ─────────
{
  resetEsbuilds();
  // A call drops the stub it failed on; the next call gets a sound one.
  {
    const { ctx, env, counts } = durableObject(await freshFacetClass(), { brokenStubs: 1 });
    await assert.rejects(esbuildStackFallbackHost(ctx, env)([]), /stub 1 disconnected/);
    assert.deepEqual(await esbuildStackFallbackHost(ctx, env)([]), []);
    assert.equal(counts.stubs, 2);
  }
  // Calls that overlap wait on one facet load: one LOADER.get, one stub.
  {
    const { ctx, env, counts } = durableObject(await freshFacetClass());
    const [first, second] = await Promise.all([esbuildStackFallbackHost(ctx, env)([]), esbuildStackFallbackHost(ctx, env)([])]);
    assert.deepEqual([first, second], [[], []]);
    assert.equal(counts.loaderGets, 1);
    assert.equal(counts.stubs, 1);
  }
  console.log('  ok  calls share one stub and drop it when it fails');
}

releaseFacetHarness();
console.log('esbuild-facet-shared-stub OK');
