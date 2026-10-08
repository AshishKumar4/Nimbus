#!/usr/bin/env bun
// A helper facet's compute call is bounded by its kind's deadline, and one
// that expires is ended, not abandoned; the esbuild command, a process, is
// not bounded at all.
//
// RoughWallaby on 90bbde57e: facetCallDeadlineMs was read only by
// IsolatePool and Oxc's stack fallback, so the build, esbuild and Oxc
// facets' calls had no deadline. On 7bb4c322b: a deadline that only stops
// waiting leaves the facet's work running (a late plugin answer resumes it,
// and the same facet id can be loaded again beside it), and its plain Error
// was retried by the pre-bundler and by Oxc's second slice attempt, costing
// another deadline against the same actor.
//
// Time is what this test moves: every timer of 10 s or more fires at once.

import assert from 'node:assert/strict';
import { FacetCallDeadlineError, loadHelperFacet } from '../../packages/worker/src/facets/helper-facet.ts';
import { oxcTransformHost } from '../../packages/worker/src/facets/oxc-transform.ts';
import { buildFacetPrebundler } from '../../packages/worker/src/facets/build-facet.ts';
import { facetCallDeadlineMs } from '../../packages/fabric/src/facet-limits.ts';
import { loaderLedgerStats } from '../../packages/fabric/src/budgets.ts';
import * as oxcHarness from './lib/oxc-facet-harness.mjs';
import * as buildHarness from './lib/build-facet-harness.mjs';

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, typeof ms === 'number' && ms >= 10_000 ? 0 : ms, ...args);
// Settled within 2 s of real time, or 'pending': an unbounded call fails here instead of hanging the file.
const settle = (call) => Promise.race([call.then(() => 'answered', (e) => e), new Promise((r) => realSetTimeout(() => r('pending'), 2000))]);
const never = () => new Promise(() => {});

try {
  // ── 1. an expired compute call aborts its facet, then fails, by type ───────
  // ── 2. its late answer resumes nothing; the command's facet is untouched ──
  {
    const events = [];
    let answerLate = () => {};
    const ctx = {
      id: { toString: () => 'helper-deadline-do' },
      facets: {
        get: (name) => {
          events.push(`get ${name}`);
          return {
            transformMany: () => new Promise((resolve) => { answerLate = resolve; }),
            build: never,
            cli: never,
          };
        },
        abort: (name, reason) => events.push(`abort ${name} ${reason?.name}`),
      },
    };
    const env = { LOADER: { get: () => ({ getDurableObjectClass: () => class {} }) }, ASSETS: { fetch: async () => new Response('') } };
    const spec = { kind: 'esbuild', id: 'esbuild-facet', className: 'EsbuildFacet', what: 'the esbuild facet', code: async () => ({}) };
    const facet = await loadHelperFacet(ctx, env, spec);
    const cli = await loadHelperFacet(ctx, env, { ...spec, facetName: 'esbuild-facet:cli', what: "the esbuild command's facet", runsProcesses: true });
    const command = settle(cli.cli({}));

    const expired = await settle(facet.transformMany([]).catch((error) => { events.push('failed'); throw error; }));
    assert.ok(expired instanceof FacetCallDeadlineError, `a typed deadline error: ${expired}`);
    assert.match(expired.message, new RegExp(`the esbuild facet's transformMany gave no answer within ${facetCallDeadlineMs('esbuild')} ms`));
    assert.ok(events.indexOf('abort esbuild-facet FacetCallDeadlineError') >= 0, `the facet is aborted: ${events.join(', ')}`);
    assert.ok(events.indexOf('abort esbuild-facet FacetCallDeadlineError') < events.indexOf('failed'), 'aborted before the call fails, so its work has ended when the caller moves on');
    answerLate({ late: true });
    assert.ok(!events.some((e) => e.startsWith('abort esbuild-facet:cli')), 'the command\'s facet is never aborted');
    assert.equal(await command, 'pending', 'the command is a process: no wall deadline');
  }

  // ── 3. Oxc does not try the slice again, and its admission is released ────
  {
    oxcHarness.resetInstances();
    let calls = 0;
    const { ctx, env } = oxcHarness.durableObject(class { transformMany() { calls++; return new Promise(() => {}); } });
    const outcome = await settle(oxcTransformHost(ctx, env)([{ code: 'export const a = 1;', options: { loader: 'js', format: 'esm' } }]));
    assert.notEqual(outcome, 'pending', 'the transform host answers');
    assert.equal(calls, 1, 'one call: a slice past its deadline is not sent again');
    assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, [], 'its admission is released');
  }

  // ── 4. the pre-bundler does not take a deadline for a reset ───────────────
  {
    let calls = 0;
    const { ctx, env } = buildHarness.durableObject(class { warm() {} prebundle() { calls++; return new Promise(() => {}); } });
    const result = await settle(buildFacetPrebundler(ctx, env)({ specifier: 'react', slice: { files: {} } }));
    assert.ok(result instanceof FacetCallDeadlineError, `the deadline, not a reset or its retry: ${result}`);
    assert.equal(calls, 1, 'one call: a pre-bundle past its deadline is not run again');
  }
} finally {
  globalThis.setTimeout = realSetTimeout;
  oxcHarness.releaseFacetHarness();
  buildHarness.releaseBuildFacetHarness();
}
console.log('helper-facet-call-deadline: ok');
process.exit(0);
