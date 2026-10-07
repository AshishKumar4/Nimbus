/**
 * ws-relay.ts — the supervisor owns a facet's outbound WebSockets.
 *
 * Why this exists, and why nothing cheaper works
 * ──────────────────────────────────────────────
 * A facet resumes coherently when the thing that woke it was a supervisor
 * reply, because the cache-invalidation delta rides on that reply. An inbound
 * WebSocket frame is the one remaining input that arrives with no reply to
 * ride on: the socket is facet↔external directly, so `onmessage` fires as a
 * bare resumption. That is not "the facet chose to do I/O" — it is an
 * arbitrary third party delivering arbitrary content into the facet at a time
 * of its choosing, which means two facets connected to any common external
 * endpoint have a full-duplex channel that never passes the authority.
 *
 * Mediating the transport does not fix it. Routing facet egress through the
 * supervisor would proxy the bytes and still leave the frame firing as a bare
 * resumption, because a proxy is not a barrier. The delivery EVENT itself has
 * to become a supervisor message. So the supervisor terminates the socket and
 * the facet receives frames as replies to a poll it is already blocked on —
 * the same shape as the attached-process stdin pump — at which point the
 * facet's frame handler can take the same ACQUIRE every other supervisor-
 * delivered resumption takes.
 *
 * What this costs, deliberately
 * ─────────────────────────────
 * Every frame is copied through a single-threaded actor with a 64 MiB heap
 * ceiling, and each one costs a poll round trip. That is a real throughput
 * tax on a real-time socket. It is paid because the alternative is a facet
 * that reads its own filesystem and gets an answer that is silently wrong.
 *
 * Queues are bounded in BYTES, not entries, and overflow closes the socket
 * with a reason the program can read. A relay that silently dropped frames
 * would trade a coherence bug for a data-loss bug, and an unbounded one would
 * let a chatty endpoint evict the supervisor.
 */
/** A frame or lifecycle event, as the facet receives it. */
import type { WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
export type WsRelayEvent = {
    kind: 'open';
    protocol: string;
} | {
    kind: 'message';
    text: string | null;
    bytes: Uint8Array | null;
} | {
    kind: 'close';
    code: number;
    reason: string;
} | {
    kind: 'error';
    message: string;
};
/**
 * Per-socket inbound backlog ceiling. The supervisor's own in-flight budget is
 * 40 MiB against a 64 MiB heap; a single relayed socket may not be more than a
 * small fraction of that, because a session can hold several.
 */
export declare const WS_RELAY_MAX_BACKLOG_BYTES: number;
/**
 * The most of a refused upgrade's body the facet is handed (an HTTP 401's
 * JSON, say): enough to read why, never a download through the relay.
 */
export declare const WS_RELAY_REFUSAL_BODY_MAX_BYTES: number;
/** How long a refused upgrade's body is read for: one held open past this is cut there. */
export declare const WS_RELAY_REFUSAL_BODY_MAX_MS = 30000;
/** A header list as it crosses to and from a facet: in order, a name once per value. */
export type WsRelayHeaders = [string, string][];
/**
 * What `open` answers: the socket, or the destination's refusal to upgrade,
 * as it answered, at once. A refusal's body, when it was asked for, is read
 * by polling `body` as a socket is (its chunks as binary messages, then a
 * close: 1000 at its end, 1009 cut at WS_RELAY_REFUSAL_BODY_MAX_BYTES, 1001
 * still open after WS_RELAY_REFUSAL_BODY_MAX_MS); null when not asked for or
 * there is none.
 */
export type WsRelayOpened = {
    id: number;
    protocol: string;
    headers: WsRelayHeaders;
} | {
    refused: {
        status: number;
        statusText: string;
        headers: WsRelayHeaders;
        body: number | null;
    };
};
export declare class WebSocketRelay {
    private readonly network;
    private entries;
    private nextId;
    /** `network`: the workspace's, whose egress opens every socket a process asks for. */
    constructor(network: () => WorkspaceNetwork);
    /**
     * Open the real socket and start buffering for the facet.
     *
     * Workers has no client `new WebSocket(url)` inside a Durable Object; the
     * upgrade is an ordinary fetch, through the workspace's network, whose
     * response carries the socket. The facet's own request headers go with it
     * (an Authorization, an Origin, a Cookie: what `ws` and Node's WebSocket
     * send), but those the relay owns (RELAY_OWNED_HEADERS); the supervisor
     * adds none of its own, so the request is the one the program could have
     * sent itself, to the destination it chose, through the same egress. A
     * destination that does not upgrade is answered as it answered, at once:
     * its status and headers, and (`refusalBody`) its body to read as it comes.
     */
    open(pid: number, url: string, protocols: string[], requestHeaders?: WsRelayHeaders, refusalBody?: boolean): Promise<WsRelayOpened>;
    /**
     * The facet's long poll. Returns whatever has arrived, or parks until
     * something does. Every event it returns is a supervisor reply, which is
     * the entire point: the facet applies its ACQUIRE before dispatching them.
     */
    poll(pid: number, id: number, waitMs: number): Promise<WsRelayEvent[]>;
    send(pid: number, id: number, text: string | null, bytes: Uint8Array | null): void;
    close(pid: number, id: number, code?: number, reason?: string): void;
    /** Every socket a process opened dies with it. */
    closeForPid(pid: number): void;
    /**
     * A refused upgrade's body, to the facet as it comes: each chunk a binary
     * message, up to WS_RELAY_REFUSAL_BODY_MAX_BYTES and for at most
     * WS_RELAY_REFUSAL_BODY_MAX_MS, then a close saying how it ended. The rest
     * is cancelled: nothing of it waits here past the bound.
     */
    private relayRefusalBody;
    private entryFor;
    private drain;
    private deliver;
}
//# sourceMappingURL=ws-relay.d.ts.map