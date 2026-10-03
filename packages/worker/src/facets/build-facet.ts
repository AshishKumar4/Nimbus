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
import type { PrebundleResult, PrebundleSpec } from '@nimbus-sh/core/runtime/prebundle-slice.js';
import {
  NAPI_WASM_LOADER,
  NAPI_WASM_TRAMPOLINE,
  fetchStagedBindingAsset,
  stagedBinding,
} from '../runtime/staged-bindings.js';

const ROLLDOWN = stagedBinding('rolldown');

/**
 * The binding's linear memory past which the facet asks to be retired after
 * a call. It starts at 5.4 MiB and grows to the largest graph built, and never
 * shrinks; pre-bundles measured 17.6 MiB after react-dom/client, 27.9 after
 * framer-motion, 53.8 after recharts and 60.5 after @mui/material (slices of
 * up to 23 MiB). A binding past this leaves the next call's slice too little
 * of the isolate's 128 MiB, so the next call starts a fresh isolate.
 */
const BUILD_BINDING_HIGH_WATER_BYTES = 64 * 1024 * 1024;

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
 * (`onFatal`), and every build or pre-bundle on it, in flight or later, is
 * answered at once with `crashed`; rolldown's JavaScript keeps the binding it
 * imported, so only a fresh isolate (the host's next generation) builds again.
 */
const BUILD_FACET_BODY = [
  // One load for every caller, overlapping ones included.
  'let runtime = null;',
  'let crashed = null;',
  'const inFlight = new Set();',
  'let memory = null;',
  'function rolldownRuntime() {',
  '  if (runtime === null) {',
  `    memory = new WebAssembly.Memory({ initial: ${ROLLDOWN.memoryPages}, maximum: 65536 });`,
  '    globalThis.__nimbusRolldownBinding = createNapiWasmBinding({',
  '      fs, env: {}, writeStdout() {}, writeStderr() {},',
  `      binding: rolldownWasm, trampoline: trampolineWasm, memoryPages: ${ROLLDOWN.memoryPages}, memory, name: "rolldown",`,
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
  'function crashText() {',
  '  return crashed.stackExhausted',
  '    ? "Nimbus\'s bundler ran out of stack: a module nests too deeply for it (" + crashed.message + ")"',
  '    : "Nimbus\'s bundler crashed: " + crashed.message;',
  '}',
  // One call on the binding, answered by `crashedAnswer()` if the binding is
  // or becomes dead, and marked `retire` once the binding has outgrown its mark.
  'async function onBinding(call, crashedAnswer) {',
  '  if (crashed) return crashedAnswer();',
  '  const loaded = await rolldownRuntime();',
  '  if (crashed) return crashedAnswer();',
  '  return new Promise((resolve, reject) => {',
  '    const answer = () => resolve(crashedAnswer());',
  '    inFlight.add(answer);',
  `    const outgrown = (value) => (memory.buffer.byteLength > ${BUILD_BINDING_HIGH_WATER_BYTES} ? { ...value, retire: true } : value);`,
  '    call(loaded).then((value) => resolve(outgrown(value)), reject).finally(() => inFlight.delete(answer));',
  '  });',
  '}',
  'export class BuildFacet extends DurableObject {',
  '  async warm() {',
  '    if (!crashed) await rolldownRuntime();',
  '  }',
  '  build(options, plugin) {',
  '    return onBinding((loaded) => loaded.build(options, plugin), () => ({',
  '      outputFiles: [], warnings: [], failure: "Build failed with 1 error:\\nerror: " + crashText(),',
  '      errors: [{ id: "", pluginName: "", text: crashText(), location: null, notes: [], detail: undefined }],',
  '      crashed,',
  '    }));',
  '  }',
  '  prebundle(spec) {',
  '    return onBinding((loaded) => loaded.prebundle(spec), () => ({',
  '      specifier: spec.specifier, ok: false, esmCode: "", errorText: crashText(), elapsed: 0, warnings: [], crashed,',
  '    }));',
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

/** What the facet says beside an answer: the binding died under the call, or has outgrown its mark. */
interface Crashed {
  crashed?: { stackExhausted: boolean; message: string };
  retire?: true;
}

type BuildFacetRpc = DurableObject & {
  warm(): Promise<void>;
  build(options: EsbuildHostBuildOptions, plugin: EsbuildRemotePlugin): Promise<EsbuildBuildOutcome & Crashed>;
  prebundle(spec: PrebundleSpec): Promise<PrebundleResult & Crashed>;
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
  /** Calls on it not yet answered. */
  calls: number;
  /** Left behind: aborted once its last call is answered (workerd's abort cancels calls in flight). */
  retired: boolean;
  /** Its binding died: whatever a call on it gets instead of an answer is that death. */
  crashed: boolean;
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
 * An entry of a retired generation is dropped, and its facet aborted once
 * the calls still on it are answered.
 */
const sharedFacets = new WeakMap<DurableObjectState, SharedFacet>();

function sharedBuildFacet(ctx: DurableObjectState, env: unknown): SharedFacet {
  const current = sharedFacets.get(ctx);
  if (current && current.generation === generation) return current;
  if (current) retireFacet(ctx, current);
  const minted: SharedFacet = { generation, stub: buildFacet(ctx, env, generationId(generation)), calls: 0, retired: false, crashed: false };
  sharedFacets.set(ctx, minted);
  minted.stub.catch(() => forgetBuildFacet(ctx, minted));
  return minted;
}

function forgetBuildFacet(ctx: DurableObjectState, facet: SharedFacet): void {
  if (sharedFacets.get(ctx) === facet) sharedFacets.delete(ctx);
}

function retireFacet(ctx: DurableObjectState, facet: SharedFacet): void {
  forgetBuildFacet(ctx, facet);
  // Once: every answer on an outgrown binding says to retire it.
  if (facet.retired) return;
  facet.retired = true;
  if (facet.calls === 0) abortFacet(ctx, facet);
}

function abortFacet(ctx: DurableObjectState, facet: SharedFacet): void {
  try {
    ctx.facets.abort(generationId(facet.generation), new Error('Nimbus: the build facet was retired'));
  } catch {
    // already gone
  }
}

/**
 * A call on `facet` began: it is counted until it is answered, on the
 * Durable Object's Dynamic Worker ledger under its generation's own worker
 * id, since a retired generation's call and the next one's can be in flight
 * at once as two workers.
 */
function beginCall(ctx: DurableObjectState, facet: SharedFacet): () => void {
  const endFetch = beginLoaderFetch(ctx, generationId(facet.generation));
  facet.calls++;
  return () => {
    endFetch();
    facet.calls--;
    if (facet.retired && facet.calls === 0) abortFacet(ctx, facet);
  };
}

/**
 * Loads the Durable Object's build facet ahead of its first build: the staged
 * parts fetched and verified, the binding instantiated and rolldown's
 * JavaScript evaluated, which a fresh session's first build would otherwise
 * wait on (a 13 MiB binding), while `wrangler dev` reads its config. (A
 * warm-up as `vite build` starts measured no gain: that build's first
 * seconds go to resolving through the VFS plugin.) Best effort: a failed
 * warm-up only drops the stub, as a failed call does.
 */
export function prewarmBuildFacet(ctx: DurableObjectState, env: unknown): void {
  // loadBuildFacet keeps the stub call a direct call awaited by the frame
  // that made it, as every facet call must (see beginLoaderFetch).
  loadBuildFacet(ctx, env).catch(() => {});
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
    const endCall = beginCall(ctx, facet);
    let outcome: EsbuildBuildOutcome & Crashed;
    try {
      outcome = await (await facet.stub).build(options, plugin);
    } catch (error) {
      forgetBuildFacet(ctx, facet);
      if (!facet.crashed) throw error;
      // The binding died under this build too, and its answer did not make it back.
      outcome = { outputFiles: [], errors: [], warnings: [], crashed: { stackExhausted: false, message: error instanceof Error ? error.message : String(error) } };
    } finally {
      endCall();
    }
    const { crashed, retire, ...built } = outcome;
    if (retire) retireGeneration(ctx, facet);
    if (!crashed) return built;
    retireCrashed(ctx, facet);
    const entries = Array.isArray(options.entryPoints) ? options.entryPoints.join(', ') : '<entries>';
    console.warn(`[build-facet] rolldown's binding died building ${entries} (${crashed.message}); ${fallback ? 'building it with esbuild' : 'the build fails'}`);
    if (fallback) return fallback(options, plugin);
    if (built.failure) return built;
    const text = `Nimbus's bundler crashed: ${crashed.message}`;
    return { ...built, failure: `Build failed with 1 error:\nerror: ${text}`, errors: [{ id: '', pluginName: '', text, location: null, notes: [], detail: undefined }] };
  };
}

/**
 * Leaves a dead binding's generation behind: the next call on any Durable
 * Object mints the next. Its calls still in flight are answered (the facet
 * answers each one, crashed) before the facet is aborted.
 */
function retireCrashed(ctx: DurableObjectState, facet: SharedFacet): void {
  facet.crashed = true;
  retireGeneration(ctx, facet);
}

/** Moves every Durable Object this isolate hosts past `facet`'s generation, and retires it. */
function retireGeneration(ctx: DurableObjectState, facet: SharedFacet): void {
  if (facet.generation === generation) generation++;
  retireFacet(ctx, facet);
}

/**
 * Pre-bundles one npm specifier from its slice in the Durable Object's build
 * facet (core runtime/prebundle-slice.ts on rolldown): the slice crosses
 * once, with the call, and the bundle comes back. A failed pre-bundle is a
 * result (`ok: false`), as is one whose binding died under it, which also
 * retires that generation; a call that throws drops the stub, as a build's
 * does.
 */
export function buildFacetPrebundler(ctx: DurableObjectState, env: unknown): (spec: PrebundleSpec) => Promise<PrebundleResult> {
  return async (spec) => {
    const facet = sharedBuildFacet(ctx, env);
    const endCall = beginCall(ctx, facet);
    let result: PrebundleResult & Crashed;
    try {
      result = await (await facet.stub).prebundle(spec);
    } catch (error) {
      forgetBuildFacet(ctx, facet);
      if (!facet.crashed) throw error;
      const message = error instanceof Error ? error.message : String(error);
      result = { specifier: spec.specifier, ok: false, esmCode: '', errorText: `Nimbus's bundler crashed: ${message}`, elapsed: 0, warnings: [], crashed: { stackExhausted: false, message } };
    } finally {
      endCall();
    }
    const { crashed, retire, ...answer } = result;
    if (retire) retireGeneration(ctx, facet);
    if (crashed) {
      retireCrashed(ctx, facet);
      console.warn(`[build-facet] rolldown's binding died pre-bundling ${spec.specifier} (${crashed.message})`);
    }
    return answer;
  };
}

/**
 * Loads the Durable Object's build facet and waits for it: the staged parts
 * fetched and verified, the binding instantiated. What prewarmBuildFacet
 * starts, for a caller that wants the load behind it before it allocates
 * (a pre-bundle's slice). Rejects as the load does.
 */
export async function loadBuildFacet(ctx: DurableObjectState, env: unknown): Promise<void> {
  const facet = sharedBuildFacet(ctx, env);
  const endCall = beginCall(ctx, facet);
  try {
    await (await facet.stub).warm();
  } catch (error) {
    forgetBuildFacet(ctx, facet);
    throw error;
  } finally {
    endCall();
  }
}
