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
/**
 * Per-socket inbound backlog ceiling. The supervisor's own in-flight budget is
 * 40 MiB against a 64 MiB heap; a single relayed socket may not be more than a
 * small fraction of that, because a session can hold several.
 */
export const WS_RELAY_MAX_BACKLOG_BYTES = 4 * 1024 * 1024;
/**
 * The most of a refused upgrade's body the facet is handed (an HTTP 401's
 * JSON, say): enough to read why, never a download through the relay.
 */
export const WS_RELAY_REFUSAL_BODY_MAX_BYTES = 64 * 1024;
/** How long a refused upgrade's body is read for: one held open past this is cut there. */
export const WS_RELAY_REFUSAL_BODY_MAX_MS = 30_000;
/**
 * Request headers the relay owns, never the facet's: the handshake's own
 * (the upgrade is the relay's fetch; Sec-WebSocket-Protocol is the
 * subprotocols it is given) and the hop-by-hop ones.
 */
const RELAY_OWNED_HEADERS = new Set([
    'connection', 'upgrade', 'host', 'content-length', 'transfer-encoding', 'keep-alive', 'te', 'trailer',
    'proxy-authorization', 'proxy-connection',
    'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-accept', 'sec-websocket-protocol',
]);
/** Longest a facet's poll may park before returning empty. */
const WS_RELAY_MAX_WAIT_MS = 5_000;
function eventBytes(event) {
    if (event.kind !== 'message')
        return 64;
    if (event.bytes)
        return event.bytes.byteLength;
    return event.text ? event.text.length * 2 : 0;
}
/**
 * The URL a socket's upgrade is fetched from: workerd's fetch takes http(s)
 * only ("Fetch API cannot load: wss://..."), so ws: is http: and wss: is
 * https:, the rest of the address as given. A fragment never reaches a
 * server, in a WebSocket handshake or an HTTP request.
 */
