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
import type { ProcessEntry } from '../runtime/process-table.js';
/**
 * What a host supplies: a Fetcher (a service binding, a `ctx.exports`
 * entrypoint), or on a host without one an object with the same two methods.
 * `fetch` carries HTTP (WebSocket upgrades included); `connect` carries the
 * plain TCP sockets programs open. A Fetcher's `connect()` carries plain TCP
 * only; an optional `connectTls` makes the TLS session at the egress and
 * returns its plaintext streams. Without it, TLS is refused by name.
 * An egress that carries no TCP at all refuses in its `connect`.
 */
export interface WorkspaceEgressTls {
    connectTls(target: EgressTlsTarget): Promise<EgressStreams>;
}
/** Where a program's TLS socket goes. */
export interface EgressTlsTarget {
    hostname: string;
    port: number;
    /**
     * The name the session presents (SNI) and checks the server's certificate
     * by, when the program named one other than `hostname`
     * (`tls.connect({ servername })`); absent, `hostname`, as in Node.
     */
    servername?: string;
}
/** The plaintext of a connection the egress made. */
export interface EgressStreams {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
}
export type WorkspaceEgress = Pick<Fetcher, 'fetch' | 'connect'> & Partial<WorkspaceEgressTls>;
/** A process the host may mint an egress for (NimbusWorkspaceOptions.egressFor). */
export interface EgressProcess {
    readonly pid: number;
    /** The exec that started it (`ProcessEntry.execId`), when the caller named one. */
    readonly execId?: string;
}
/**
 * The host's egress for one process: typically a `ctx.exports` entrypoint
 * minted with the process's identity in its props, so each request, socket
 * and TLS session it sees names the exec that made it. Undefined keeps the
 * workspace's egress for that process.
 */
export type EgressFor = (process: EgressProcess) => WorkspaceEgress | undefined;
/** The live processes a network selects for: their entries, by pid. */
export interface EgressProcesses {
    get(pid: number): ProcessEntry | undefined;
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
    /**
     * The network process `pid` goes out through: the egress its host minted
     * for it (`selectProcessEgress`), selected once while its process-table
     * entry lives, so its binding, its Dynamic Worker's globalOutbound, a peer
     * hosting it and the commands it runs all hold the same one. This network
     * when the host mints none, and for pid 0 (no process: Nimbus's own work,
     * or work already selected for).
     */
    forProcess(pid: number): WorkspaceNetwork;
}
/** The isolate's own network: what a kernel or command holds before a workspace gives it one. */
export declare const ISOLATE_NETWORK: WorkspaceNetwork;
/**
 * Has the workspace network over `egress` give each process of `processes`
 * the egress `egressFor` mints for it (NimbusWorkspaceOptions.egressFor).
 * One table per egress: a second for the same egress object is refused.
 */
export declare function selectProcessEgress(egress: WorkspaceEgress, egressFor: EgressFor, processes: EgressProcesses): void;
/**
 * The workspace network over `egress`, or the isolate's own network when
 * there is none. One per egress object: whatever asks for it (the workspace,
 * or a session re-driving a process before its workspace exists) holds the
 * same network, under the same id. `id` is given only where a network
 * crosses to another Durable Object: a peer that runs the workspace's work
 * rebuilds it over the stub it received, under the coordinator's id.
 */
export declare function workspaceNetwork(egress?: WorkspaceEgress, id?: string): WorkspaceNetwork;
/** What crosses to another Durable Object for `network` (an egress stub crosses RPC; the network rebuilds there). */
export interface WorkspaceNetworkRef {
    egress: WorkspaceEgress;
    id: string;
}
export declare function networkRef(network: WorkspaceNetwork | undefined): WorkspaceNetworkRef | undefined;
/**
 * The part of a Dynamic Worker's loader config that routes it through the
 * workspace's egress: `{ globalOutbound }`, or nothing (the loader's default)
 * when there is none.
 */
export declare function loaderOutbound(network: WorkspaceNetwork | undefined): {
    globalOutbound?: WorkspaceEgress;
};
/**
 * `network`, checked where a pool, a fanout or a facet host takes it: a caller
 * that does not type-check (a host's JavaScript) is refused by name rather
 * than given the isolate's network unasked.
 */
export declare function requireNetwork(network: WorkspaceNetwork | undefined, who: string): WorkspaceNetwork;
/** Why a program's TLS socket is refused when the workspace's network goes through an egress. */
export declare const EGRESS_TLS_REFUSAL: string;
//# sourceMappingURL=workspace-network.d.ts.map