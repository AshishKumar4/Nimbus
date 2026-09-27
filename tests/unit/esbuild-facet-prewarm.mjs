#!/usr/bin/env bun
// The session pre-warms its esbuild facet in the background so the first
// transform (`vite` reading vite.config.ts) does not pay the facet's cold
// start. The pre-warm and a transform that starts while it is still running
// must share one facet load and one esbuild initialization, and a pre-warm
// that failed must leave the next transform working.
//
// The facet is the module production loads (esbuildFacetWorkerCode over the
// staged assets), evaluated here; its esbuild's initialize() is counted.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  esbuildBuildHost,
  esbuildFacetWorkerCode,
  esbuildPrewarmStatus,
  esbuildTransformHost,
  prewarmEsbuildFacet,
} from '../../packages/worker/src/facets/esbuild-transform.ts';
import { bindShellSocket } from '../../packages/worker/src/session/ws.ts';
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
  'api.initialize = (options) => globalThis.__prewarmHook(() => initialize(options));',
  'return api;',
].join('\n');
const facetSource = esbuildFacetWorkerCode(wasmBytes.buffer, countedJsFnBody, await staged(ESBUILD_CLI_ASSET_PATH))
  .modules['worker.js']
  .replace('import { DurableObject } from "cloudflare:workers";', 'const { DurableObject } = globalThis.__facetImports;')
  .replace('import wasmModule from "esbuild.wasm";', 'const { wasmModule } = globalThis.__facetImports;');
assert.doesNotMatch(facetSource, /^import /m);
globalThis.__facetImports = {
  DurableObject: class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
  wasmModule: await WebAssembly.compile(wasmBytes),
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
    id: { toString: () => 'prewarm-do' },
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
          return { warm: broken, transformMany: broken, build: broken };
        }
        return {
          build: async () => ({ built: true }),
          warm: async () => (await instance).warm(),
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
        // start while the pre-warm is still inside it.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { getDurableObjectClass: () => EsbuildFacet };
      },
    },
  };
  return { ctx, env, counts };
}

const request = { code: 'const n: number = 1; export default n;', options: { loader: 'ts', format: 'esm' } };

// ── A transform during the pre-warm shares its facet and its initialization ──
{
  let initializations = 0;
  globalThis.__prewarmHook = (initialize) => { initializations++; return initialize(); };
  const { ctx, env, counts } = durableObject(await freshFacetClass());
  const prewarm = prewarmEsbuildFacet(ctx, env);
  assert.equal(esbuildPrewarmStatus(ctx)?.state, 'pending');
  const [outcome] = await esbuildTransformHost(ctx, env)([request]);
  const status = await prewarm;
  assert.equal(outcome.error, undefined, outcome.error);
  assert.match(outcome.code, /const n = 1;/);
  assert.equal(status.state, 'ok');
  assert.equal(initializations, 1, 'the pre-warm and the transform initialize esbuild once between them');
  assert.equal(counts.loaderGets, 1, 'the facet worker is loaded once');
  assert.equal(counts.facetInstances, 1, 'one facet');
  assert.equal(prewarmEsbuildFacet(ctx, env), prewarm, 'a second pre-warm in the same activation is the first one');
  await esbuildTransformHost(ctx, env)([request]);
  assert.equal(initializations, 1, 'later transforms find esbuild initialized');
  console.log('  ok  pre-warm and a concurrent first transform share one facet load and one initialization');
}

// ── A failed pre-warm leaves the next transform working ──────────────────────
{
  let initializations = 0;
  globalThis.__prewarmHook = (initialize) => {
    initializations++;
    return initializations === 1 ? Promise.reject(new Error('wasm instantiation failed')) : initialize();
  };
  const { ctx, env } = durableObject(await freshFacetClass());
  const warns = [];
  const warn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  let status;
  try {
    status = await prewarmEsbuildFacet(ctx, env);
  } finally {
    console.warn = warn;
  }
  assert.equal(status.state, 'failed');
  assert.match(status.error, /wasm instantiation failed/);
  assert.equal(warns.length, 1, 'the failure is logged once');
  assert.equal(initializations, 1, 'a failed pre-warm is not retried');
  const [outcome] = await esbuildTransformHost(ctx, env)([request]);
  assert.equal(outcome.error, undefined, outcome.error);
  assert.match(outcome.code, /const n = 1;/);
  assert.equal(initializations, 2, 'the transform initialized esbuild afresh');
  assert.equal(esbuildPrewarmStatus(ctx)?.state, 'failed', 'the recorded outcome stays the pre-warm\'s');
  console.log('  ok  a failed pre-warm is recorded and the next transform still works');
}

