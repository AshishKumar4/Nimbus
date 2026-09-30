#!/usr/bin/env bun
// A Durable Object's transforms, builds and `esbuild` commands share one
// esbuild facet stub (facets/esbuild-transform.ts): callers that overlap wait
// on one facet load, transforms share one esbuild until a call leaves its wasm
// memory past the high-water mark (a fresh esbuild per call left every stopped
// instance's memory waiting on a garbage collection, and calls that overlapped
// or followed closely exceeded the facet's memory limit), and a stub or an
// initialization that failed is dropped so the next call gets a working one.
//
// The facet is the module production loads (esbuildFacetWorkerCode over the
// staged assets), evaluated here (lib/esbuild-facet-harness.mjs); its
// esbuild's initialize() and stop() are counted.

import assert from 'node:assert/strict';
import {
  esbuildBuildHost,
  esbuildTransformHost,
} from '../../packages/worker/src/facets/esbuild-transform.ts';
import {
  durableObject,
  esbuilds,
  freshFacetClass,
  releaseFacetHarness,
  resetEsbuilds,
} from './lib/esbuild-facet-harness.mjs';

const MiB = 1024 * 1024;
const request = { code: 'const n: number = 1; export default n;', options: { loader: 'ts', format: 'esm' } };

// ── Overlapping transforms share one facet load and one esbuild ─────────────
{
  resetEsbuilds();
  const { ctx, env, counts } = durableObject(await freshFacetClass());
  const [first, second] = await Promise.all([
    esbuildTransformHost(ctx, env)([request]),
    esbuildTransformHost(ctx, env)([request]),
  ]);
  for (const [outcome] of [first, second]) {
    assert.equal(outcome.error, undefined, outcome.error);
    assert.match(outcome.code, /const n = 1;/);
  }
  assert.equal(esbuilds.initializations, 1, 'two overlapping calls share one esbuild');
  assert.equal(esbuilds.stops, 0, 'which is kept for the calls after them');
  assert.equal(counts.loaderGets, 1, 'the facet worker is loaded once');
  assert.equal(counts.facetInstances, 1, 'one facet');
  const [rewriteOnly] = await esbuildTransformHost(ctx, env)([{ code: 'module.exports = 1;', options: { rewriteOnly: true, dynamicImportParent: 'file:///a.js' } }]);
  assert.equal(rewriteOnly.code, 'module.exports = 1;');
  assert.equal(esbuilds.initializations, 1, 'a call of rewrites alone starts no esbuild');
  console.log('  ok  overlapping transforms share one facet load and one esbuild');
}

// ── A module that takes the esbuild past the high-water mark retires it ─────
{
  resetEsbuilds();
  const { ctx, env } = durableObject(await freshFacetClass());
  const host = esbuildTransformHost(ctx, env);
  // 319 KiB of ordinary declarations: esbuild's wasm memory reaches ~76 MiB
  // transforming it, where a launch's small slices leave it at 52 or less.
  const large = Array.from({ length: 3000 }, (_, i) => `export function f${i}(a, b) { const t = { x: a, y: b, z: [${i}, a + b] }; return t.x * ${i} + t.y + t.z[1]; }`).join('\n');
  const [before] = await host([request]);
  assert.equal(before.error, undefined, before.error);
  assert.equal(esbuilds.stops, 0, 'a small module leaves the esbuild in service');
  const [transformed] = await host([{ code: large, options: { loader: 'js', format: 'esm' } }]);
  assert.equal(transformed.error, undefined, transformed.error);
  assert.match(transformed.code, /function f2999\(/);
  assert.ok(esbuilds.memoryBytes[0]() > 64 * MiB, `the module took the esbuild to ${esbuilds.memoryBytes[0]() / MiB} MiB, past the mark`);
  assert.equal(esbuilds.stops, 1, 'so it was retired, and stopped as its call ended');
  const [after] = await host([request]);
  assert.equal(after.error, undefined, after.error);
  assert.equal(esbuilds.initializations, 2, 'the next call started a fresh esbuild');
  assert.ok(esbuilds.memoryBytes[1]() < 64 * MiB, 'which is the one kept');
  await host([request]);
  assert.equal(esbuilds.initializations, 2, 'and kept');
  console.log('  ok  a module that takes esbuild past the high-water mark retires it');
}

// ── A failed initialization is not kept: the next transform initializes afresh ─
{
  resetEsbuilds();
  let attempts = 0;
  esbuilds.beforeInitialize = () => {
    if (attempts++ === 0) throw new Error('wasm instantiation failed');
  };
  const { ctx, env } = durableObject(await freshFacetClass());
  const [recovered] = await esbuildTransformHost(ctx, env)([request]);
  assert.match(recovered.code ?? '', /const n = 1;/, 'the host retry recovered within the same call');
  assert.equal(esbuilds.initializations, 2, 'the retry initialized esbuild again rather than reusing the rejection');
  console.log('  ok  a failed esbuild initialization is retried, not kept');
}

// ── A stub that threw is dropped: the next caller mints a fresh one ─────────
{
  resetEsbuilds();
  // The transform host's retry must not reuse the shared stub that failed.
  {
    const { ctx, env, counts } = durableObject(await freshFacetClass(), { brokenStubs: 1 });
    const [outcome] = await esbuildTransformHost(ctx, env)([request]);
    assert.equal(outcome.error, undefined, outcome.error);
    assert.match(outcome.code, /const n = 1;/);
    assert.equal(counts.stubs, 2, 'the retry minted a second stub');
  }
  // A build drops the stub it failed on; the next call gets a sound one.
  {
    const { ctx, env, counts } = durableObject(await freshFacetClass(), { brokenStubs: 1 });
    await assert.rejects(esbuildBuildHost(ctx, env)({}, {}), /stub 1 disconnected/);
    assert.deepEqual(await esbuildBuildHost(ctx, env)({}, {}), { built: true });
    assert.equal(counts.stubs, 2);
  }
  // A build during a transform's facet load waits on it: one LOADER.get, one stub.
  {
    const { ctx, env, counts } = durableObject(await freshFacetClass());
    const transform = esbuildTransformHost(ctx, env)([request]);
    assert.deepEqual(await esbuildBuildHost(ctx, env)({}, {}), { built: true });
    await transform;
    assert.equal(counts.loaderGets, 1);
    assert.equal(counts.stubs, 1);
  }
  console.log('  ok  transforms and builds share one stub and drop it when it fails');
}

releaseFacetHarness();
console.log('esbuild-facet-shared-stub OK');
