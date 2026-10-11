import { isWebSocketHostEvent } from './realm-websocket.js';
/** A WebSocket's native event surface, with its transport owned by the host. */
export function routeWebSocketsThroughHost(post, waiting, nextId) {
    const sockets = new Map();
    const handlers = new WeakMap();
    class WebSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        CONNECTING = 0;
        OPEN = 1;
        CLOSING = 2;
        CLOSED = 3;
        url;
        #id;
        #state = 0;
        #protocol = '';
        #extensions = '';
        #binaryType = 'blob';
        #buffered = 0;
        #sending = Promise.resolve();
        constructor(input, protocols = []) {
            super();
            const url = new URL(String(input));
            if (url.protocol === 'http:')
                url.protocol = 'ws:';
            if (url.protocol === 'https:')
                url.protocol = 'wss:';
            if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.hash || url.username || url.password)
                throw new DOMException('Invalid WebSocket URL', 'SyntaxError');
            const offered = typeof protocols === 'string' ? [protocols] : [...protocols].map(String);
            if (new Set(offered).size !== offered.length || offered.some((protocol) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(protocol)))
                throw new DOMException('Invalid WebSocket protocols', 'SyntaxError');
            this.url = url.href;
            this.#id = nextId();
            const headers = [['Upgrade', 'websocket']];
            if (offered.length)
                headers.push(['Sec-WebSocket-Protocol', offered.join(', ')]);
            url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
            sockets.set(this.#id, (event) => this.#answer(event));
            handlers.set(this, new Map());
            waiting();
            post({ type: 'egress-ws', id: this.#id, url: url.href, headers });
        }
        get readyState() { return this.#state; }
        get protocol() { return this.#protocol; }
        get extensions() { return this.#extensions; }
        get bufferedAmount() { return this.#buffered; }
        get binaryType() { return this.#binaryType; }
        set binaryType(value) { if (value === 'blob' || value === 'arraybuffer')
            this.#binaryType = value; }
        send(value) {
            if (this.#state === 0)
                throw new DOMException('WebSocket is not open', 'InvalidStateError');
            if (this.#state !== 1)
                return;
            let payload;
            if (typeof value === 'string')
                payload = value;
            else if (value instanceof Blob)
                payload = value.arrayBuffer().then((buffer) => new Uint8Array(buffer));
            else if (ArrayBuffer.isView(value))
                payload = new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
            else
                payload = new Uint8Array(new Uint8Array(value));
            const length = typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value instanceof Blob ? value.size : value.byteLength;
            this.#buffered += length;
            this.#sending = this.#sending.then(async () => {
                const data = await payload;
                if (this.#state !== 3)
                    post({ type: 'egress-ws-send', id: this.#id, data });
                this.#buffered -= length;
            });
        }
        close(code, reason = '') {
            if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
                throw new DOMException('Invalid WebSocket close code', 'InvalidAccessError');
            if (new TextEncoder().encode(reason).byteLength > 123)
                throw new DOMException('WebSocket close reason is too long', 'SyntaxError');
            if (this.#state >= 2)
                return;
            this.#state = 2;
            this.#sending = this.#sending.then(() => { post({ type: 'egress-ws-close', id: this.#id, code, reason }); });
        }
        #answer(event) {
            switch (event.type) {
                case 'egress-ws-open':
                    if (this.#state !== 0)
                        return;
                    this.#state = 1;
                    this.#protocol = event.protocol;
                    this.#extensions = event.extensions;
                    this.dispatchEvent(new Event('open'));
                    return;
                case 'egress-ws-message': {
                    if (this.#state !== 1)
                        return;
                    const data = typeof event.data === 'string' ? event.data : this.#binaryType === 'blob'
                        ? new Blob([event.data]) : new Uint8Array(event.data).buffer;
                    this.dispatchEvent(new MessageEvent('message', { data, origin: new URL(this.url).origin }));
                    return;
                }
                case 'egress-ws-error': {
                    const error = new Event('error');
                    Object.defineProperties(error, { message: { value: event.message }, error: { value: new Error(event.message) } });
                    this.dispatchEvent(error);
                    return;
                }
                case 'egress-ws-closed': {
                    this.#state = 3;
                    sockets.delete(this.#id);
                    waiting();
                    const closed = new Event('close');
                    Object.defineProperties(closed, { code: { value: event.code }, reason: { value: event.reason }, wasClean: { value: event.clean } });
                    this.dispatchEvent(closed);
                    return;
                }
            }
        }
    }
    for (const type of ['open', 'message', 'close', 'error']) {
        Object.defineProperty(WebSocket.prototype, 'on' + type, {
            configurable: true, enumerable: true,
            get() { return handlers.get(this)?.get(type) ?? null; },
            set(listener) {
                const owned = handlers.get(this);
                const previous = owned.get(type);
                if (previous)
                    this.removeEventListener(type, previous);
                if (typeof listener === 'function') {
                    owned.set(type, listener);
                    this.addEventListener(type, listener);
                }
                else
                    owned.delete(type);
            },
        });
    }
    globalThis.WebSocket = WebSocket;
    return {
        answer(event) { if (isWebSocketHostEvent(event))
            sockets.get(event.id)?.(event); },
        get awaited() { return sockets.size; },
    };
}
