#!/usr/bin/env bun
// A Durable Object's transforms share one transform facet stub
// (facets/oxc-transform.ts): callers that overlap wait on one facet load, and
// transforms share one Oxc instance until a call leaves its wasm memory past
// the high-water mark or traps, when the next call instantiates afresh. A stub
// that failed is dropped so the next call gets a working one, and a module
// that crashes the instance is a verdict on that module alone.
//
// The facet is the module production loads (oxcFacetWorkerCode over the staged
// wasm and runtime), evaluated here (lib/oxc-facet-harness.mjs); its Oxc
// instances are counted.

import assert from 'node:assert/strict';
import { oxcTransformHost } from '../../packages/worker/src/facets/oxc-transform.ts';
import {
  durableObject,
  freshFacetClass,
  instances,
  releaseFacetHarness,
  resetInstances,
} from './lib/oxc-facet-harness.mjs';

const MiB = 1024 * 1024;
const request = { code: 'const n: number = 1; export default n;', options: { loader: 'ts', format: 'esm' } };

// ── Overlapping transforms share one facet load and one instance ────────────
{
  resetInstances();
  const { ctx, env, counts } = durableObject(await freshFacetClass());
  const [first, second] = await Promise.all([
    oxcTransformHost(ctx, env)([request]),
    oxcTransformHost(ctx, env)([request]),
  ]);
  for (const [outcome] of [first, second]) {
    assert.equal(outcome.error, undefined, outcome.error);
    assert.match(outcome.code, /const n = 1;/);
  }
  assert.equal(instances.created, 1, 'two overlapping calls share one instance');
  assert.equal(counts.loaderGets, 1, 'the facet worker is loaded once');
  assert.equal(counts.facetInstances, 1, 'one facet');
  assert.ok(instances.memories[0].buffer.byteLength <= 5 * MiB, `the instance starts at ${instances.memories[0].buffer.byteLength / MiB} MiB`);
  console.log('  ok  overlapping transforms share one facet load and one instance');
}

// ── A call of rewrites alone instantiates nothing ───────────────────────────
{
  resetInstances();
  const { ctx, env } = durableObject(await freshFacetClass());
  const [rewriteOnly] = await oxcTransformHost(ctx, env)([{ code: 'module.exports = 1;', options: { rewriteOnly: true, dynamicImportParent: 'file:///a.js' } }]);
  assert.equal(rewriteOnly.code, 'module.exports = 1;');
  assert.equal(instances.created, 0, 'a call of rewrites alone starts no instance');
  console.log('  ok  a call of rewrites alone instantiates nothing');
}

// ── A module that takes the instance past the high-water mark retires it ────
{
  resetInstances();
  const { ctx, env } = durableObject(await freshFacetClass());
  const host = oxcTransformHost(ctx, env);
  // 1.4 MiB of ordinary declarations: the working set passes 32 MiB, where a
  // launch's 256 KiB slices stay near 10.
  const large = Array.from({ length: 12000 }, (_, i) => `export function f${i}(a, b) { const t = { x: a, y: b, z: [${i}, a + b] }; return t.x * ${i} + t.y + t.z[1]; }`).join('\n');
  const [before] = await host([request]);
  assert.equal(before.error, undefined, before.error);
  const [transformed] = await host([{ code: large, options: { loader: 'js', format: 'cjs' } }]);
  assert.equal(transformed.error, undefined, transformed.error);
  assert.match(transformed.code, /function f11999\(/);
  assert.ok(instances.memories[0].buffer.byteLength > 32 * MiB, `the module took the instance to ${instances.memories[0].buffer.byteLength / MiB} MiB, past the mark`);
  const [after] = await host([request]);
  assert.equal(after.error, undefined, after.error);
  assert.equal(instances.created, 2, 'the next call instantiated afresh');
  await host([request]);
  assert.equal(instances.created, 2, 'and kept that one');
  console.log('  ok  a module that takes the instance past the high-water mark retires it');
}

// ── A crash is a verdict on its module; the next call gets a fresh instance ──
{
  resetInstances();
  const { ctx, env } = durableObject(await freshFacetClass());
  const host = oxcTransformHost(ctx, env);
  instances.trapNext = true;
  const [crashed, sibling] = await host([request, request]);
  assert.match(crashed.error, /the Oxc transform crashed \(RuntimeError: unreachable\)/);
  assert.equal(crashed.transient, undefined, 'a crash is deterministic for its source: a permanent error, not a retry');
  assert.equal(sibling.error, undefined, `its slice's next module runs on a fresh instance: ${sibling.error}`);
  assert.match(sibling.code, /const n = 1;/);
  assert.equal(instances.created, 2);
  console.log('  ok  a crash is a verdict on its module, and the next gets a fresh instance');
}

// ── Deep nesting past the host's stack is that module's error, not the facet's ─
{
  resetInstances();
  const { ctx, env } = durableObject(await freshFacetClass());
  const host = oxcTransformHost(ctx, env);
  const deep = `export const x = ${'['.repeat(200000)}${']'.repeat(200000)};`;
  const [nested, after] = await host([{ code: deep, options: { loader: 'js', format: 'cjs' } }, request]);
  assert.match(nested.error, /Oxc transform crashed \(RangeError: Maximum call stack size exceeded\.?\)/);
  assert.equal(after.error, undefined, after.error);
  console.log('  ok  nesting past the host stack fails that module alone');
}

// ── A stub that threw is dropped: the retry mints a fresh one ───────────────
{
  resetInstances();
  const { ctx, env, counts } = durableObject(await freshFacetClass(), { brokenStubs: 1 });
  const [outcome] = await oxcTransformHost(ctx, env)([request]);
  assert.equal(outcome.error, undefined, outcome.error);
  assert.match(outcome.code, /const n = 1;/);
  assert.equal(counts.stubs, 2, 'the retry minted a second stub');
  console.log('  ok  a stub that threw is dropped and the slice retried');
}

// ── A slice that fails on every attempt is transient, slice by slice ────────
{
  resetInstances();
  const { ctx, env } = durableObject(await freshFacetClass(), { brokenStubs: 2 });
  const outcomes = await oxcTransformHost(ctx, env)([request, request]);
  for (const outcome of outcomes) {
    assert.equal(outcome.transient, true, JSON.stringify(outcome));
    assert.match(outcome.error, /transform facet unavailable: stub 2 disconnected/);
  }
  console.log('  ok  a slice that fails on every attempt is answered as transient');
}

releaseFacetHarness();
console.log('oxc-facet-shared-stub OK');
