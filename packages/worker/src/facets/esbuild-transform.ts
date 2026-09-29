import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import {
  EsbuildService,
  generateEsbuildFacetRuntimeSource,
  type EsbuildBuildHost,
  type EsbuildBuildOutcome,
  type EsbuildHostBuildOptions,
  type EsbuildRemotePlugin,
  type EsbuildTransformHost,
  type EsbuildTransformOutcome,
  type EsbuildTransformRequest,
} from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { EsbuildCliArgs, EsbuildCliOutput } from '@nimbus-sh/core/runtime/esbuild-cli.js';
import type { WasiSupervisorStub } from '@nimbus-sh/core/runtime/wasi/types.js';
import { ESBUILD_NAME_GLOBAL_SHIM } from '@nimbus-sh/core/_shared/esbuild-facet-shim.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { supervisorEntrypoint } from '@nimbus-sh/fabric/composition.js';
import { beginLoaderFetch } from '@nimbus-sh/fabric/budgets.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { hashSource } from '@nimbus-sh/fabric/vendor/serialize.js';
import { classifyDoCall } from '@nimbus-sh/platform/oom-classify.js';
import type { DurableObject } from 'cloudflare:workers';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import { ESBUILD_WASM_VERSION } from '../esbuild-wasm-bundle.generated.js';
import { ESBUILD_CLI_BUILD_ID } from '../esbuild-cli-artifact.generated.js';
import { fetchEsbuildCliRunner, fetchEsbuildJsFnBody } from '../runtime/esbuild-wasm-bytes.js';
import { esbuildWasmModule } from '../runtime/host-wasm.js';
import type { NamespaceFs } from '@nimbus-sh/core/runtime/process-files.js';

/**
 * Everything of the facet's module but its staged parts: esbuild's JS adapter,
 * which the wasm version keys, and the `esbuild` command's runner, which its
 * build id keys. `wasmModule`, `newEsbuild` and `esbuild` are bound by the
 * lines before it, and the runner installs `globalThis.__esbuildCliRun` and
 * the dynamic-import rewrite transforms run after esbuild,
 * `globalThis.__nimbusRewriteDynamicImports`.
 *
 * Transforms share one esbuild, whose heap only grows. A build or an
 * `esbuild` command gets its own Go instance, dropped when it ends, so what
 * it grew goes with it.
 */
const ESBUILD_FACET_BODY = [
  ESBUILD_NAME_GLOBAL_SHIM,
  generateEsbuildFacetRuntimeSource(),
  'let initialized;',
  // One initialization per facet, shared by every transform. A failed one is
  // forgotten, as esbuild forgets it, so the next call retries.
  'function ensureInitialized() {',
  '  initialized ||= esbuild.initialize({ wasmModule, worker: false }).catch((e) => {',
  '    initialized = undefined;',
  '    throw e;',
  '  });',
  '  return initialized;',
  '}',
  'export class EsbuildFacet extends DurableObject {',
  '  async transformMany(requests) {',
  '    if (requests.some(({ options }) => !options?.rewriteOnly)) await ensureInitialized();',
  '    const outcomes = [];',
  '    for (const { code, options } of requests) {',
  '      try {',
  '        outcomes.push(await runTransformRequest(esbuild, code, options, globalThis.__nimbusRewriteDynamicImports));',
  '      } catch (e) {',
  '        outcomes.push({ error: String((e && e.message) || e) });',
  '      }',
  '    }',
  '    return outcomes;',
  '  }',
  '  async build(options, plugin) {',
  '    const own = newEsbuild();',
  '    await own.initialize({ wasmModule, worker: false });',
  '    try {',
  '      return await buildWithEsbuild(own, options, plugin);',
  '    } finally {',
  '      await own.stop();',
  '    }',
  '  }',
  '  async cli(args, supervisor, output) {',
  '    return globalThis.__esbuildCliRun(args, supervisor, output, wasmModule);',
  '  }',
  '}',
].join('\n');

// The loader serves the code it cached under an id, so the id carries the code.
export const ESBUILD_FACET_WORKER_ID = `nimbus-esbuild:${ESBUILD_WASM_VERSION}:${ESBUILD_CLI_BUILD_ID}:${hashSource(ESBUILD_FACET_BODY)}`;

/** Source bytes per facet call: bounds what the caller's isolate holds for one round trip. */
const TRANSFORM_BATCH_SOURCE_BYTES = 4 * 1024 * 1024;

