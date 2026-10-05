#!/usr/bin/env bun
// A helper facet (the transform facet here; the esbuild and build facets
// take the same path, beginHelperFetch) is a Dynamic Worker in flight, and
// is admitted on the ledger as a program is. What has to hold:
//
//   (1) outside any launch, with the Durable Object's ten workers in
//       flight, a transform waits its turn: it loads nothing and takes no
//       hold until a holder ends, then runs; the ledger never counts past
//       the limit;
//   (2) inside an admitted launch (withLaunchAdmission), the transform is
//       the launch's own worker: with the launch's admission the tenth
//       worker, it runs at once, without waiting on room its own admission
//       holds, and the ledger still counts ten.
//
// Before, the transform took its hold unconditionally: an eleventh worker,
// which the platform refuses, and the launch preparing it exited 1.

import assert from 'node:assert/strict';
import { oxcTransformHost } from '../../packages/worker/src/facets/oxc-transform.ts';
import {
  beginLoaderFetch,
  DO_DYNAMIC_WORKER_LIMIT,
  loaderLedgerStats,
  withLaunchAdmission,
} from '../../packages/fabric/src/budgets.ts';
import { durableObject, freshFacetClass, releaseFacetHarness, resetInstances } from './lib/oxc-facet-harness.mjs';

const request = { code: 'const n: number = 1; export default n;', options: { loader: 'ts', format: 'esm' } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── (1) outside a launch: waits its turn ────────────────────────────────────
{
  resetInstances();
  const { ctx, env, counts } = durableObject(await freshFacetClass());
  const holds = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(ctx, `run-${i}`, undefined, 100 + i));
  let settled = false;
  const transform = oxcTransformHost(ctx, env)([request]).then((outcomes) => { settled = true; return outcomes; });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(settled, false, 'with ten workers in flight the transform waits');
  assert.equal(counts.loaderGets, 0, 'and has loaded no facet');
  assert.equal(loaderLedgerStats(ctx).peak, DO_DYNAMIC_WORKER_LIMIT, 'nor counted an eleventh worker');
  holds[0]();
  const [outcome] = await transform;
  assert.equal(outcome.error, undefined, outcome.error);
  assert.match(outcome.code, /const n = 1;/, 'it runs once a holder ends');
  assert.equal(loaderLedgerStats(ctx).peak, DO_DYNAMIC_WORKER_LIMIT, 'and the ledger never counted past the limit');
  for (const end of holds) end();
}

// ── (2) inside an admitted launch: the launch's own worker ─────────────────
{
  resetInstances();
  const { ctx, env } = durableObject(await freshFacetClass());
  const holds = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT - 1 }, (_, i) => beginLoaderFetch(ctx, `run-${i}`, undefined, 100 + i));
  const [outcome] = await withLaunchAdmission(ctx, { pid: 7, ancestors: [] }, undefined, () => oxcTransformHost(ctx, env)([request]));
  assert.equal(outcome.error, undefined, outcome.error);
  assert.match(outcome.code, /const n = 1;/, "the launch's transform runs on its admission, not waiting for room it holds");
  assert.equal(loaderLedgerStats(ctx).peak, DO_DYNAMIC_WORKER_LIMIT, 'the admission and its transform count as one worker');
  assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers.filter((k) => k.startsWith('launch:')), [], 'the admission ends with the launch');
  for (const end of holds) end();
}

releaseFacetHarness();
console.log('ok - helper-facet-admission (a transform waits its turn, or runs on its launch\'s admission; never past the limit)');
