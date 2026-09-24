import { CF_COMPAT_DATE } from '@nimbus-sh/core/constants.js';
import {
  EsbuildService,
  generateEsbuildTransformRuntimeSource,
  type EsbuildTransformHost,
  type EsbuildTransformOutcome,
  type EsbuildTransformRequest,
} from '@nimbus-sh/core/runtime/esbuild-service.js';
import { ESBUILD_CLI_PREAMBLE, type EsbuildCliArgs, type EsbuildCliOutput } from '@nimbus-sh/core/runtime/esbuild-cli.js';
import type { WasiSupervisorStub } from '@nimbus-sh/core/runtime/wasi/types.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { ESBUILD_NAME_GLOBAL_SHIM } from '@nimbus-sh/core/_shared/esbuild-facet-shim.js';
import { hostRoute, supervisorEntrypoint } from '@nimbus-sh/fabric/composition.js';
import { hashSource } from '@nimbus-sh/fabric/vendor/serialize.js';
import type { DurableObject } from 'cloudflare:workers';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import { ESBUILD_WASM_VERSION } from '../esbuild-wasm-bundle.generated.js';
import { fetchEsbuildJsFnBody, fetchEsbuildWasmBytes } from '../runtime/esbuild-wasm-bytes.js';

/**
 * Everything of the facet's module but esbuild's JS adapter, which the wasm
 * version keys. `wasmModule` and `esbuild` are bound by the lines before it.
 *
 * Transforms share one esbuild, whose heap only grows. An `esbuild` command
 * gets its own Go instance, dropped when it ends, so what it grew goes with it.
 */
const ESBUILD_FACET_BODY = [
  ESBUILD_NAME_GLOBAL_SHIM,
  generateEsbuildTransformRuntimeSource(),
  ESBUILD_CLI_PREAMBLE,
  'let initialized;',
  'function ensureInitialized() {',
  '  initialized ||= esbuild.initialize({ wasmModule, worker: false });',
  '  return initialized;',
  '}',
  'export class EsbuildFacet extends DurableObject {',
  '  async transformMany(requests) {',
  '    await ensureInitialized();',
  '    const outcomes = [];',
  '    for (const { code, options } of requests) {',
  '      try {',
  '        outcomes.push(await transformWithEsbuild(esbuild, code, options));',
  '      } catch (e) {',
  '        outcomes.push({ error: String((e && e.message) || e) });',
  '      }',
  '    }',
  '    return outcomes;',
  '  }',
  '  async cli(args, supervisor, output) {',
  '    return globalThis.__esbuildCliRun(args, supervisor, output, wasmModule);',
  '  }',
  '}',
].join('\n');

// The loader serves the code it cached under an id, so the id carries the code.
export const ESBUILD_FACET_WORKER_ID = `nimbus-esbuild:${ESBUILD_WASM_VERSION}:${hashSource(ESBUILD_FACET_BODY)}`;

/** Source bytes per facet call: bounds what the caller's isolate holds for one round trip. */
const TRANSFORM_BATCH_SOURCE_BYTES = 4 * 1024 * 1024;

type EsbuildFacetRpc = DurableObject & {
  transformMany(requests: EsbuildTransformRequest[]): Promise<EsbuildTransformOutcome[]>;
  cli(args: EsbuildCliArgs, supervisor: WasiSupervisorStub, output: EsbuildCliOutput): Promise<number>;
};

/**
 * Slim Worker Loader module whose DO class owns the esbuild wasm.
 * `jsFnBody` is the staged adapter (fetchEsbuildJsFnBody), spliced in so the
 * facet evaluates it at startup, the one moment it may.
 */
export function esbuildFacetWorkerCode(wasmBytes: ArrayBuffer, jsFnBody: string): WorkerCode {
  const source = [
    'import { DurableObject } from "cloudflare:workers";',
    'import wasmModule from "esbuild.wasm";',
    `const esbuild = new Function(${JSON.stringify(jsFnBody)})();`,
    ESBUILD_FACET_BODY,
  ].join('\n');

  return {
    compatibilityDate: CF_COMPAT_DATE,
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'worker.js',
    modules: {
      'worker.js': source,
      'esbuild.wasm': { wasm: wasmBytes },
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
    const [wasmBytes, jsFnBody] = await Promise.all([
      fetchEsbuildWasmBytes(assetsEnv),
      fetchEsbuildJsFnBody(assetsEnv),
    ]);
    return esbuildFacetWorkerCode(wasmBytes, jsFnBody);
  });
  const facetClass = worker.getDurableObjectClass('EsbuildFacet');
  return ctx.facets.get<EsbuildFacetRpc>(ESBUILD_FACET_WORKER_ID, async () => ({ class: facetClass }));
}

/** The transform host a Durable Object's esbuild runs its transforms on: its esbuild facet. */
export function esbuildTransformHost(ctx: DurableObjectState, env: unknown): EsbuildTransformHost {
  return async (requests) => {
    const facet = await esbuildFacet(ctx, env);
    const outcomes: EsbuildTransformOutcome[] = [];
    for (let start = 0; start < requests.length;) {
      let end = start;
      let bytes = 0;
      while (end < requests.length && (end === start || bytes + requests[end].code.length <= TRANSFORM_BATCH_SOURCE_BYTES)) {
        bytes += requests[end].code.length;
        end++;
      }
      for (const outcome of await facet.transformMany(requests.slice(start, end))) outcomes.push(outcome);
      start = end;
    }
    return outcomes;
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
    props: { doId: ctx.id.toString(), pid, route: hostRoute() ?? undefined },
  });
  const facet = await esbuildFacet(ctx, env);
  return await facet.cli(args, supervisor, output);
}

/**
 * The esbuild a Durable Object's supervisor shares: build() runs in its
 * isolate over `vfs`, every transform in its esbuild facet.
 */
export function supervisorEsbuildService(ctx: DurableObjectState, env: unknown, vfs: CredentialedVfs): EsbuildService {
  return new EsbuildService(vfs, { transformHost: esbuildTransformHost(ctx, env) });
}
