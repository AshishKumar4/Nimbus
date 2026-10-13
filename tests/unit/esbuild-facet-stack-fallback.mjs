#!/usr/bin/env bun
// The esbuild facet answers what ran the transform facet out of stack
// (facets/oxc-transform.ts's stackFallback): its transformMany runs the same
// runTransformRequest as the transform facet, with the transform facet's
// staged runtime (the dynamic-import rewrite and native ES-module import
// sites), on a fresh esbuild per batch that is stopped after it.
//
// The facet is the module production loads (esbuildFacetWorkerCode over the
// staged assets), evaluated here (lib/esbuild-facet-harness.mjs).

import assert from 'node:assert/strict';
import { esbuilds, freshFacetClass, releaseFacetHarness, resetEsbuilds } from './lib/esbuild-facet-harness.mjs';

resetEsbuilds();
const EsbuildFacet = await freshFacetClass();
const facet = new EsbuildFacet({}, {});
// Arrays 5,000 deep: past Oxc's passes on V8's stack (585); esbuild's wasm grows to 76 MiB for it.
// An ES module as a session sends it stays as written and needs no engine.
const nativeSource = `export const y = ${'['.repeat(5000)}"deep"${']'.repeat(5000)};`;
const [deep, tla, deepModule] = structuredClone(await facet.transformMany(structuredClone([
  { code: `export const x = ${'['.repeat(5000)}"bottom"${']'.repeat(5000)};`, options: { loader: 'js', format: 'cjs', target: 'esnext' } },
  { code: 'export let db; db = await Promise.resolve(7);', options: { loader: 'js', format: 'cjs', target: 'esnext' } },
  { code: nativeSource, options: { esModule: 'node', dynamicImportParent: 'file:///deep.mjs' } },
])));
assert.equal(deepModule.error, undefined, deepModule.error);
assert.equal(deepModule.code, nativeSource);
assert.equal(deepModule.esModule, 'node');
assert.equal(JSON.parse(deepModule.map).moduleSyntax, true);
assert.equal(deep.error, undefined, deep.error);
assert.match(deep.code, /"bottom"/);
assert.match(tla.error, /Top-level await is currently not supported with the "cjs" output format/,
  'the facet preserves esbuild\'s CJS top-level-await rejection');
assert.equal(esbuilds.initializations, 1, 'one esbuild for the batch');
assert.equal(esbuilds.stops, 1, 'stopped after it');
console.log('  ok  transformMany answers a module too deep for Oxc, stages native ESM, and preserves the CJS TLA rejection on one esbuild it stops');
releaseFacetHarness();
console.log('esbuild-facet-stack-fallback OK');
