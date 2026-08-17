import { manifestVfs } from '@nimbus-sh/core/runtime/vfs-manifest.js';
import { LoaderPool } from '@nimbus-sh/fabric/loader-pool.js';
export function loaderFacetHost(env, ctx) {
    return {
        // workerd suspends a guest through JSPI, which is what lets a syscall reach
        // back to the session mid-instruction.
        parking: 'jspi',
        /**
         * A manifest, not a copy: sizes and modes, with the facet demand-loading
         * whatever the program opens through its supervisor. It has to be — the
         * whole seed crosses one RPC, and a session filesystem does not fit in one.
         */
        seedFilesystem(vfs, root, options) {
            return manifestVfs(vfs, root, options);
        },
        open(spec) {
            return new LoaderPool(env, ctx, {
                tag: spec.tag,
                concurrency: spec.concurrency,
                preamble: spec.preamble,
                wasmModules: spec.wasmModules,
                omitSupervisor: spec.syscalls === undefined,
                supervisorPid: spec.syscalls?.pid,
                cacheScope: spec.reuse,
            });
        },
    };
}
/**
 * The two objects a LoaderPool needs from a FacetManager, via the manager's
 * own `loaderHost()` accessor. The runtime guard stays: harnesses build
 * FacetManagers on mock contexts, and one built on something other than a
 * DurableObjectState should fail with a sentence instead of at the first RPC.
 */
export function getFacetManagerLoaderHost(facetMgr) {
    const { env, ctx } = facetMgr.loaderHost();
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
