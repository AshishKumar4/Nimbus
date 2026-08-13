import { NimbusLoaderPool } from '../loaders/loader-pool.js';
export function loaderFacetHost(env, ctx) {
    return {
        open(spec) {
            return new NimbusLoaderPool(env, ctx, {
                tag: spec.tag,
                concurrency: spec.concurrency,
                preamble: spec.preamble,
                wasmModules: spec.wasmModules,
                omitSupervisor: spec.supervisorPid === undefined,
                supervisorPid: spec.supervisorPid,
            });
        },
    };
}
/**
 * The two objects a NimbusLoaderPool needs from a FacetManager.
 *
 * FacetManager does not expose its `env` and `ctx` in its type, but a loader
 * pool is constructed from exactly those, so every runtime that spawns facets
 * needs the same reach-through. Reflect.get rather than a cast: the shape is
 * checked here once, and a FacetManager built on something other than a
 * DurableObjectState fails with a sentence instead of at the first RPC.
 */
export function getFacetManagerLoaderHost(facetMgr) {
    const env = Reflect.get(facetMgr, 'env');
    const ctx = Reflect.get(facetMgr, 'ctx');
    if (!isDurableObjectState(ctx)) {
        throw new Error('a loader-backed runtime requires a FacetManager with DurableObjectState context');
    }
    return { env, ctx };
}
/** The facet host a runtime reached through a FacetManager runs on. */
export function facetHostForManager(facetMgr) {
    const { env, ctx } = getFacetManagerLoaderHost(facetMgr);
    return loaderFacetHost(env, ctx);
}
function isDurableObjectState(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    return 'id' in value && typeof Reflect.get(value, 'waitUntil') === 'function';
}
