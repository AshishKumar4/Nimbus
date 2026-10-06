/**
 * _shared/workspace-network.ts - the network a workspace's commands and
 * programs use, and the one place that decides it.
 *
 * A host may route that network through an egress of its own
 * (NimbusWorkspaceOptions.egress): a Fetcher, typically a service binding or
 * a `ctx.exports` entrypoint minted with the workspace's identity in its
 * props, which sees every request as it leaves and may record, rewrite or
 * refuse it. Absent, the workspace uses the isolate's own network, as it
 * always has.
 *
 * Everything that reaches the network for the workspace takes it from here:
 * code in the host's isolate calls `network.fetch`, and a Dynamic Worker
 * loaded for the workspace takes `loaderOutbound(network)` into its loader
 * config, so its own `fetch()` and `connect()` reach the egress as its
 * globalOutbound. The key is omitted when there is no egress, which keeps
 * the loader's default: the parent's network.
 */
/**
 * The workspace network over `egress`, or over the isolate's own network
 * when there is none. `id` is given only where a network crosses to another
 * Durable Object (a peer that runs the workspace's work keeps its identity).
 */
export function workspaceNetwork(egress, id) {
    if (egress === undefined) {
        return { egress: undefined, id: '', fetch: (input, init) => globalThis.fetch(input, init) };
    }
    return { egress, id: id ?? 'egress-' + crypto.randomUUID(), fetch: (input, init) => egress.fetch(new Request(input, init)) };
}
export function networkRef(network) {
    return network?.egress === undefined ? undefined : { egress: network.egress, id: network.id };
}
/** The isolate's own network: what a kernel or command holds before a workspace gives it one. */
export const ISOLATE_NETWORK = workspaceNetwork();
/**
 * The part of a Dynamic Worker's loader config that routes it through the
 * workspace's egress: `{ globalOutbound }`, or nothing (the loader's default)
 * when there is none.
 */
export function loaderOutbound(network) {
    return network?.egress === undefined ? {} : { globalOutbound: network.egress };
}
/** Why a program's TLS socket is refused when the workspace's network goes through an egress. */
export const EGRESS_TLS_REFUSAL = "Nimbus: TLS sockets are not available when the workspace's network goes through an egress "
    + "(a Fetcher's connect() carries plain TCP only); use fetch() or https for HTTPS";
