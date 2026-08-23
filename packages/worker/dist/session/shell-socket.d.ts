/**
 * src/session/shell-socket.ts — who owns the session's terminal.
 *
 * The /ws upgrade refuses a second browser terminal on one session, so it
 * has to know whether the terminal already has an owner. `readyState ===
 * OPEN` does not answer that. It describes this end of the socket. A tab
 * that dies without a close frame leaves a socket that still reads OPEN
 * with nobody on the other end, and an upgrade that fails after accepting
 * its socket leaves one whose client half was never handed to anyone. No
 * close frame can ever arrive for either. Refusing every reconnect
 * against such a socket locks the session out for good.
 *
 * Ownership needs peer-originated evidence, and that evidence has to
 * outlive a hibernation cycle, because isolate memory does not. Two
 * sources qualify:
 *
 *   1. `seenAt` in the socket's attachment. The attachment survives
 *      hibernation. Every inbound frame refreshes it, rate-limited to one
 *      write per STAMP_INTERVAL_MS, so a fast typist costs one attachment
 *      write per 15 s.
 *   2. `ctx.getWebSocketAutoResponseTimestamp(ws)`. The runtime answers
 *      the configured `ping` itself without waking the object, so a ping
 *      never reaches case 1 and leaves no other trace. The browser
 *      terminal does not ping — it probes with an ordinary frame, for
 *      the reasons public/s/index.html gives — so this covers the other
 *      clients rather than that one.
 *
 * A close or an error is better than either: the runtime is telling the
 * object outright that this socket is finished, so `clearShellSocketStamp`
 * drops the evidence there and the next upgrade needs no inference at all.
 *
 * A socket owns the terminal while the later of the two falls inside
 * SHELL_OWNER_LIVENESS_MS. The window has to cover the longest silence a
 * live tab can produce. Browsers throttle a background tab's timers to
 * about one tick per minute, so 120 s clears that with margin. A tab
 * quiet for longer has stopped running its own code, and the upgrade that
 * takes the terminal also closes its socket — so it redials cleanly
 * instead of holding a terminal it can no longer use.
 */
/** How long a shell socket owns the terminal after its peer was heard. */
export declare const SHELL_OWNER_LIVENESS_MS = 120000;
/** The part of `DurableObjectState` this module reads. */
export interface AutoResponseHost {
    getWebSocketAutoResponseTimestamp?(ws: WebSocket): Date | null;
}
/** Tag a freshly accepted terminal socket as this session's shell owner. */
export declare function tagShellSocket(ws: WebSocket, now?: number): void;
/**
 * Drop the evidence that a peer was on this socket.
 *
 * Called when the runtime reports the socket closed or errored. Both say
 * this socket is finished, so the next upgrade must not read a stamp the
 * dying handler wrote moments earlier and refuse the reconnect. Keeps the
 * kind, so the socket still classifies as the terminal's while it drains.
 * A peer that turns out to be alive re-stamps on its next frame.
 */
export declare function clearShellSocketStamp(ws: WebSocket): void;
/**
 * Record that the peer on this socket is still there.
 *
 * Called on every inbound shell frame. Rewrites the attachment only once
 * the recorded stamp has aged past STAMP_INTERVAL_MS. No-op on sockets
 * that carry another kind.
 */
export declare function noteShellSocketActivity(ws: WebSocket, now?: number): void;
/** True when another browser terminal currently holds this session. */
export declare function hasLiveShellOwner(ctx: AutoResponseHost | undefined, sockets: readonly WebSocket[], now?: number): boolean;
/**
 * Close the shell sockets no peer holds any more.
 *
 * Called on an upgrade that is taking the terminal. Without it, a socket
 * whose tab is gone stays accepted for the life of the object, and every
 * warm rejoin adds another one.
 */
export declare function closeStaleShellSockets(ctx: AutoResponseHost | undefined, sockets: readonly WebSocket[], now?: number): void;
//# sourceMappingURL=shell-socket.d.ts.map