function upgradeUrl(url) {
    const target = new URL(url);
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
    target.hash = '';
    return target.href;
}
export class WebSocketRelay {
    network;
    entries = new Map();
    nextId = 1;
    /** `network`: the workspace's, whose egress opens every socket a process asks for. */
    constructor(network) {
        this.network = network;
    }
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
    async open(pid, url, protocols, requestHeaders = [], refusalBody = false) {
        const headers = new Headers();
        for (const [name, value] of requestHeaders) {
            if (!RELAY_OWNED_HEADERS.has(name.toLowerCase()))
                headers.append(name, value);
        }
        headers.set('Upgrade', 'websocket');
        if (protocols.length > 0)
            headers.set('Sec-WebSocket-Protocol', protocols.join(', '));
        const response = await this.network().fetch(upgradeUrl(url), { headers });
        const socket = response.webSocket;
        if (!socket) {
            const head = { status: response.status, statusText: response.statusText, headers: [...response.headers] };
            if (!refusalBody || response.body === null) {
                await response.body?.cancel().catch(() => { });
                return { refused: { ...head, body: null } };
            }
            const id = this.nextId++;
            const entry = { socket: null, pid, pending: [], pendingBytes: 0, waiters: [], closed: false };
            this.entries.set(id, entry);
            void this.relayRefusalBody(id, entry, response.body);
            return { refused: { ...head, body: id } };
        }
        socket.accept();
        // A binary frame as bytes: workerd's WebSocket gives a Blob by default
        // (the standard binaryType, compat date 2026-09-26, measured), which no
        // view reads, so every binary frame reached the facet empty.
        socket.binaryType = 'arraybuffer';
        const id = this.nextId++;
        const protocol = response.headers.get('sec-websocket-protocol') ?? '';
        const entry = {
            socket, pid, pending: [], pendingBytes: 0, waiters: [], closed: false,
        };
        this.entries.set(id, entry);
        socket.addEventListener('message', (event) => {
            const data = event.data;
            this.deliver(id, typeof data === 'string'
                ? { kind: 'message', text: data, bytes: null }
                : { kind: 'message', text: null, bytes: new Uint8Array(data) });
        });
        socket.addEventListener('close', (event) => {
            this.deliver(id, { kind: 'close', code: event.code, reason: event.reason });
            entry.closed = true;
        });
        socket.addEventListener('error', () => {
            this.deliver(id, { kind: 'error', message: 'websocket relay: transport error' });
            entry.closed = true;
        });
        this.deliver(id, { kind: 'open', protocol });
        return { id, protocol, headers: [...response.headers] };
    }
    /**
     * The facet's long poll. Returns whatever has arrived, or parks until
     * something does. Every event it returns is a supervisor reply, which is
     * the entire point: the facet applies its ACQUIRE before dispatching them.
     */
    async poll(pid, id, waitMs) {
        const entry = this.entryFor(pid, id);
        if (!entry)
            return [{ kind: 'close', code: 1006, reason: 'websocket relay: no such socket' }];
        if (entry.pending.length > 0)
            return this.drain(entry);
        if (entry.closed)
            return [];
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const at = entry.waiters.indexOf(waiter);
                if (at >= 0)
                    entry.waiters.splice(at, 1);
                resolve([]);
            }, Math.min(Math.max(waitMs, 0), WS_RELAY_MAX_WAIT_MS));
            const waiter = (events) => { clearTimeout(timer); resolve(events); };
            entry.waiters.push(waiter);
        });
    }
    send(pid, id, text, bytes) {
        const entry = this.entryFor(pid, id);
        if (!entry || entry.closed || entry.socket === null)
            return;
        entry.socket.send(text !== null ? text : (bytes ?? new Uint8Array(0)));
    }
    close(pid, id, code, reason) {
        const entry = this.entryFor(pid, id);
        if (!entry)
            return;
        entry.closed = true;
        entry.cancel?.();
        try {
            entry.socket?.close(code, reason);
        }
        catch { /* already gone */ }
        this.entries.delete(id);
        for (const waiter of entry.waiters.splice(0))
            waiter([]);
    }
    /** Every socket a process opened dies with it. */
    closeForPid(pid) {
        for (const [id, entry] of [...this.entries]) {
            if (entry.pid === pid)
                this.close(pid, id, 1001, 'process exited');
        }
    }
    /**
     * A refused upgrade's body, to the facet as it comes: each chunk a binary
     * message, up to WS_RELAY_REFUSAL_BODY_MAX_BYTES and for at most
     * WS_RELAY_REFUSAL_BODY_MAX_MS, then a close saying how it ended. The rest
     * is cancelled: nothing of it waits here past the bound.
     */
    async relayRefusalBody(id, entry, body) {
        const reader = body.getReader();
        entry.cancel = () => { reader.cancel().catch(() => { }); };
        let resolveLate = () => { };
        const late = new Promise((resolve) => { resolveLate = resolve; });
        const timer = setTimeout(() => resolveLate('late'), WS_RELAY_REFUSAL_BODY_MAX_MS);
        let length = 0;
        let end;
        try {
            for (;;) {
                const next = await Promise.race([reader.read(), late]);
                if (entry.closed)
                    return;
                if (next === 'late') {
                    end = { kind: 'close', code: 1001, reason: `websocket relay: the refusal's body was still open after ${WS_RELAY_REFUSAL_BODY_MAX_MS} ms` };
                    break;
                }
                if (next.done) {
                    end = { kind: 'close', code: 1000, reason: '' };
                    break;
                }
                const room = WS_RELAY_REFUSAL_BODY_MAX_BYTES - length;
                const chunk = next.value.byteLength > room ? next.value.subarray(0, room) : next.value;
                if (chunk.byteLength > 0)
                    this.deliver(id, { kind: 'message', text: null, bytes: chunk });
                length += chunk.byteLength;
                if (next.value.byteLength > room) {
                    end = { kind: 'close', code: 1009, reason: `websocket relay: the refusal's body was cut at ${WS_RELAY_REFUSAL_BODY_MAX_BYTES} bytes` };
                    break;
                }
            }
        }
        catch {
            end = { kind: 'close', code: 1006, reason: "websocket relay: the refusal's body failed" };
        }
        finally {
            clearTimeout(timer);
            reader.cancel().catch(() => { });
        }
        if (entry.closed)
            return;
        this.deliver(id, end);
        entry.closed = true;
    }
    entryFor(pid, id) {
        const entry = this.entries.get(id);
        // A socket belongs to the process that opened it. Without this a facet
        // could poll or write to another process's socket by guessing an integer.
        return entry && entry.pid === pid ? entry : undefined;
    }
    drain(entry) {
        const events = entry.pending;
        entry.pending = [];
        entry.pendingBytes = 0;
        return events;
    }
    deliver(id, event) {
        const entry = this.entries.get(id);
        if (!entry)
            return;
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
            entry.cancel?.();
            try {
                entry.socket?.close(1009, 'inbound backlog exceeded');
            }
            catch { /* already gone */ }
        }
        for (const waiter of entry.waiters.splice(0))
            waiter(this.drain(entry));
    }
}