type EsbuildFacetRpc = DurableObject & {
  transformMany(requests: EsbuildTransformRequest[]): Promise<EsbuildTransformOutcome[]>;
  build(options: EsbuildHostBuildOptions, plugin: EsbuildRemotePlugin): Promise<EsbuildBuildOutcome>;
  cli(args: EsbuildCliArgs, supervisor: WasiSupervisorStub, output: EsbuildCliOutput): Promise<number>;
};

/**
 * Slim Worker Loader module whose DO class owns the esbuild wasm.
 * `wasmModule` is the host Worker's own compiled esbuild module
 * (runtime/host-wasm.ts), shared with the facet rather than compiled again.
 * `jsFnBody` is the staged adapter (fetchEsbuildJsFnBody), compiled into a
 * factory at startup, the one moment code may be generated from a string;
 * each call of the factory is a separate esbuild. `cliRunner` is the staged
 * runner of the `esbuild` command (fetchEsbuildCliRunner).
 */
export function esbuildFacetWorkerCode(wasmModule: WebAssembly.Module, jsFnBody: string, cliRunner: string): WorkerCode {
  const source = [
    'import { DurableObject } from "cloudflare:workers";',
    'import wasmModule from "esbuild.wasm";',
    `const newEsbuild = new Function(${JSON.stringify(jsFnBody)});`,
    'const esbuild = newEsbuild();',
    cliRunner,
    ESBUILD_FACET_BODY,
  ].join('\n');

  return {
    compatibilityDate: CF_COMPAT_DATE,
    compatibilityFlags: [...GUEST_COMPAT_FLAGS],
    mainModule: 'worker.js',
    modules: {
      'worker.js': source,
      'esbuild.wasm': { wasm: wasmModule },
    },
    globalOutbound: null,
  };
}

/**
 * A Durable Object's esbuild facet: one loader-backed child that owns the
 * esbuild wasm, so the object's own isolate never instantiates it. Needs
 * `env.LOADER`, `env.ASSETS` and `ctx.facets`, and nothing of any host.
 */
async function esbuildFacet(ctx: DurableObjectState, env: unknown): Promise<Fetcher<EsbuildFacetRpc>> {
  const loader = Reflect.get(Object(env), 'LOADER');
  if (!loader || typeof loader.get !== 'function') {
    throw new Error('Nimbus: env.LOADER unavailable for the esbuild facet');
  }
  const assets = Reflect.get(Object(env), 'ASSETS');
  if (!assets || typeof assets.fetch !== 'function') {
    throw new Error('Nimbus: env.ASSETS unavailable for the esbuild facet');
  }
  const worker = await loader.get(ESBUILD_FACET_WORKER_ID, async () => {
    const assetsEnv = { ASSETS: assets };
    const [wasmModule, jsFnBody, cliRunner] = await Promise.all([
      esbuildWasmModule(),
      fetchEsbuildJsFnBody(assetsEnv),
      fetchEsbuildCliRunner(assetsEnv),
    ]);
    return esbuildFacetWorkerCode(wasmModule, jsFnBody, cliRunner);
  });
  const facetClass = worker.getDurableObjectClass('EsbuildFacet');
  return ctx.facets.get<EsbuildFacetRpc>(ESBUILD_FACET_WORKER_ID, async () => ({ class: facetClass }));
}

/**
 * The one way to a Durable Object's esbuild facet: its transforms, builds,
 * and `esbuild` commands share one stub, so a caller that starts
 * while another is still loading the facet (fetching and verifying its
 * staged adapter and runner) waits on that load instead of starting a second one. A load or call
 * that failed drops the entry; the next caller mints a fresh stub.
 */
const sharedFacets = new WeakMap<DurableObjectState, Promise<Fetcher<EsbuildFacetRpc>>>();

function sharedEsbuildFacet(ctx: DurableObjectState, env: unknown): Promise<Fetcher<EsbuildFacetRpc>> {
  const current = sharedFacets.get(ctx);
  if (current) return current;
  const minted = esbuildFacet(ctx, env);
  sharedFacets.set(ctx, minted);
  minted.catch(() => forgetEsbuildFacet(ctx, minted));
  return minted;
}

function forgetEsbuildFacet(ctx: DurableObjectState, stub: Promise<Fetcher<EsbuildFacetRpc>>): void {
  if (sharedFacets.get(ctx) === stub) sharedFacets.delete(ctx);
}

/**
 * One call on the shared facet; a call that throws drops the stub it used.
 * The facet's worker is one Dynamic Worker in flight on the ledger for the
 * call's duration — bracketed, never wrapped (see beginLoaderFetch).
 */
