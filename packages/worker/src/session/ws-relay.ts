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
export type WsRelayEvent =
  | { kind: 'open'; protocol: string }
  | { kind: 'message'; text: string | null; bytes: Uint8Array | null }
  | { kind: 'close'; code: number; reason: string }
  | { kind: 'error'; message: string };

interface RelayEntry {
  socket: WebSocket;
  pid: number;
  pending: WsRelayEvent[];
  pendingBytes: number;
  waiters: ((events: WsRelayEvent[]) => void)[];
  closed: boolean;
}

/**
 * Per-socket inbound backlog ceiling. The supervisor's own in-flight budget is
 * 40 MiB against a 64 MiB heap; a single relayed socket may not be more than a
 * small fraction of that, because a session can hold several.
 */
export const WS_RELAY_MAX_BACKLOG_BYTES = 4 * 1024 * 1024;

/** Longest a facet's poll may park before returning empty. */
const WS_RELAY_MAX_WAIT_MS = 5_000;

function eventBytes(event: WsRelayEvent): number {
  if (event.kind !== 'message') return 64;
  if (event.bytes) return event.bytes.byteLength;
  return event.text ? event.text.length * 2 : 0;
}

export class WebSocketRelay {
  private entries = new Map<number, RelayEntry>();
  private nextId = 1;

  /**
   * Open the real socket and start buffering for the facet.
   *
   * Workers has no client `new WebSocket(url)` inside a Durable Object; the
   * upgrade is an ordinary fetch whose response carries the socket. No header
   * from the facet is forwarded — the facet supplies a URL and subprotocols
   * and nothing else, so the supervisor cannot be used to attach its own
   * ambient credentials to a request the facet chose the destination of.
   */
  async open(pid: number, url: string, protocols: string[]): Promise<{ id: number; protocol: string }> {
    const headers: Record<string, string> = { Upgrade: 'websocket' };
    if (protocols.length > 0) headers['Sec-WebSocket-Protocol'] = protocols.join(', ');
    const response = await fetch(url, { headers });
    const socket = response.webSocket;
    if (!socket) {
      throw new Error(
        `websocket relay: ${url} did not upgrade (HTTP ${response.status}); ` +
          'the supervisor terminates a facet’s sockets so inbound frames arrive through it',
      );
    }
    socket.accept();
    const id = this.nextId++;
    const protocol = response.headers.get('sec-websocket-protocol') ?? '';
    const entry: RelayEntry = {
      socket, pid, pending: [], pendingBytes: 0, waiters: [], closed: false,
    };
    this.entries.set(id, entry);
    socket.addEventListener('message', (event: MessageEvent) => {
      const data = event.data;
      this.deliver(id, typeof data === 'string'
        ? { kind: 'message', text: data, bytes: null }
        : { kind: 'message', text: null, bytes: new Uint8Array(data as ArrayBuffer) });
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      this.deliver(id, { kind: 'close', code: event.code, reason: event.reason });
      entry.closed = true;
    });
    socket.addEventListener('error', () => {
      this.deliver(id, { kind: 'error', message: 'websocket relay: transport error' });
      entry.closed = true;
    });
    this.deliver(id, { kind: 'open', protocol });
    return { id, protocol };
  }

  /**
   * The facet's long poll. Returns whatever has arrived, or parks until
   * something does. Every event it returns is a supervisor reply, which is
   * the entire point: the facet applies its ACQUIRE before dispatching them.
   */
  async poll(pid: number, id: number, waitMs: number): Promise<WsRelayEvent[]> {
    const entry = this.entryFor(pid, id);
    if (!entry) return [{ kind: 'close', code: 1006, reason: 'websocket relay: no such socket' }];
    if (entry.pending.length > 0) return this.drain(entry);
    if (entry.closed) return [];
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const at = entry.waiters.indexOf(waiter);
        if (at >= 0) entry.waiters.splice(at, 1);
        resolve([]);
      }, Math.min(Math.max(waitMs, 0), WS_RELAY_MAX_WAIT_MS));
      const waiter = (events: WsRelayEvent[]) => { clearTimeout(timer); resolve(events); };
      entry.waiters.push(waiter);
    });
  }

  send(pid: number, id: number, text: string | null, bytes: Uint8Array | null): void {
    const entry = this.entryFor(pid, id);
    if (!entry || entry.closed) return;
    entry.socket.send(text !== null ? text : (bytes ?? new Uint8Array(0)));
  }

  close(pid: number, id: number, code?: number, reason?: string): void {
    const entry = this.entryFor(pid, id);
    if (!entry) return;
    entry.closed = true;
    try { entry.socket.close(code, reason); } catch { /* already gone */ }
    this.entries.delete(id);
    for (const waiter of entry.waiters.splice(0)) waiter([]);
  }

  /** Every socket a process opened dies with it. */
  closeForPid(pid: number): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.pid === pid) this.close(pid, id, 1001, 'process exited');
    }
  }

  private entryFor(pid: number, id: number): RelayEntry | undefined {
    const entry = this.entries.get(id);
    // A socket belongs to the process that opened it. Without this a facet
    // could poll or write to another process's socket by guessing an integer.
    return entry && entry.pid === pid ? entry : undefined;
  }

  private drain(entry: RelayEntry): WsRelayEvent[] {
    const events = entry.pending;
    entry.pending = [];
    entry.pendingBytes = 0;
    return events;
  }

  private deliver(id: number, event: WsRelayEvent): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.pendingBytes += eventBytes(event);
    entry.pending.push(event);
    if (entry.pendingBytes > WS_RELAY_MAX_BACKLOG_BYTES) {
      // Naming the limit is the whole value of having one. A dropped frame
      // with no explanation is indistinguishable from a peer that went quiet.
      entry.pending.push({
        kind: 'close',
        code: 1009,
        reason: `websocket relay: ${WS_RELAY_MAX_BACKLOG_BYTES} byte inbound backlog exceeded ` +
          'while the process was not reading; the socket was closed rather than dropping frames',
      });
      entry.closed = true;
      try { entry.socket.close(1009, 'inbound backlog exceeded'); } catch { /* already gone */ }
    }
    for (const waiter of entry.waiters.splice(0)) waiter(this.drain(entry));
  }
}
