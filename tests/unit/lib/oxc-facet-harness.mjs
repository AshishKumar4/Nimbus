// The transform facet as production loads it, evaluated in this process.
//
// `oxcFacetWorkerCode` over the staged wasm and runtime is the facet module;
// the harness swaps its `cloudflare:workers` / `oxc.wasm` imports for bindings
// of its own and counts the Oxc instances the facet makes: `instances` records
// how many were created and the memory of each, and lets a case cap the memory
// the facet may take or make the next instance trap. `durableObject` is a
// Durable Object as oxc-transform.ts sees it (`env.LOADER`, `ctx.facets`), so a
// case drives the same `oxcTransformHost` a session does.

import { readFile } from 'node:fs/promises';
import { oxcFacetWorkerCode } from '../../../packages/worker/src/facets/oxc-transform.ts';
import { OXC_WASM_ASSET_PATH } from '../../../packages/worker/src/oxc-wasm-artifact.generated.ts';
import { OXC_FACET_ASSET_PATH } from '../../../packages/worker/src/oxc-facet-artifact.generated.ts';
import { AMARO_WASM_ASSET_PATH } from '../../../packages/worker/src/amaro-wasm-artifact.generated.ts';
import { namedFacetPlatform } from './named-facet-platform.mjs';

const staged = (path) => readFile(new URL(`../../../packages/worker/public${path}`, import.meta.url));

/**
 * What the facet's Oxc instances have done since the last reset. `memories`
 * holds every instance's memory; one created past `memoryLimitBytes` (of all
 * of them together) fails as a Worker over its memory limit does. `trapNext`
 * makes the next transform call trap, as a crash inside the wasm would.
 */
export const instances = {};

export function resetInstances() {
  Object.assign(instances, { created: 0, memories: [], memoryLimitBytes: Infinity, trapNext: false });
}
resetInstances();

export const wasmBytes = await staged(OXC_WASM_ASSET_PATH);
const wasmModule = await WebAssembly.compile(wasmBytes);
const runtime = (await staged(OXC_FACET_ASSET_PATH)).toString('utf8');
const amaroBytes = await staged(AMARO_WASM_ASSET_PATH);
const amaroModule = await WebAssembly.compile(amaroBytes);

// The facet's driver instantiates through the global constructor; this one
// counts, enforces the case's memory limit, and can arm a trap.
const NativeInstance = WebAssembly.Instance;
function CountedInstance(module, imports) {
  const instance = new NativeInstance(module, imports);
  // Another module (a build facet's binding in the same object) is not the facet's Oxc.
  if (typeof instance.exports.nimbus_oxc_transform !== 'function') return instance;
  const memory = /** @type {WebAssembly.Memory} */ (instance.exports.memory);
  const allocated = instances.memories.reduce((bytes, counted) => bytes + counted.buffer.byteLength, memory.buffer.byteLength);
  if (allocated > instances.memoryLimitBytes) throw new RangeError('Worker exceeded memory limit.');
  instances.created++;
  instances.memories.push(instance.exports.memory);
  const transform = instance.exports.nimbus_oxc_transform;
  const exports = Object.create(instance.exports, {
    nimbus_oxc_transform: {
      value: (...args) => {
        if (instances.trapNext) {
          instances.trapNext = false;
          throw new WebAssembly.RuntimeError('unreachable');
        }
        return transform(...args);
      },
    },
  });
  return { exports };
}

const facetSource = /** @type {string} */ (oxcFacetWorkerCode(wasmBytes.buffer, runtime, amaroBytes.buffer)
  .modules['worker.js'])
  .replace('import { DurableObject } from "cloudflare:workers";', 'const { DurableObject } = globalThis.__facetImports;')
  .replace('import oxcWasm from "oxc.wasm";', 'const { oxcWasm } = globalThis.__facetImports;')
  .replace('import amaroWasm from "amaro.wasm";', 'const { amaroWasm } = globalThis.__facetImports;');
if (/^import /m.test(facetSource)) throw new Error('oxc-facet-harness: the facet module still has an import to bind');

let moduleCopy = 0;
/** A fresh evaluation of the facet module: its own Oxc driver and instance. */
export async function freshFacetClass() {
  /** @type {any} */ (globalThis).__facetImports = {
    DurableObject: class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
    oxcWasm: wasmModule,
    amaroWasm: amaroModule,
  };
  WebAssembly.Instance = /** @type {any} */ (CountedInstance);
  const source = `${facetSource}\n// copy ${++moduleCopy}`;
  return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).OxcFacet;
}

/**
 * A Durable Object as oxc-transform sees it: `env.LOADER.get` hands out the
 * facet's worker (counted), and `ctx.facets.get` gives every caller of a name
 * the same facet instance, as workerd does. The first `brokenStubs` stubs it
 * mints throw on every call, as a stub whose connection dropped does.
 */
export function durableObject(OxcFacet, { brokenStubs = 0 } = {}) {
  const platform = namedFacetPlatform({ id: 'oxc-facet-do', classFor: () => OxcFacet, loadDelayMs: 5, brokenStubs,
    async invoke(_name, method, args, instance) {
      platform.counts.transformCalls++;
      const target = await instance;
      return structuredClone(await target[method](...structuredClone(args)));
    },
  });
  platform.counts.transformCalls = 0;
  return platform;
}

/** Restore the globals the harness set; a test that uses the harness ends with this. */
export function releaseFacetHarness() {
  delete globalThis.__facetImports;
  WebAssembly.Instance = NativeInstance;
}
