#!/usr/bin/env bun
// The esbuild facet answers what ran the transform facet out of stack
// (facets/oxc-transform.ts's stackFallback): its transformMany runs the same
// runTransformRequest as the transform facet, with the transform facet's
// staged runtime (the dynamic-import rewrite and the top-level-await
// lowering), on a fresh esbuild per batch that is stopped after it.
//
// The facet is the module production loads (esbuildFacetWorkerCode over the
// staged assets), evaluated here (lib/esbuild-facet-harness.mjs).

import assert from 'node:assert/strict';
import { esbuilds, freshFacetClass, releaseFacetHarness, resetEsbuilds } from './lib/esbuild-facet-harness.mjs';

resetEsbuilds();
const EsbuildFacet = await freshFacetClass();
const facet = new EsbuildFacet({}, {});
// Arrays 5,000 deep: past Oxc's passes on V8's stack (585); esbuild's wasm grows to 76 MiB for it.
// An ES module as a session sends it is lowered by async-module-lowering.ts,
// whose parse runs out of stack here too: esbuild's CommonJS takes it.
const [deep, tla, deepModule] = structuredClone(await facet.transformMany(structuredClone([
  { code: `export const x = ${'['.repeat(5000)}"bottom"${']'.repeat(5000)};`, options: { loader: 'js', format: 'cjs', target: 'esnext' } },
  { code: 'export let db; db = await Promise.resolve(7);', options: { loader: 'js', format: 'cjs', target: 'esnext' } },
  { code: `export const y = ${'['.repeat(5000)}"deep"${']'.repeat(5000)};`, options: { esModule: 'node', dynamicImportParent: 'file:///deep.mjs', moduleMetadata: true } },
])));
assert.equal(deepModule.error, undefined, deepModule.error);
assert.match(deepModule.code, /"deep"/);
assert.equal(deep.error, undefined, deep.error);
assert.match(deep.code, /"bottom"/);
assert.equal(tla.error, undefined, tla.error);
assert.match(tla.code, /return \(async \(\) => \{/, 'top-level await is lowered by the staged runtime');
assert.equal(esbuilds.initializations, 1, 'one esbuild for the batch');
assert.equal(esbuilds.stops, 1, 'stopped after it');
console.log('  ok  transformMany answers a module too deep for Oxc, and lowers top-level await, on one esbuild it stops');
releaseFacetHarness();
console.log('esbuild-facet-stack-fallback OK');
