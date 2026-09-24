import { CF_COMPAT_DATE } from '@nimbus-sh/core/constants.js';
import { EsbuildService, generateEsbuildFacetRuntimeSource, } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { ESBUILD_CLI_PREAMBLE } from '@nimbus-sh/core/runtime/esbuild-cli.js';
import { ESBUILD_NAME_GLOBAL_SHIM } from '@nimbus-sh/core/_shared/esbuild-facet-shim.js';
import { hostRoute, supervisorEntrypoint } from '@nimbus-sh/fabric/composition.js';
import { hashSource } from '@nimbus-sh/fabric/vendor/serialize.js';
import { ESBUILD_WASM_VERSION } from '../esbuild-wasm-bundle.generated.js';
import { fetchEsbuildJsFnBody, fetchEsbuildWasmBytes } from '../runtime/esbuild-wasm-bytes.js';
/**
 * Everything of the facet's module but esbuild's JS adapter, which the wasm
 * version keys. `wasmModule`, `newEsbuild` and `esbuild` are bound by the
 * lines before it.
 *
 * Transforms share one esbuild, whose heap only grows. A build or an
 * `esbuild` command gets its own Go instance, dropped when it ends, so what
 * it grew goes with it.
 */
const ESBUILD_FACET_BODY = [
    ESBUILD_NAME_GLOBAL_SHIM,
    generateEsbuildFacetRuntimeSource(),
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
export const ESBUILD_FACET_WORKER_ID = `nimbus-esbuild:${ESBUILD_WASM_VERSION}:${hashSource(ESBUILD_FACET_BODY)}`;
/** Source bytes per facet call: bounds what the caller's isolate holds for one round trip. */
const TRANSFORM_BATCH_SOURCE_BYTES = 4 * 1024 * 1024;
/**
 * Slim Worker Loader module whose DO class owns the esbuild wasm.
 * `jsFnBody` is the staged adapter (fetchEsbuildJsFnBody), compiled into a
 * factory at startup, the one moment code may be generated from a string;
 * each call of the factory is a separate esbuild.
 */
export function esbuildFacetWorkerCode(wasmBytes, jsFnBody) {
    const source = [
        'import { DurableObject } from "cloudflare:workers";',
        'import wasmModule from "esbuild.wasm";',
        `const newEsbuild = new Function(${JSON.stringify(jsFnBody)});`,
        'const esbuild = newEsbuild();',
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
async function esbuildFacet(ctx, env) {
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
    return ctx.facets.get(ESBUILD_FACET_WORKER_ID, async () => ({ class: facetClass }));
}
/** The transform host a Durable Object's esbuild runs its transforms on: its esbuild facet. */
export function esbuildTransformHost(ctx, env) {
    return async (requests) => {
        const facet = await esbuildFacet(ctx, env);
        const outcomes = [];
        for (let start = 0; start < requests.length;) {
            let end = start;
            let bytes = 0;
            while (end < requests.length && (end === start || bytes + requests[end].code.length <= TRANSFORM_BATCH_SOURCE_BYTES)) {
                bytes += requests[end].code.length;
                end++;
            }
            for (const outcome of await facet.transformMany(requests.slice(start, end)))
                outcomes.push(outcome);
            start = end;
        }
        return outcomes;
    };
}
/**
 * The build host a Durable Object's esbuild runs its builds on: its esbuild
 * facet. The plugin, and with it every file read, stays with the caller.
 */
export function esbuildBuildHost(ctx, env) {
    return async (options, plugin) => {
        const facet = await esbuildFacet(ctx, env);
        return await facet.build(options, plugin);
    };
}
/**
 * Runs one `esbuild` command in the Durable Object's esbuild facet, as
 * process `pid`: its files go through a supervisor capability minted for that
 * pid, the one IsolatePool mints for a facet, and its stdout and stderr come
 * back through `output` as esbuild writes them. Resolves to its exit status.
 */
export async function runEsbuildCli(ctx, env, pid, args, output) {
    const mint = supervisorEntrypoint();
    if (!mint)
        throw new Error('Nimbus: no supervisor entrypoint is composed, so the esbuild facet cannot reach the files');
    const supervisor = mint({
        props: { doId: ctx.id.toString(), pid, route: hostRoute() ?? undefined },
    });
    const facet = await esbuildFacet(ctx, env);
    return await facet.cli(args, supervisor, output);
}
/**
 * The esbuild a Durable Object's supervisor shares: its transforms and its
 * builds run in its esbuild facet, and build() reads `vfs` from here.
 */
export function supervisorEsbuildService(ctx, env, vfs) {
    return new EsbuildService(vfs, {
        transformHost: esbuildTransformHost(ctx, env),
        buildHost: esbuildBuildHost(ctx, env),
    });
}
