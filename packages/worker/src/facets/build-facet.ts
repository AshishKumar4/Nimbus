import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import type {
  EsbuildBuildHost,
  EsbuildBuildOutcome,
  EsbuildHostBuildOptions,
  EsbuildRemotePlugin,
} from '@nimbus-sh/core/runtime/esbuild-service.js';
import { beginLoaderFetch } from '@nimbus-sh/fabric/budgets.js';
import { hashSource } from '@nimbus-sh/fabric/vendor/serialize.js';
import type { DurableObject } from 'cloudflare:workers';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import { ROLLDOWN_FACET_ASSET_PATH, ROLLDOWN_FACET_BUILD_ID, ROLLDOWN_FACET_SHA256 } from '../rolldown-facet-artifact.generated.js';
import { fetchStagedText, type StagedSourceEnv } from '../runtime/staged-source.js';
import {
  NAPI_WASM_LOADER,
  NAPI_WASM_TRAMPOLINE,
  fetchStagedBindingAsset,
  stagedBinding,
} from '../runtime/staged-bindings.js';

const ROLLDOWN = stagedBinding('rolldown');

/**
 * Everything of the build facet's module but its staged parts: the napi-rs
 * wasm loader (scripts/napi-wasm/loader), the threadless rolldown binding and
 * its wasi trampoline, and the facet's runtime (scripts/rolldown-facet: rolldown's
 * JavaScript and core's esbuild-contract adapter, runtime/rolldown-build.ts).
 * The binding is instantiated by the first build and kept: its linear memory
 * starts at the binding's declared minimum and grows with the largest module
 * graph built. Nothing here reads a file: every module comes from the
 * caller's plugin, so the binding's WASI filesystem is the facet's own empty
 * node:fs.
 */
const BUILD_FACET_BODY = [
  // One load for every caller, overlapping ones included.
  'let runtime = null;',
  'function rolldownRuntime() {',
  '  if (runtime === null) {',
  '    globalThis.__nimbusRolldownBinding = createNapiWasmBinding({',
  '      fs, env: {}, writeStdout() {}, writeStderr() {},',
  `      binding: rolldownWasm, trampoline: trampolineWasm, memoryPages: ${ROLLDOWN.memoryPages}, name: "rolldown",`,
  '    });',
  // Dynamic: rolldown's JavaScript reads the binding as it evaluates, so it is imported once the binding exists.
  '    runtime = import("rolldown-runtime.js");',
  '  }',
  '  return runtime;',
  '}',
  'export class BuildFacet extends DurableObject {',
  '  async build(options, plugin) {',
  '    return (await rolldownRuntime()).build(options, plugin);',
  '  }',
  '}',
].join('\n');

// The loader serves the code it cached under an id, so the id carries the code.
export const BUILD_FACET_WORKER_ID = [
  'nimbus-build',
  `rolldown-${ROLLDOWN.version}-${ROLLDOWN.wasm.sha256.slice(0, 16)}`,
  NAPI_WASM_LOADER.sha256.slice(0, 16),
  NAPI_WASM_TRAMPOLINE.sha256.slice(0, 16),
  ROLLDOWN_FACET_BUILD_ID,
  hashSource(BUILD_FACET_BODY),
].join(':');

type BuildFacetRpc = DurableObject & {
  build(options: EsbuildHostBuildOptions, plugin: EsbuildRemotePlugin): Promise<EsbuildBuildOutcome>;
};

/** The staged parts of the build facet, each verified against its pinned digest. */
export interface BuildFacetParts {
  loader: string;
  trampoline: ArrayBuffer;
  rolldown: ArrayBuffer;
  runtime: string;
}

