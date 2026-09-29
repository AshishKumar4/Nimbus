#!/usr/bin/env bun
// A Durable Object's transforms, builds and `esbuild` commands share one
// esbuild facet stub (facets/esbuild-transform.ts): callers that overlap wait
// on one facet load, each call runs its own esbuild and stops it when it ends
// (esbuild's memory only grows, so a shared one grew with every transform of a
// launch until the facet was reset), and a stub or an initialization that
// failed is dropped so the next call gets a working one.
//
// The facet is the module production loads (esbuildFacetWorkerCode over the
// staged assets), evaluated here; its esbuild's initialize() is counted.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  esbuildBuildHost,
  esbuildFacetWorkerCode,
  esbuildTransformHost,
} from '../../packages/worker/src/facets/esbuild-transform.ts';
import { ESBUILD_JS_ASSET_PATH } from '../../packages/worker/src/esbuild-wasm-bundle.generated.ts';
import { ESBUILD_CLI_ASSET_PATH } from '../../packages/worker/src/esbuild-cli-artifact.generated.ts';

const resolveFromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const wasmBytes = await readFile(resolveFromCore.resolve('esbuild-wasm/esbuild.wasm'));
const staged = (path) => readFile(new URL(`../../packages/worker/public${path}`, import.meta.url), 'utf8');
// The staged adapter is a function body returning esbuild's API; route its
// initialize() through a hook the cases control.
const countedJsFnBody = [
  `const api = (function () {\n${await staged(ESBUILD_JS_ASSET_PATH)}\n})();`,
  'const initialize = api.initialize;',
  'api.initialize = (options) => globalThis.__initializeHook(() => initialize(options));',
  'const stop = api.stop;',
  'api.stop = () => { globalThis.__stops = (globalThis.__stops || 0) + 1; return stop(); };',
  'return api;',
].join('\n');
const wasmModule = await WebAssembly.compile(wasmBytes);
const facetSource = esbuildFacetWorkerCode(wasmModule, countedJsFnBody, await staged(ESBUILD_CLI_ASSET_PATH))
  .modules['worker.js']
  .replace('import { DurableObject } from "cloudflare:workers";', 'const { DurableObject } = globalThis.__facetImports;')
  .replace('import wasmModule from "esbuild.wasm";', 'const { wasmModule } = globalThis.__facetImports;');
assert.doesNotMatch(facetSource, /^import /m);
globalThis.__facetImports = {
  DurableObject: class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
  wasmModule,
};

let moduleCopy = 0;
/** A fresh evaluation of the facet module: its own esbuild, its own initialization state. */
async function freshFacetClass() {
  const source = `${facetSource}\n// copy ${++moduleCopy}`;
  return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).EsbuildFacet;
}

/**
 * A Durable Object as esbuild-transform sees it: `env.LOADER.get` hands out the
 * facet's worker (counted), and `ctx.facets.get` gives every caller of a name
 * the same facet instance, as workerd does. The first `brokenStubs` stubs it
 * mints throw on every call, as a stub whose connection dropped does; `build`
 * on a sound stub answers without running esbuild (only the stub is in question).
 */
function durableObject(EsbuildFacet, { brokenStubs = 0 } = {}) {
  const counts = { loaderGets: 0, facetInstances: 0, stubs: 0 };
  const instances = new Map();
  const ctx = {
    id: { toString: () => 'shared-stub-do' },
    facets: {
      get(name, load) {
        if (!instances.has(name)) {
          instances.set(name, load().then(({ class: FacetClass }) => {
            counts.facetInstances++;
            return new FacetClass({}, {});
          }));
        }
        const instance = instances.get(name);
        if (++counts.stubs <= brokenStubs) {
          const broken = async () => { throw new Error(`stub ${counts.stubs} disconnected`); };
          return { transformMany: broken, build: broken };
        }
        return {
          build: async () => ({ built: true }),
          transformMany: async (requests) => structuredClone(await (await instance).transformMany(structuredClone(requests))),
        };
      },
    },
  };
  const env = {
    ASSETS: { async fetch() { throw new Error('the worker is handed out by LOADER.get below'); } },
    LOADER: {
      async get() {
        counts.loaderGets++;
        // A load takes a turn or two, as a real one does, so a transform can
        // start while another caller is still inside it.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { getDurableObjectClass: () => EsbuildFacet };
      },
    },
  };
  return { ctx, env, counts };
}

const request = { code: 'const n: number = 1; export default n;', options: { loader: 'ts', format: 'esm' } };

// ── Overlapping transforms share one facet load; each runs its own esbuild ──
{
  let initializations = 0;
  globalThis.__stops = 0;
  globalThis.__initializeHook = (initialize) => { initializations++; return initialize(); };
  const { ctx, env, counts } = durableObject(await freshFacetClass());
  const [first, second] = await Promise.all([
    esbuildTransformHost(ctx, env)([request]),
    esbuildTransformHost(ctx, env)([request]),
  ]);
  for (const [outcome] of [first, second]) {
    assert.equal(outcome.error, undefined, outcome.error);
    assert.match(outcome.code, /const n = 1;/);
  }
  assert.equal(initializations, 2, 'each call initializes its own esbuild');
  assert.equal(globalThis.__stops, 2, 'and stops it when the call ends, so none outlives its call');
  assert.equal(counts.loaderGets, 1, 'the facet worker is loaded once');
  assert.equal(counts.facetInstances, 1, 'one facet');
  const [rewriteOnly] = await esbuildTransformHost(ctx, env)([{ code: 'module.exports = 1;', options: { rewriteOnly: true, dynamicImportParent: 'file:///a.js' } }]);
  assert.equal(rewriteOnly.code, 'module.exports = 1;');
  assert.equal(initializations, 2, 'a call of rewrites alone starts no esbuild');
  console.log('  ok  overlapping transforms share one facet load; each call runs and stops its own esbuild');
}

// ── A failed initialization is not kept: the next transform initializes afresh ─
{
  let initializations = 0;
  globalThis.__initializeHook = (initialize) => {
    initializations++;
    return initializations === 1 ? Promise.reject(new Error('wasm instantiation failed')) : initialize();
  };
  const { ctx, env } = durableObject(await freshFacetClass());
  const [failed] = await esbuildTransformHost(ctx, env)([request]);
  assert.match(failed.code ?? '', /const n = 1;/, 'the host retry recovered within the same call');
  assert.equal(initializations, 2, 'the retry initialized esbuild again rather than reusing the rejection');
  console.log('  ok  a failed esbuild initialization is retried, not kept');
}

// ── A stub that threw is dropped: the next caller mints a fresh one ─────────
{
  globalThis.__initializeHook = (initialize) => initialize();
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

delete globalThis.__initializeHook;
delete globalThis.__facetImports;
console.log('esbuild-facet-shared-stub OK');
