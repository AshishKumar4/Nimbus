import { CF_COMPAT_DATE } from '@nimbus-sh/core/constants.js';
import { BUNDLER_VERSION, EsbuildService, generateEsbuildTransformRuntimeSource, } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { ESBUILD_NAME_GLOBAL_SHIM } from '@nimbus-sh/core/_shared/esbuild-facet-shim.js';
import { ESBUILD_WASM_VERSION } from '../esbuild-wasm-bundle.generated.js';
import { fetchEsbuildJsFnBody, fetchEsbuildWasmBytes } from '../runtime/esbuild-wasm-bytes.js';
// The RPC surface is part of the id: a loader id reused across surfaces serves the old class.
export const ESBUILD_TRANSFORM_WORKER_ID = `nimbus-esbuild-transform:${ESBUILD_WASM_VERSION}:${BUNDLER_VERSION}:many`;
/** Source bytes per facet call: bounds what the caller's isolate holds for one round trip. */
const TRANSFORM_BATCH_SOURCE_BYTES = 4 * 1024 * 1024;
/**
 * Slim Worker Loader module whose DO class owns the esbuild wasm heap.
 * `jsFnBody` is the staged adapter (fetchEsbuildJsFnBody), spliced in so
 * the facet evaluates it at startup, the one moment it may.
 */
export function esbuildTransformWorkerCode(wasmBytes, jsFnBody) {
    const source = [
        'import { DurableObject } from "cloudflare:workers";',
        'import wasmModule from "esbuild.wasm";',
        `const esbuild = new Function(${JSON.stringify(jsFnBody)})();`,
        ESBUILD_NAME_GLOBAL_SHIM,
        generateEsbuildTransformRuntimeSource(),
        'let initialized;',
        'function ensureInitialized() {',
        '  initialized ||= esbuild.initialize({ wasmModule, worker: false });',
        '  return initialized;',
        '}',
        'export class EsbuildTransformFacet extends DurableObject {',
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
        '}',
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
 * The transform host a Durable Object's esbuild runs its transforms on: a
 * loader-backed facet of that object which owns the esbuild wasm heap, so
 * the object's own isolate never instantiates it. Needs `env.LOADER`,
 * `env.ASSETS` and `ctx.facets`, and nothing of any host.
 */
export function esbuildTransformHost(ctx, env) {
    return async (requests) => {
        const loader = Reflect.get(Object(env), 'LOADER');
        if (!loader || typeof loader.get !== 'function') {
            throw new Error('Nimbus: env.LOADER unavailable for the isolated esbuild transform');
        }
        const assets = Reflect.get(Object(env), 'ASSETS');
        if (!assets || typeof assets.fetch !== 'function') {
            throw new Error('Nimbus: env.ASSETS unavailable for the isolated esbuild transform');
        }
        const worker = await loader.get(ESBUILD_TRANSFORM_WORKER_ID, async () => {
            const assetsEnv = { ASSETS: assets };
            const [wasmBytes, jsFnBody] = await Promise.all([
                fetchEsbuildWasmBytes(assetsEnv),
                fetchEsbuildJsFnBody(assetsEnv),
            ]);
            return esbuildTransformWorkerCode(wasmBytes, jsFnBody);
        });
        const transformClass = worker.getDurableObjectClass('EsbuildTransformFacet');
        const facet = ctx.facets.get(`esbuild-transform-${ESBUILD_TRANSFORM_WORKER_ID}`, async () => ({ class: transformClass }));
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
 * The esbuild a Durable Object's supervisor shares: build() runs in its
 * isolate over `vfs`, every transform in its transform facet.
 */
export function supervisorEsbuildService(ctx, env, vfs) {
    return new EsbuildService(vfs, { transformHost: esbuildTransformHost(ctx, env) });
}
