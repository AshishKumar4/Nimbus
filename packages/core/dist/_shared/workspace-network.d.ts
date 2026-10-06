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
 * What a host supplies: a `fetch` for HTTP (WebSocket upgrades included) and,
 * for programs that open TCP sockets, a `connect` (a Fetcher's own; its
 * sockets carry plain TCP only, so a program's TLS socket is refused under an
 * egress, see `EGRESS_TLS_REFUSAL`).
 */
export interface WorkspaceEgress {
    fetch(request: Request): Promise<Response>;
    connect?(address: string | {
        hostname: string;
        port: number;
    }, options?: unknown): unknown;
}
export interface WorkspaceNetwork {
    /** The host's egress, or undefined for the isolate's own network. */
    readonly egress: WorkspaceEgress | undefined;
    /**
     * Who this network is, for anything that caches what it fetched or loaded
     * through it (a loader id, a response cache): '' for the isolate's own
     * network, else an id unique to this egress, so nothing made under one
     * workspace's egress is reused under another's.
     */
    readonly id: string;
    /** `fetch` for code that runs in the host's isolate on the workspace's behalf. */
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
/**
 * The workspace network over `egress`, or over the isolate's own network
 * when there is none. `id` is given only where a network crosses to another
 * Durable Object (a peer that runs the workspace's work keeps its identity).
 */
export declare function workspaceNetwork(egress?: WorkspaceEgress, id?: string): WorkspaceNetwork;
/** What crosses to another Durable Object for `network` (an egress stub crosses RPC; the network rebuilds there). */
export interface WorkspaceNetworkRef {
    egress: WorkspaceEgress;
    id: string;
}
export declare function networkRef(network: WorkspaceNetwork | undefined): WorkspaceNetworkRef | undefined;
/** The isolate's own network: what a kernel or command holds before a workspace gives it one. */
export declare const ISOLATE_NETWORK: WorkspaceNetwork;
/**
 * The part of a Dynamic Worker's loader config that routes it through the
 * workspace's egress: `{ globalOutbound }`, or nothing (the loader's default)
 * when there is none.
 */
export declare function loaderOutbound(network: WorkspaceNetwork | undefined): {
    globalOutbound?: WorkspaceEgress;
};
/** Why a program's TLS socket is refused when the workspace's network goes through an egress. */
export declare const EGRESS_TLS_REFUSAL: string;
//# sourceMappingURL=workspace-network.d.ts.map