import { IsolatePool } from '@nimbus-sh/fabric/isolate-pool.js';
/**
 * The transforms and builds a host's own Durable Object runs outside the
 * session, composed the way the supervisor's are: transforms in the object's
 * transform facet (Nimbus's Oxc build), builds in its build facet
 * (rolldown), never in its isolate, where an engine's wasm memory would only
 * grow.
 */
export { supervisorEsbuildService } from '../facets/esbuild-transform.js';
/**
 * Facets as dynamic workers over `env` and `ctx`, each going out through
 * `network`: the workspace's (`workspace.network`, or `workspaceNetwork(egress)`
 * for the egress the workspace is created with).
 */
export function loaderFacetHost(env, ctx, network) {
    return {
        // workerd suspends a guest through JSPI, which is what lets a syscall reach
        // back to the session mid-instruction.
        parking: 'jspi',
        open(spec) {
            return new IsolatePool(env, ctx, {
                tag: spec.tag,
                concurrency: spec.concurrency,
                preamble: spec.preamble,
                wasmModules: spec.wasmModules,
                omitSupervisor: spec.syscalls === undefined,
                supervisorPid: spec.syscalls?.pid,
                cacheScope: spec.reuse,
                network,
            });
        },
    };
}
/**
 * What an IsolatePool is built from, from a FacetManager: its env and ctx and
 * the workspace's network, via the manager's own `loaderHost()` accessor. The
 * runtime guard stays: harnesses build FacetManagers on mock contexts, and one
 * built on something other than a DurableObjectState should fail with a
 * sentence instead of at the first RPC.
 */
export function getFacetManagerLoaderHost(facetMgr) {
    const { env, ctx, network } = facetMgr.loaderHost();
    if (!isDurableObjectState(ctx)) {
        throw new Error('a loader-backed runtime requires a FacetManager with DurableObjectState context');
    }
    return { env, ctx, network };
}
/** The facet host a runtime reached through a FacetManager runs on, over the manager's network. */
export function facetHostForManager(facetMgr) {
    const { env, ctx, network } = getFacetManagerLoaderHost(facetMgr);
    return loaderFacetHost(env, ctx, network);
}
function isDurableObjectState(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    return 'id' in value && typeof Reflect.get(value, 'waitUntil') === 'function';
}
