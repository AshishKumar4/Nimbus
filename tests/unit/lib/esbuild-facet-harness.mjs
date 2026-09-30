// The esbuild facet as production loads it, evaluated in this process.
//
// `esbuildFacetWorkerCode` over the staged assets is the facet module; the
// harness swaps its two `cloudflare:workers` / `esbuild.wasm` imports for
// bindings of its own and counts what its esbuilds do: `esbuilds` records how
// many initialized, how many were stopped, how many were live at once at the
// most, and the wasm memory each took, and lets a case fail an initialization,
// cap the memory the facet's esbuilds hold, or end the latest esbuild's Go
// program (`exitGo`). `durableObject` is a Durable Object as
// esbuild-transform.ts sees it (`env.LOADER`, `ctx.facets`), so a case drives
// the same `esbuildTransformHost` a session does.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { esbuildFacetWorkerCode } from '../../../packages/worker/src/facets/esbuild-transform.ts';
import { ESBUILD_JS_ASSET_PATH } from '../../../packages/worker/src/esbuild-wasm-bundle.generated.ts';
import { ESBUILD_CLI_ASSET_PATH } from '../../../packages/worker/src/esbuild-cli-artifact.generated.ts';

/**
 * What the facet's esbuilds have done since the last reset. `beforeInitialize`
 * runs ahead of each initialization and may throw to fail it. `memories` is
 * every wasm memory the esbuilds took, stopped ones too: stopping frees
 * nothing until a garbage collection, and none is counted on within a case.
 * An esbuild whose instantiation would take them past `memoryLimitBytes`
 * fails as a Worker over its memory limit does. `exits` are the Go
 * `runtime.wasmExit` imports the esbuilds were instantiated with.
 */
export const esbuilds = {};

export function resetEsbuilds() {
  Object.assign(esbuilds, { initializations: 0, stops: 0, live: 0, peakLive: 0, memoryBytes: [], beforeInitialize: null, memories: [], memoryLimitBytes: Infinity, exits: [] });
}
resetEsbuilds();

/** Ends the Go program of the latest esbuild, as a fatal Go error would. */
export function exitGo() {
  esbuilds.exits.at(-1)(0);
}

// Go's `runtime.wasmExit`, as the instance gets it (after anything the facet
// wraps around it), is recorded at instantiation.
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = function (module, imports) {
  const exit = imports?.gojs?.['runtime.wasmExit'];
  if (typeof exit === 'function') esbuilds.exits.push(exit);
  return Reflect.apply(instantiate, WebAssembly, [module, imports]);
};

const resolveFromCore = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
const wasmBytes = await readFile(resolveFromCore.resolve('esbuild-wasm/esbuild.wasm'));
const staged = (path) => readFile(new URL(`../../../packages/worker/public${path}`, import.meta.url), 'utf8');

// The staged adapter is a function body returning esbuild's API. Its
// initialize() and stop() report to `esbuilds`; the WebAssembly namespace it
// instantiates through is the one the facet hands it, so the wasm memory each
// initialized esbuild took is recorded too.
const countedJsFnBody = [
  'const facetWebAssembly = WebAssembly;',
  'let memory = null;',
  'const observed = Object.create(facetWebAssembly, {',
  '  instantiate: { value: async (module, imports) => {',
  '    const instance = await facetWebAssembly.instantiate(module, imports);',
  '    memory = instance.exports.mem;',
  '    const counts = globalThis.__esbuilds;',
  '    const allocated = counts.memories.reduce((bytes, mem) => bytes + mem.buffer.byteLength, memory.buffer.byteLength);',
  '    if (allocated > counts.memoryLimitBytes) throw new Error("Worker exceeded memory limit.");',
  '    counts.memories.push(memory);',
  '    return instance;',
  '  } },',
  '});',
  `const api = (function (WebAssembly) {\n${await staged(ESBUILD_JS_ASSET_PATH)}\n})(observed);`,
  'const initialize = api.initialize;',
  'api.initialize = async (options) => {',
  '  const counts = globalThis.__esbuilds;',
  '  counts.initializations++;',
  '  await counts.beforeInitialize?.();',
  '  await initialize(options);',
  '  counts.memoryBytes.push(() => memory.buffer.byteLength);',
  '  counts.live++;',
  '  counts.peakLive = Math.max(counts.peakLive, counts.live);',
  '};',
  'const stop = api.stop;',
  'api.stop = () => {',
  '  globalThis.__esbuilds.stops++;',
  '  globalThis.__esbuilds.live--;',
  '  return stop();',
  '};',
  'return api;',
].join('\n');
globalThis.__esbuilds = esbuilds;

const wasmModule = await WebAssembly.compile(wasmBytes);
const facetSource = esbuildFacetWorkerCode(wasmModule, countedJsFnBody, await staged(ESBUILD_CLI_ASSET_PATH))
  .modules['worker.js']
  .replace('import { DurableObject } from "cloudflare:workers";', 'const { DurableObject } = globalThis.__facetImports;')
  .replace('import wasmModule from "esbuild.wasm";', 'const { wasmModule } = globalThis.__facetImports;');
if (/^import /m.test(facetSource)) throw new Error('esbuild-facet-harness: the facet module still has an import to bind');
globalThis.__facetImports = {
  DurableObject: class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
  wasmModule,
};

let moduleCopy = 0;
/** A fresh evaluation of the facet module: its own esbuild, its own kept state. */
export async function freshFacetClass() {
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
export function durableObject(EsbuildFacet, { brokenStubs = 0 } = {}) {
  const counts = { loaderGets: 0, facetInstances: 0, stubs: 0, transformCalls: 0 };
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
          transformMany: async (requests) => {
            counts.transformCalls++;
            return structuredClone(await (await instance).transformMany(structuredClone(requests)));
          },
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

/** Restore the globals the harness set; a test that uses the harness ends with this. */
export function releaseFacetHarness() {
  delete globalThis.__esbuilds;
  delete globalThis.__facetImports;
  WebAssembly.instantiate = instantiate;
}
