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
import { requireNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { IsolatePool } from '@nimbus-sh/fabric/isolate-pool.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
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
    requireNetwork(network, 'loaderFacetHost');
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
                processSupervisor: spec.syscalls ? supervisorBindingProps(ctx, spec.syscalls.pid, { writerId: crypto.randomUUID(), network }) : undefined,
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
