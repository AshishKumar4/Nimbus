/**
 * realm-egress.ts — a realm's requests off the box, through the workspace's
 * egress.
 *
 * A realm (runtime/realm.ts: a worker thread, or under Bun a process) cannot
 * be handed a Fetcher, so under an egress its `fetch` crosses to the host,
 * which sends the request out through the workspace's network and sends the
 * response back as it arrives (realm-egress-guest.ts is the realm's side).
 * The inline `node` (node-realm.ts) and the facets of a local facet host
 * (local-facet-host.ts) cross the same way.
 *
 * Its fetch is Node's: the head arrives first and the body as the realm reads
 * it; the realm's redirect mode is applied here, each hop its own request
 * through the egress, as workerd's fetch follows a Fetcher's.
 */
import type { WorkspaceNetwork } from '../_shared/workspace-network.js';
/** A header list as it crosses: in order, a name once per value (set-cookie). */
export type HeaderPairs = readonly (readonly [string, string])[];
/** A request the realm sends off the box: its body whole, its redirect mode the realm's. */
export interface EgressRequest {
    readonly url: string;
    readonly method: string;
    readonly headers: HeaderPairs;
    readonly body: Uint8Array | null;
    readonly redirect: 'follow' | 'manual' | 'error';
}
/** Its response's head. A body, when there is one, crosses a chunk per `egress-pull`. */
export interface EgressHead {
    readonly status: number;
    readonly statusText: string;
    readonly headers: HeaderPairs;
    /** Where the response came from, after any redirect followed. */
    readonly url: string;
    readonly redirected: boolean;
    readonly body: boolean;
}
/** What the realm posts for a request. */
export type EgressGuestEvent = {
    readonly type: 'egress';
    readonly id: number;
    readonly request: EgressRequest;
}
/** The realm reads the response's body: the next chunk, or its end. */
 | {
    readonly type: 'egress-pull';
    readonly id: number;
}
/** The realm is done with the request (it cancelled the body, or aborted). */
 | {
    readonly type: 'egress-cancel';
    readonly id: number;
};
/** What the host posts back for it. */
export type EgressHostEvent = {
    readonly type: 'egress-head';
    readonly id: number;
    readonly head: EgressHead;
} | {
    readonly type: 'egress-chunk';
    readonly id: number;
    readonly chunk: Uint8Array;
} | {
    readonly type: 'egress-end';
    readonly id: number;
}
/** The request failed, or its body did after the head: what a failed connection is in Node. */
 | {
    readonly type: 'egress-error';
    readonly id: number;
    readonly message: string;
};
export declare function isEgressGuestEvent(value: unknown): value is EgressGuestEvent;
export declare function isEgressHostEvent(value: unknown): value is EgressHostEvent;
/**
 * The host's side: a realm's requests, each sent out through the workspace's
 * network, and its response crossing back as it arrives: the head first, then
 * one chunk of the body each time the realm reads one. A response that does
 * not end (server-sent events) is read as it comes, and a body the realm does
 * not read is not read here either: nothing of it waits in this isolate.
 */
export declare class RealmEgress {
    private readonly network;
    private readonly post;
    private readonly open;
    constructor(network: WorkspaceNetwork, post: (event: EgressHostEvent) => void);
    /** One of the realm's events: a request, a read of a body, or a cancel. */
    handle(event: EgressGuestEvent): void;
    private start;
    private pull;
    private cancel;
    /** The realm has ended: what it left open is closed. */
    close(): void;
}
//# sourceMappingURL=realm-egress.d.ts.map