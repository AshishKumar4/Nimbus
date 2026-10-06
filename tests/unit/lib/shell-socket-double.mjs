// A hibernatable session WebSocket as the session's socket code sees it: a
// readyState, an attachment that survives hibernation (counted writes), what
// the runtime last auto-answered on it, and a close that records its frame.

/**
 * @param {{ kind?: string | null, readyState?: number, seenAt?: number, autoResponseAt?: number }} [options]
 *   kind null: an untagged socket (no attachment); an absent seenAt: a socket
 *   an older deploy tagged.
 */
export function socket({ kind = 'shell', readyState = WebSocket.OPEN, seenAt, autoResponseAt } = {}) {
  let attachment = kind === null ? null : (seenAt === undefined ? { kind } : { kind, seenAt });
  return {
    readyState,
    autoResponseAt: autoResponseAt ?? null,
    closedWith: null,
    writes: 0,
    deserializeAttachment: () => attachment,
    serializeAttachment(next) { attachment = next; this.writes += 1; },
    close(code, reason) { this.closedWith = { code, reason }; this.readyState = WebSocket.CLOSING; },
  };
}

/** The DO state's view of `sockets`: the runtime's auto-response timestamps. */
export function ctxFor(sockets) {
  return {
    getWebSocketAutoResponseTimestamp: (ws) => sockets.find((s) => s === ws)?.autoResponseAt ?? null,
  };
}
