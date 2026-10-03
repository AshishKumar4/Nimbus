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
 *
 * A binding that dies (a trap, or the stack overflowing inside it: a module
 * nested too deeply) holds promises that never settle. The loader says so
 * (`onFatal`), and every build on it, in flight or later, is answered at once
 * with `crashed`; rolldown's JavaScript keeps the binding it imported, so only
 * a fresh isolate (rolldownBuildHost's next generation) builds again.
 */
const BUILD_FACET_BODY = [
  // One load for every caller, overlapping ones included.
  'let runtime = null;',
  'let crashed = null;',
  'const inFlight = new Set();',
  'function rolldownRuntime() {',
  '  if (runtime === null) {',
  '    globalThis.__nimbusRolldownBinding = createNapiWasmBinding({',
  '      fs, env: {}, writeStdout() {}, writeStderr() {},',
  `      binding: rolldownWasm, trampoline: trampolineWasm, memoryPages: ${ROLLDOWN.memoryPages}, name: "rolldown",`,
  '      onFatal(error) {',
  '        crashed = { stackExhausted: error instanceof RangeError, message: String((error && error.message) || error) };',
  '        for (const answer of inFlight) answer();',
  '        inFlight.clear();',
  '      },',
  '    });',
  // Dynamic: rolldown's JavaScript reads the binding as it evaluates, so it is imported once the binding exists.
  '    runtime = import("rolldown-runtime.js");',
  '  }',
  '  return runtime;',
  '}',
  'function crashOutcome() {',
  '  const text = crashed.stackExhausted',
  '    ? "Nimbus\'s bundler ran out of stack: a module nests too deeply for it (" + crashed.message + ")"',
  '    : "Nimbus\'s bundler crashed: " + crashed.message;',
  '  return {',
  '    outputFiles: [], warnings: [], failure: "Build failed with 1 error:\\nerror: " + text,',
  '    errors: [{ id: "", pluginName: "", text, location: null, notes: [], detail: undefined }],',
  '    crashed,',
  '  };',
  '}',
  'export class BuildFacet extends DurableObject {',
  '  async build(options, plugin) {',
  '    if (crashed) return crashOutcome();',
  '    const { build } = await rolldownRuntime();',
  '    if (crashed) return crashOutcome();',
  '    return new Promise((resolve, reject) => {',
  '      const answer = () => resolve(crashOutcome());',
  '      inFlight.add(answer);',
  '      build(options, plugin).then(resolve, reject).finally(() => inFlight.delete(answer));',
  '    });',
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

/** A build's outcome from the facet; `crashed` says its binding died under it. */
type BuildFacetOutcome = EsbuildBuildOutcome & { crashed?: { stackExhausted: boolean; message: string } };

type BuildFacetRpc = DurableObject & {
  build(options: EsbuildHostBuildOptions, plugin: EsbuildRemotePlugin): Promise<BuildFacetOutcome>;
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

/**
 * Which isolate of the build facet's code builds: a binding that died is
 * left behind with its isolate, and every Durable Object this isolate hosts
 * moves to the next generation's, whose loader id and facet name are new.
 */
let generation = 0;
const generationId = (n: number) => `${BUILD_FACET_WORKER_ID}:g${n}`;

interface SharedFacet {
  generation: number;
  stub: Promise<Fetcher<BuildFacetRpc>>;
}

async function buildFacet(ctx: DurableObjectState, env: unknown, id: string): Promise<Fetcher<BuildFacetRpc>> {
  const loader = Reflect.get(Object(env), 'LOADER');
  if (!loader || typeof loader.get !== 'function') throw new Error('Nimbus: env.LOADER unavailable for the build facet');
  const assets = Reflect.get(Object(env), 'ASSETS');
  if (!assets || typeof assets.fetch !== 'function') throw new Error('Nimbus: env.ASSETS unavailable for the build facet');
  const worker = await loader.get(id, async () => buildFacetWorkerCode(await fetchBuildFacetParts({ ASSETS: assets })));
  const facetClass = worker.getDurableObjectClass('BuildFacet');
  return ctx.facets.get<BuildFacetRpc>(id, async () => ({ class: facetClass }));
}

/**
 * One stub per Durable Object: callers that overlap wait on one facet load.
 * A load or call that failed drops the entry; the next caller mints a fresh one.
 * An entry of a retired generation is dropped, and its facet aborted.
 */
const sharedFacets = new WeakMap<DurableObjectState, SharedFacet>();

function sharedBuildFacet(ctx: DurableObjectState, env: unknown): SharedFacet {
  const current = sharedFacets.get(ctx);
  if (current && current.generation === generation) return current;
  if (current) retireFacet(ctx, current);
  const minted: SharedFacet = { generation, stub: buildFacet(ctx, env, generationId(generation)) };
  sharedFacets.set(ctx, minted);
  minted.stub.catch(() => forgetBuildFacet(ctx, minted));
  return minted;
}

function forgetBuildFacet(ctx: DurableObjectState, facet: SharedFacet): void {
  if (sharedFacets.get(ctx) === facet) sharedFacets.delete(ctx);
}

function retireFacet(ctx: DurableObjectState, facet: SharedFacet): void {
  forgetBuildFacet(ctx, facet);
  try {
    ctx.facets.abort(generationId(facet.generation), new Error('Nimbus: the build facet\'s binding died'));
  } catch {
    // already gone
  }
}

/**
 * The build host a Durable Object's builds run on: its build facet, which runs
 * rolldown. The plugin, and with it every file read, stays with the caller.
 *
 * A build whose binding died under it (`crashed`: a trap, or a module nested
 * past the stack) retires that generation: the next build mints a fresh
 * isolate. The build itself, and every other one that was in flight on that
 * binding, goes to `fallback` (the esbuild facet in production), each logged;
 * without one, its failure says what happened.
 */
export function rolldownBuildHost(ctx: DurableObjectState, env: unknown, fallback?: EsbuildBuildHost): EsbuildBuildHost {
  return async (options, plugin) => {
    const facet = sharedBuildFacet(ctx, env);
    const endFetch = beginLoaderFetch(ctx, BUILD_FACET_WORKER_ID);
    let outcome: BuildFacetOutcome;
    try {
      outcome = await (await facet.stub).build(options, plugin);
    } catch (error) {
      forgetBuildFacet(ctx, facet);
      throw error;
    } finally {
      endFetch();
    }
    const { crashed, ...built } = outcome;
    if (!crashed) return built;
    if (facet.generation === generation) generation++;
    retireFacet(ctx, facet);
    const entries = Array.isArray(options.entryPoints) ? options.entryPoints.join(', ') : '<entries>';
    console.warn(`[build-facet] rolldown's binding died building ${entries} (${crashed.message}); ${fallback ? 'building it with esbuild' : 'the build fails'}`);
    return fallback ? fallback(options, plugin) : built;
  };
}
