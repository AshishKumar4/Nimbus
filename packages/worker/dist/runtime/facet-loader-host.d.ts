/**
 * The workerd {@link FacetHost}: a facet is a dynamic worker.
 *
 * The whole adapter is the option renames below, because `IsolatePool`
 * already IS the port's shape — `submit` and `dispose`, with the same meanings.
 * The one thing it spells differently is the supervisor capability, which it
 * takes as a pid plus a separate flag saying whether to bind one at all; the
 * port collapses the pair, since a facet with the binding and no pid can read
 * the session and never write to it. `reuse` is the pool's `cacheScope` under
 * the name the port gives it: who a warm facet may answer for. The one thing
 * the host binds rather than renames is the network: every facet it opens goes
 * out through the workspace's (its egress, when it has one), so no runtime
 * opening a facet can leave it out.
 */
import { type WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import type { FacetHost } from '@nimbus-sh/core/runtime/facet-host.js';
import type { FacetManager } from '../facets/manager.js';
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
export declare function loaderFacetHost(env: unknown, ctx: DurableObjectState, network: WorkspaceNetwork): FacetHost;
/**
 * What an IsolatePool is built from, from a FacetManager: its env and ctx and
 * the workspace's network, via the manager's own `loaderHost()` accessor. The
 * runtime guard stays: harnesses build FacetManagers on mock contexts, and one
 * built on something other than a DurableObjectState should fail with a
 * sentence instead of at the first RPC.
 */
export declare function getFacetManagerLoaderHost(facetMgr: FacetManager): {
    env: unknown;
    ctx: DurableObjectState;
    network: WorkspaceNetwork;
};
/** The facet host a runtime reached through a FacetManager runs on, over the manager's network. */
export declare function facetHostForManager(facetMgr: FacetManager): FacetHost;
//# sourceMappingURL=facet-loader-host.d.ts.map