export async function fetchBuildFacetParts(env: StagedSourceEnv): Promise<BuildFacetParts> {
  const [loader, trampoline, rolldown, runtime] = await Promise.all([
    fetchStagedBindingAsset(env, NAPI_WASM_LOADER).then((bytes) => new TextDecoder().decode(bytes)),
    fetchStagedBindingAsset(env, NAPI_WASM_TRAMPOLINE),
    fetchStagedBindingAsset(env, ROLLDOWN.wasm),
    fetchStagedText(env, {
      path: ROLLDOWN_FACET_ASSET_PATH,
      l2Key: `https://nimbus-cache.invalid${ROLLDOWN_FACET_ASSET_PATH}`,
      sha256: ROLLDOWN_FACET_SHA256,
      contentType: 'text/javascript; charset=utf-8',
      poisonedCache: 'reject',
      missingBinding: `Nimbus: the build facet requires an env.ASSETS binding (serves ${ROLLDOWN_FACET_ASSET_PATH})`,
      fetchFailed: (res) => `build facet runtime asset fetch failed: ${res.status} ${res.statusText} for ${ROLLDOWN_FACET_ASSET_PATH} — deploy is missing the asset`,
      integrityFailed: (digest, from) =>
        `build facet runtime integrity check failed: expected ${ROLLDOWN_FACET_SHA256}, got ${digest} (${from}) for ` +
        `${ROLLDOWN_FACET_ASSET_PATH} — the staged asset is corrupt or out of sync; rerun scripts/bundle-facet-workers.mjs and redeploy`,
    }),
  ]);
  return { loader, trampoline, rolldown, runtime };
}

/** The build facet's Worker Loader module: the class that owns rolldown, and its staged parts. */
export function buildFacetWorkerCode(parts: BuildFacetParts): WorkerCode {
  const source = [
    'import { DurableObject } from "cloudflare:workers";',
    'import * as fs from "node:fs";',
    'import { createNapiWasmBinding } from "napi-wasm-loader.js";',
    'import rolldownWasm from "rolldown.wasm";',
    'import trampolineWasm from "trampoline.wasm";',
    BUILD_FACET_BODY,
  ].join('\n');
  return {
    compatibilityDate: CF_COMPAT_DATE,
    compatibilityFlags: [...GUEST_COMPAT_FLAGS],
    mainModule: 'worker.js',
    modules: {
      'worker.js': source,
      'napi-wasm-loader.js': parts.loader,
      'rolldown-runtime.js': parts.runtime,
      'rolldown.wasm': { wasm: parts.rolldown },
      'trampoline.wasm': { wasm: parts.trampoline },
    },
    globalOutbound: null,
  };
}

async function buildFacet(ctx: DurableObjectState, env: unknown): Promise<Fetcher<BuildFacetRpc>> {
  const loader = Reflect.get(Object(env), 'LOADER');
  if (!loader || typeof loader.get !== 'function') throw new Error('Nimbus: env.LOADER unavailable for the build facet');
  const assets = Reflect.get(Object(env), 'ASSETS');
  if (!assets || typeof assets.fetch !== 'function') throw new Error('Nimbus: env.ASSETS unavailable for the build facet');
  const worker = await loader.get(BUILD_FACET_WORKER_ID, async () => buildFacetWorkerCode(await fetchBuildFacetParts({ ASSETS: assets })));
  const facetClass = worker.getDurableObjectClass('BuildFacet');
  return ctx.facets.get<BuildFacetRpc>(BUILD_FACET_WORKER_ID, async () => ({ class: facetClass }));
}

/**
 * One stub per Durable Object: callers that overlap wait on one facet load.
 * A load or call that failed drops the entry; the next caller mints a fresh one.
 */
const sharedFacets = new WeakMap<DurableObjectState, Promise<Fetcher<BuildFacetRpc>>>();

function sharedBuildFacet(ctx: DurableObjectState, env: unknown): Promise<Fetcher<BuildFacetRpc>> {
  const current = sharedFacets.get(ctx);
  if (current) return current;
  const minted = buildFacet(ctx, env);
  sharedFacets.set(ctx, minted);
  minted.catch(() => forgetBuildFacet(ctx, minted));
  return minted;
}

function forgetBuildFacet(ctx: DurableObjectState, stub: Promise<Fetcher<BuildFacetRpc>>): void {
  if (sharedFacets.get(ctx) === stub) sharedFacets.delete(ctx);
}

/**
 * The build host a Durable Object's builds run on: its build facet, which runs
 * rolldown. The plugin, and with it every file read, stays with the caller.
 */
export function rolldownBuildHost(ctx: DurableObjectState, env: unknown): EsbuildBuildHost {
  return async (options, plugin) => {
    const stub = sharedBuildFacet(ctx, env);
    const endFetch = beginLoaderFetch(ctx, BUILD_FACET_WORKER_ID);
    try {
      return await (await stub).build(options, plugin);
    } catch (error) {
      forgetBuildFacet(ctx, stub);
      throw error;
    } finally {
      endFetch();
    }
  };
}
