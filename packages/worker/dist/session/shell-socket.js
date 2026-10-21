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
export const SHELL_OWNER_LIVENESS_MS = 120_000;
/** Smallest gap between two attachment writes on one socket. */
const STAMP_INTERVAL_MS = 15_000;
/** Tolerance for a `seenAt` that reads ahead of the current clock. */
const CLOCK_SKEW_MS = 60_000;
const SHELL_KIND = 'shell';
function readAttachment(ws) {
    try {
        const read = Reflect.get(ws, 'deserializeAttachment');
        if (typeof read !== 'function')
            return null;
        return Reflect.apply(read, ws, []);
    }
    catch {
        return null;
    }
}
function writeAttachment(ws, attachment) {
    try {
        const write = Reflect.get(ws, 'serializeAttachment');
        if (typeof write === 'function')
            Reflect.apply(write, ws, [attachment]);
    }
    catch { /* the socket is closing, or the runtime refused the write */ }
}
/**
 * Read a shell socket's stamp in one attachment pass.
 *
 * Returns null when the socket carries another kind, and a stamp of null
 * when it is a shell socket nothing has stamped yet. An attachment
 * outlives the deploy that wrote it and is untrusted on the way back, so
 * a stamp that is not a plain timestamp, or that reads further ahead than
 * the clocks can differ, counts as no stamp at all.
 */
function readShellStamp(ws, now) {
    const attachment = readAttachment(ws);
    if (typeof attachment !== 'object' || attachment === null)
        return null;
    const record = attachment;
    if (record.kind !== SHELL_KIND)
        return null;
    const terminal = typeof record.terminal === 'string' ? record.terminal : undefined;
    const seenAt = record.seenAt;
    if (typeof seenAt !== 'number' || !Number.isFinite(seenAt) || seenAt > now + CLOCK_SKEW_MS) {
        return { seenAt: null, terminal };
    }
    return { seenAt, terminal };
}
/** When the runtime last answered a ping on this socket, if it ever did. */
function autoResponseAt(ctx, ws, now) {
    // Null whenever the runtime has never auto-answered on this socket.
    const at = ctx?.getWebSocketAutoResponseTimestamp?.(ws) ?? null;
    if (!at)
        return null;
    const ms = at.getTime();
    if (!Number.isFinite(ms) || ms > now + CLOCK_SKEW_MS)
        return null;
    return ms;
}
/** True while a peer is still proven to be on this shell socket. */
function ownsTerminal(ctx, ws, stamp, now) {
    const answered = autoResponseAt(ctx, ws, now);
    const heard = stamp.seenAt === null
        ? answered
        : (answered === null ? stamp.seenAt : Math.max(stamp.seenAt, answered));
    return heard !== null && now - heard < SHELL_OWNER_LIVENESS_MS;
}
/** The open shell sockets, each with the stamp it carries. */
/** The open shell sockets of one terminal: the session's own (`terminal` undefined) or a named one. */
function openShellSockets(sockets, now, terminal) {
    const found = [];
    for (const ws of sockets) {
        if (ws.readyState !== WebSocket.OPEN)
            continue;
        const stamp = readShellStamp(ws, now);
        if (stamp && stamp.terminal === terminal)
            found.push({ ws, stamp });
    }
    return found;
}
function shellAttachment(seenAt, terminal) {
    return { kind: SHELL_KIND, ...(seenAt === undefined ? {} : { seenAt }), ...(terminal === undefined ? {} : { terminal }) };
}
/** How many terminals, the session's own and each named one, have an open shell socket among `sockets`. */
export function openTerminals(sockets, now = Date.now()) {
    const terminals = new Set();
    for (const ws of sockets) {
        if (ws.readyState !== WebSocket.OPEN)
            continue;
        const stamp = readShellStamp(ws, now);
        if (stamp)
            terminals.add(stamp.terminal);
    }
    return terminals.size;
}
/** The named terminal a shell socket is (`/ws?terminal=`): undefined for the session's own, or another socket. */
export function shellSocketTerminal(ws) {
    return readShellStamp(ws, Date.now())?.terminal;
}
/** Tag a freshly accepted terminal socket as its terminal's owner: the session's own, or the named `terminal`. */
export function tagShellSocket(ws, now = Date.now(), terminal) {
    writeAttachment(ws, shellAttachment(now, terminal));
}
/**
 * Drop the evidence that a peer was on this socket.
 *
 * Called when the runtime reports the socket closed or errored. Both say
 * this socket is finished, so the next upgrade must not read a stamp the
 * dying handler wrote moments earlier and refuse the reconnect. Keeps the
 * kind, so the socket still classifies as the terminal's while it drains.
 * A peer that turns out to be alive re-stamps on its next frame.
 */
export function clearShellSocketStamp(ws) {
    const stamp = readShellStamp(ws, Date.now());
    if (stamp === null)
        return;
    writeAttachment(ws, shellAttachment(undefined, stamp.terminal));
}
/**
 * Record that the peer on this socket is still there.
 *
 * Called on every inbound shell frame. Rewrites the attachment only once
 * the recorded stamp has aged past STAMP_INTERVAL_MS. No-op on sockets
 * that carry another kind.
 */
export function noteShellSocketActivity(ws, now = Date.now()) {
    const stamp = readShellStamp(ws, now);
    if (!stamp)
        return;
    if (stamp.seenAt !== null && now - stamp.seenAt < STAMP_INTERVAL_MS)
        return;
    writeAttachment(ws, shellAttachment(now, stamp.terminal));
}
/** True when another browser terminal currently holds this session. */
export function hasLiveShellOwner(ctx, sockets, now = Date.now(), terminal) {
    return openShellSockets(sockets, now, terminal).some(({ ws, stamp }) => ownsTerminal(ctx, ws, stamp, now));
}
/**
 * Close the shell sockets no peer holds any more.
 *
 * Called on an upgrade that is taking the terminal. Without it, a socket
 * whose tab is gone stays accepted for the life of the object, and every
 * warm rejoin adds another one.
 */
export function closeStaleShellSockets(ctx, sockets, now = Date.now(), terminal) {
    for (const { ws, stamp } of openShellSockets(sockets, now, terminal)) {
        if (ownsTerminal(ctx, ws, stamp, now))
            continue;
        try {
            ws.close(1001, 'terminal taken over');
        }
        catch { /* already closing */ }
    }
}
