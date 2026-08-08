/**
 * The two objects a NimbusLoaderPool needs from a FacetManager.
 *
 * FacetManager does not expose its `env` and `ctx` in its type, but a loader
 * pool is constructed from exactly those, so every runtime that spawns facets
 * needs the same reach-through. Reflect.get rather than a cast: the shape is
 * checked here once, and a FacetManager built on something other than a
 * DurableObjectState fails with a sentence instead of at the first RPC.
 */
import type { FacetManager } from '../facets/manager.js';
export declare function getFacetManagerLoaderHost(facetMgr: FacetManager): {
    env: unknown;
    ctx: DurableObjectState;
};
//# sourceMappingURL=facet-loader-host.d.ts.map