#!/usr/bin/env bun
// A helper facet's compute call is bounded by its kind's deadline; its
// process route is not.
//
// RoughWallaby on 90bbde57e: facetCallDeadlineMs was read only by
// IsolatePool and Oxc's stack fallback. The build facet's builds and
// pre-bundles, the esbuild facet's transforms and builds, and Oxc's own
// transformMany awaited their facet with no timer, so a plugin or VFS answer
// that never came held them past the 300 s compute deadline, without the CPU
// limit ever firing. The esbuild CLI runs a process, which has none.
//
// Time is what this test moves: every timer of 10 s or more fires at once.

import assert from 'node:assert/strict';
import { loadHelperFacet } from '../../packages/worker/src/facets/helper-facet.ts';
import { facetCallDeadlineMs } from '../../packages/fabric/src/facet-limits.ts';

const never = () => new Promise(() => {});
const ctx = {
  id: { toString: () => 'helper-deadline-do' },
  facets: { get: () => ({ transformMany: never, build: never, cli: never }), abort() {} },
};
const env = {
  LOADER: { get: () => ({ getDurableObjectClass: () => class {} }) },
  ASSETS: { fetch: async () => new Response('') },
};
const spec = { kind: 'esbuild', id: 'esbuild-facet', className: 'EsbuildFacet', what: 'the esbuild facet', processMethods: ['cli'], code: async () => ({}) };

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, typeof ms === 'number' && ms >= 10_000 ? 0 : ms, ...args);
try {
  const facet = await loadHelperFacet(ctx, env, spec);
  const ms = facetCallDeadlineMs('esbuild');
  // Settled within 2 s of real time, or 'pending': an unbounded call fails here instead of hanging the file.
  const settle = (call) => Promise.race([call.then(() => 'answered', (e) => e.message), new Promise((r) => realSetTimeout(() => r('pending'), 2000))]);
  assert.match(await settle(facet.transformMany([])), new RegExp(`the esbuild facet's transformMany gave no answer within ${ms} ms`));
  assert.match(await settle(facet.build({})), new RegExp(`the esbuild facet's build gave no answer within ${ms} ms`));
  assert.equal(await settle(facet.cli({})), 'pending', 'the CLI is a process: no wall deadline');
} finally {
  globalThis.setTimeout = realSetTimeout;
}
console.log('helper-facet-call-deadline: ok');
