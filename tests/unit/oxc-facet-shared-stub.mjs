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

// ── Nesting past the host's stack goes to the fallback, that module alone ──
{
  resetInstances();
  const { ctx, env } = durableObject(await freshFacetClass());
  const deepCode = `export const x = ${'['.repeat(200000)}${']'.repeat(200000)};`;
  const deep = { code: deepCode, options: { loader: 'js', format: 'cjs', dynamicImportParent: 'file:///app/deep.mjs' } };
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // Without a fallback the exhaustion is that module's answer, typed as such.
    const [alone, sibling] = await oxcTransformHost(ctx, env)([deep, request]);
    assert.match(alone.error, /the Oxc transform ran out of stack \(RangeError: Maximum call stack size exceeded\.?\)/);
    assert.equal(alone.stackExhausted, true);
    assert.equal(sibling.error, undefined, sibling.error);
    // With one, only that module goes to it, one call per module, logged, and its answer stands.
    const calls = [];
    const fallback = async (requests) => { calls.push(requests); return requests.map(() => ({ code: 'answered by the fallback', map: '', warnings: [] })); };
    const [nested, after] = await oxcTransformHost(ctx, env, fallback)([deep, request]);
    assert.deepEqual(calls, [[deep]]);
    assert.equal(nested.code, 'answered by the fallback');
    assert.match(after.code, /const n = 1;/);
    assert.ok(warnings.some((w) => /\[oxc-transform\] file:\/\/\/app\/deep\.mjs: .*ran out of stack.*; transforming it with esbuild/.test(w)), warnings.join('\n'));
    // Each call carries at most four, and every module gets its answer in this batch.
    calls.length = 0;
    const six = await oxcTransformHost(ctx, env, fallback)(Array(6).fill(deep));
    assert.deepEqual(calls.map((c) => c.length), [4, 2]);
    assert.deepEqual(six.map((o) => o.code), Array(6).fill('answered by the fallback'));
    // A fallback that cannot be reached, or does not answer in time, leaves it transient.
    const [unreached] = await oxcTransformHost(ctx, env, async () => { throw new Error('esbuild facet reset'); })([deep]);
    assert.equal(unreached.transient, true);
    assert.match(unreached.error, /esbuild facet unavailable: esbuild facet reset/);
    const [late] = await oxcTransformHost(ctx, env, () => new Promise(() => {}), { fallbackDeadlineMs: 50 })([deep]);
    assert.equal(late.transient, true);
    assert.match(late.error, /esbuild facet unavailable: no answer within 50 ms/);
  } finally {
    console.warn = warn;
  }
  // Only the driver's own RangeError counts: a module whose diagnostics say
  // the words (a duplicate export named so) is a verdict, never forwarded.
  const named = { code: 'const x = 1; export { x as "the Oxc transform ran out of stack", x as "the Oxc transform ran out of stack" };', options: { loader: 'js', format: 'cjs' } };
  const [duplicate] = await oxcTransformHost(ctx, env, async () => assert.fail('a duplicate export is a verdict'))([named]);
  assert.match(duplicate.error, /ran out of stack/);
  assert.equal(duplicate.stackExhausted, undefined);
  const [syntax] = await oxcTransformHost(ctx, env, async () => assert.fail('a syntax error is a verdict'))([{ code: 'let a = ;', options: { loader: 'js' } }]);
  assert.match(syntax.error, /Transform failed with 1 error/);
  console.log('  ok  nesting past the host stack goes to the fallback: that module, typed, bounded, timed, logged');
}

// ── More than four too-deep cells, unpaced and unstored: every one is placed ─
{
  // stageOpencode's prefetch bundle transforms with no store and no pacer:
  // nothing would send a deferred module again, so none may be deferred.
  resetInstances();
  const { generateTransformFacetRuntimeSource } = await import('../../packages/core/src/runtime/esbuild-service.ts');
  const { rewriteDynamicImports } = await import('../../packages/core/src/runtime/dynamic-import-rewrite.ts');
  const { lowerAsyncModule } = await import('../../packages/core/src/runtime/async-module-lowering.ts');
  const { transformBundleCells } = await import('../../packages/core/src/runtime/bundle-cell-transform.ts');
  const { runTransformRequest } = new Function(`${generateTransformFacetRuntimeSource()}\nreturn { runTransformRequest };`)();
  const { createRequire } = await import('node:module');
  const { readFile } = await import('node:fs/promises');
  const fromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
  const esbuild = await import(fromCore.resolve('esbuild-wasm/esm/browser.js'));
  // esbuild's Go runtime wants the native WebAssembly.Instance the harness counts through.
  releaseFacetHarness();
  await esbuild.initialize({ wasmModule: await WebAssembly.compile(await readFile(fromCore.resolve('esbuild-wasm/esbuild.wasm'))), worker: false });
  const { ctx, env } = durableObject(await freshFacetClass());
  // The esbuild facet's transformMany, in this process.
  const calls = [];
  const fallback = async (requests) => {
    calls.push(requests.length);
    const outcomes = [];
    for (const { code, options } of requests) outcomes.push(await runTransformRequest(esbuild, code, options, rewriteDynamicImports, lowerAsyncModule));
    return outcomes;
  };
  // Arrays 4,000 deep: past Oxc's passes on Bun's stack (and Node's 585).
  const cells = Array.from({ length: 6 }, (_, i) => ({
    path: `node_modules/deep/d${i}.mjs`,
    source: `export const x${i} = ${'['.repeat(4000)}${i}${']'.repeat(4000)};`,
  }));
  const placed = new Map();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await transformBundleCells(cells, { host: { transformMany: oxcTransformHost(ctx, env, fallback) } }, (path, result) => placed.set(path, result));
  } finally {
    console.warn = warn;
  }
  assert.equal(placed.size, 6);
  for (const [i, { path }] of cells.entries()) {
    const result = placed.get(path);
    assert.equal(result.failed, false, `${path}: ${result.code.slice(0, 200)}`);
    assert.match(result.code, new RegExp(`x${i}: \\(\\) => x${i}`));
  }
  assert.ok(calls.every((n) => n <= 4) && calls.reduce((a, b) => a + b, 0) === 6, JSON.stringify(calls));
  console.log('  ok  six too-deep cells with no store or pacer are all placed, four per esbuild call at most');
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
