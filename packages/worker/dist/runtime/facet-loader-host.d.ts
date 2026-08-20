/**
 * The workerd {@link FacetHost}: a facet is a dynamic worker.
 *
 * The whole adapter is the option renames below, because `IsolatePool`
 * already IS the port's shape — `submit` and `dispose`, with the same meanings.
 * The one thing it spells differently is the supervisor capability, which it
 * takes as a pid plus a separate flag saying whether to bind one at all; the
 * port collapses the pair, since a facet with the binding and no pid can read
 * the session and never write to it. `reuse` is the pool's `cacheScope` under
 * the name the port gives it: who a warm facet may answer for.
 */
import type { FacetHost } from '@nimbus-sh/core/runtime/facet-host.js';
import type { FacetManager } from '../facets/manager.js';
export declare function loaderFacetHost(env: unknown, ctx: DurableObjectState): FacetHost;
/**
 * The two objects a IsolatePool needs from a FacetManager, via the manager's
 * own `loaderHost()` accessor. The runtime guard stays: harnesses build
 * FacetManagers on mock contexts, and one built on something other than a
 * DurableObjectState should fail with a sentence instead of at the first RPC.
 */
export declare function getFacetManagerLoaderHost(facetMgr: FacetManager): {
    env: unknown;
    ctx: DurableObjectState;
};
/** The facet host a runtime reached through a FacetManager runs on. */
export declare function facetHostForManager(facetMgr: FacetManager): FacetHost;
//# sourceMappingURL=facet-loader-host.d.ts.map