// ── A stub that threw is dropped: the next caller mints a fresh one ─────────
{
  globalThis.__prewarmHook = (initialize) => initialize();
  // The transform host's retry must not reuse the shared stub that failed.
  {
    const { ctx, env, counts } = durableObject(await freshFacetClass(), { brokenStubs: 1 });
    const [outcome] = await esbuildTransformHost(ctx, env)([request]);
    assert.equal(outcome.error, undefined, outcome.error);
    assert.match(outcome.code, /const n = 1;/);
    assert.equal(counts.stubs, 2, 'the retry minted a second stub');
  }
  // A build, and a pre-warm, drop the stub they failed on; the next call gets a sound one.
  {
    const { ctx, env, counts } = durableObject(await freshFacetClass(), { brokenStubs: 1 });
    await assert.rejects(esbuildBuildHost(ctx, env)({}, {}), /stub 1 disconnected/);
    assert.deepEqual(await esbuildBuildHost(ctx, env)({}, {}), { built: true });
    assert.equal(counts.stubs, 2);
  }
  {
    const { ctx, env, counts } = durableObject(await freshFacetClass(), { brokenStubs: 1 });
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await prewarmEsbuildFacet(ctx, env)).state, 'failed');
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(await esbuildBuildHost(ctx, env)({}, {}), { built: true });
    assert.equal(counts.stubs, 2);
  }
  // A build during the pre-warm waits on its load: one LOADER.get, one stub.
  {
    const { ctx, env, counts } = durableObject(await freshFacetClass());
    const prewarm = prewarmEsbuildFacet(ctx, env);
    assert.deepEqual(await esbuildBuildHost(ctx, env)({}, {}), { built: true });
    assert.equal((await prewarm).state, 'ok');
    assert.equal(counts.loaderGets, 1);
    assert.equal(counts.stubs, 1);
  }
  console.log('  ok  transforms, builds and the pre-warm share one stub and drop it when it fails');
}

// ── An activation the SDK built pre-warms when its first terminal attaches ──
{
  let initializations = 0;
  globalThis.__prewarmHook = (initialize) => { initializations++; return initialize(); };
  const { ctx, env, counts } = durableObject(await freshFacetClass());
  const socket = () => ({ readyState: WebSocket.OPEN, send() {}, close() {} });
  // Built by ensureRuntimeReady (initSession(null)): shell and kernel up, a
  // headless terminal, no pre-warm.
  const host = {
    shell: {},
    kernel: {},
    terminal: { ws: null, attach(ws) { this.ws = ws; } },
    // NimbusSession.prewarmEsbuildFacet.
    prewarmEsbuildFacet() { void prewarmEsbuildFacet(ctx, env); },
  };
  assert.equal(esbuildPrewarmStatus(ctx), null, 'the SDK-built activation has not pre-warmed');
  assert.equal(await bindShellSocket(host, socket()), true);
  assert.equal(esbuildPrewarmStatus(ctx)?.state, 'pending', 'the attach started the pre-warm');
  assert.equal(await bindShellSocket(host, socket()), true, 'a second terminal attaches too');
  const status = await prewarmEsbuildFacet(ctx, env);
  assert.equal(status.state, 'ok');
  assert.equal(counts.loaderGets, 1, 'one facet load for the activation');
  assert.equal(initializations, 1, 'one pre-warm initialized esbuild');
  console.log('  ok  a terminal attaching to an SDK-built activation pre-warms it, once');
}

delete globalThis.__prewarmHook;
delete globalThis.__facetImports;
console.log('esbuild-facet-prewarm OK');
