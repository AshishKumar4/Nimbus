const record = (value) => typeof value === 'object' && value !== null;
const data = (value) => typeof value === 'string' || value instanceof Uint8Array;
export function isWebSocketGuestEvent(value) {
    if (!record(value) || !Number.isSafeInteger(value.id))
        return false;
    switch (value.type) {
        case 'egress-ws': return typeof value.url === 'string' && Array.isArray(value.headers)
            && value.headers.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === 'string'));
        case 'egress-ws-send': return data(value.data);
        case 'egress-ws-close': return (value.code === undefined || Number.isInteger(value.code)) && typeof value.reason === 'string';
        default: return false;
    }
}
export function isWebSocketHostEvent(value) {
    if (!record(value) || !Number.isSafeInteger(value.id))
        return false;
    switch (value.type) {
        case 'egress-ws-open': return typeof value.protocol === 'string' && typeof value.extensions === 'string';
        case 'egress-ws-message': return data(value.data);
        case 'egress-ws-closed': return Number.isInteger(value.code) && typeof value.reason === 'string' && typeof value.clean === 'boolean';
        case 'egress-ws-error': return typeof value.message === 'string';
        default: return false;
    }
}
/** The socket stays with the egress's caller; only frames and close cross the realm. */
export class RealmWebSockets {
    network;
    post;
    sockets = new Map();
    constructor(network, post) {
        this.network = network;
        this.post = post;
    }
    handle(event) {
        switch (event.type) {
            case 'egress-ws':
                this.open(event);
                return;
            case 'egress-ws-send': {
                const entry = this.sockets.get(event.id);
                if (!entry?.socket)
                    return;
                try {
                    entry.socket.send(event.data);
                }
                catch (error) {
                    this.failed(event.id, entry, error);
                }
                return;
            }
            case 'egress-ws-close':
                this.closeSocket(event.id, event.code, event.reason);
                return;
        }
    }
    open(event) {
        const entry = { abort: new AbortController() };
        this.sockets.set(event.id, entry);
        void (async () => {
            try {
                const response = await this.network.fetch(event.url, {
                    headers: event.headers.map(([name, value]) => [name, value]), redirect: 'manual', signal: entry.abort.signal,
                });
                if (response.status !== 101 || !response.webSocket) {
                    await response.body?.cancel();
                    throw new Error('Unexpected server response: ' + response.status);
                }
                const socket = response.webSocket;
                if (this.sockets.get(event.id) !== entry) {
                    socket.accept();
                    socket.close();
                    return;
                }
                entry.socket = socket;
                socket.binaryType = 'arraybuffer';
                socket.addEventListener('message', (message) => {
                    if (this.sockets.get(event.id) !== entry)
                        return;
                    const payload = typeof message.data === 'string' ? message.data : new Uint8Array(message.data);
                    this.post({ type: 'egress-ws-message', id: event.id, data: payload });
                });
                socket.addEventListener('close', (closed) => {
                    if (this.sockets.get(event.id) !== entry)
                        return;
                    this.sockets.delete(event.id);
                    this.post({ type: 'egress-ws-closed', id: event.id, code: closed.code, reason: closed.reason, clean: closed.wasClean });
                });
                socket.addEventListener('error', (error) => this.failed(event.id, entry, error));
                socket.accept();
                this.post({ type: 'egress-ws-open', id: event.id,
                    protocol: response.headers.get('sec-websocket-protocol') ?? '', extensions: response.headers.get('sec-websocket-extensions') ?? '' });
            }
            catch (error) {
                this.failed(event.id, entry, error);
            }
        })();
    }
    failed(id, entry, error) {
        if (this.sockets.get(id) !== entry)
            return;
        this.sockets.delete(id);
        entry.abort.abort();
        try {
            entry.socket?.close();
        }
        catch { /* The transport has already failed. */ }
        this.post({ type: 'egress-ws-error', id, message: error instanceof Error ? error.message : String(error) });
        this.post({ type: 'egress-ws-closed', id, code: 1006, reason: '', clean: false });
    }
    closeSocket(id, code, reason = '') {
        const entry = this.sockets.get(id);
        if (!entry)
            return;
        if (entry.socket) {
            try {
                entry.socket.close(code, reason);
            }
            catch (error) {
                this.failed(id, entry, error);
            }
        }
        else {
            this.sockets.delete(id);
            entry.abort.abort();
            this.post({ type: 'egress-ws-closed', id, code: 1006, reason: '', clean: false });
        }
    }
    close() {
        for (const [id, entry] of this.sockets) {
            this.sockets.delete(id);
            entry.abort.abort();
            try {
                entry.socket?.close();
            }
            catch { /* Already closed. */ }
        }
    }
}