async function onEsbuildFacet<T>(
  ctx: DurableObjectState,
  env: unknown,
  call: (facet: Fetcher<EsbuildFacetRpc>) => Promise<T>,
): Promise<T> {
  const stub = sharedEsbuildFacet(ctx, env);
  const endFetch = beginLoaderFetch(ctx, ESBUILD_FACET_WORKER_ID);
  try {
    return await call(await stub);
  } catch (error) {
    forgetEsbuildFacet(ctx, stub);
    throw error;
  } finally {
    endFetch();
  }
}

/** Calls per slice: a slice whose call failed is sent once more. */
const SLICE_ATTEMPTS = 2;

/**
 * The transform host a Durable Object's esbuild runs its transforms on: its
 * esbuild facet, a slice per call. Transforms are pure, so a slice whose call
 * failed (the facet reset, the connection dropped) is sent once more, to a
 * freshly minted stub; an overloaded facet is not asked again. A slice that
 * still fails answers each of its requests with a transient error, which is
 * no verdict on the source, and the other slices keep their answers.
 */
export function esbuildTransformHost(ctx: DurableObjectState, env: unknown): EsbuildTransformHost {
  return async (requests) => {
    let facet: Promise<Fetcher<EsbuildFacetRpc>> | null = null;
    const outcomes: EsbuildTransformOutcome[] = [];
    // The facet's worker is in flight for the whole batch (bracketed, as in
    // onEsbuildFacet).
    const endFetch = beginLoaderFetch(ctx, ESBUILD_FACET_WORKER_ID);
    try {
      for (let start = 0; start < requests.length;) {
        let end = start;
        let bytes = 0;
        while (end < requests.length && (end === start || bytes + requests[end].code.length <= TRANSFORM_BATCH_SOURCE_BYTES)) {
          bytes += requests[end].code.length;
          end++;
        }
        const slice = requests.slice(start, end);
        let answered: EsbuildTransformOutcome[] | null = null;
        let failure: unknown = null;
        for (let attempt = 1; answered === null && attempt <= SLICE_ATTEMPTS; attempt++) {
          try {
            facet ??= sharedEsbuildFacet(ctx, env);
            answered = await (await facet).transformMany(slice);
          } catch (error) {
            // A stub that threw may be broken for good; the next call mints its own.
            if (facet) forgetEsbuildFacet(ctx, facet);
            facet = null;
            failure = error;
            if (classifyDoCall(error) === 'overloaded') break;
          }
        }
        if (answered === null) {
          const error = `esbuild facet unavailable: ${errorText(failure)}`;
          answered = slice.map(() => ({ error, transient: true as const }));
        }
        for (const outcome of answered) outcomes.push(outcome);
        start = end;
      }
    } finally {
      endFetch();
    }
    return outcomes;
  };
}

/**
 * The build host a Durable Object's esbuild runs its builds on: its esbuild
 * facet. The plugin, and with it every file read, stays with the caller.
 */
export function esbuildBuildHost(ctx: DurableObjectState, env: unknown): EsbuildBuildHost {
  return async (options, plugin) => {
    return onEsbuildFacet(ctx, env, (facet) => facet.build(options, plugin));
  };
}

/**
 * Runs one `esbuild` command in the Durable Object's esbuild facet, as
 * process `pid`: its files go through a supervisor capability minted for that
 * pid, the one IsolatePool mints for a facet, and its stdout and stderr come
 * back through `output` as esbuild writes them. Resolves to its exit status.
 */
export async function runEsbuildCli(
  ctx: DurableObjectState,
  env: unknown,
  pid: number,
  args: EsbuildCliArgs,
  output: EsbuildCliOutput,
): Promise<number> {
  const mint = supervisorEntrypoint();
  if (!mint) throw new Error('Nimbus: no supervisor entrypoint is composed, so the esbuild facet cannot reach the files');
  const supervisor = mint<WasiSupervisorStub>({
    props: supervisorBindingProps(ctx, pid),
  });
  return onEsbuildFacet(ctx, env, (facet) => facet.cli(args, supervisor, output));
}

/**
 * The esbuild a Durable Object's supervisor shares: its transforms and its
 * builds run in its esbuild facet, and build() reads `vfs` from here.
 */
export function supervisorEsbuildService(ctx: DurableObjectState, env: unknown, vfs: NamespaceFs): EsbuildService {
  return new EsbuildService(vfs, {
    transformHost: esbuildTransformHost(ctx, env),
    buildHost: esbuildBuildHost(ctx, env),
  });
}
