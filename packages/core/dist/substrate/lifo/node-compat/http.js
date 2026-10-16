import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { isLoopbackHost, } from '../kernel/index.js';
import { awaitServedEnd, routeToLoopback, serveFromPort, servedBody, servedReason, statusText } from '../kernel/local-serve.js';
/** A request a server is given, or a response a client is: a Readable of its body, as Node's. */
class IncomingMessage extends Readable {
    statusCode;
    statusMessage;
    headers;
    method;
    url;
    httpVersion = '1.1';
    httpVersionMajor = 1;
    httpVersionMinor = 1;
    complete = false;
    aborted = false;
    // Minimal socket stub that Vite/Connect middleware expects
    socket;
    connection;
    constructor(statusCode, statusMessage, headers) {
        super();
        this.statusCode = statusCode;
        this.statusMessage = statusMessage;
        this.headers = headers;
        const socketStub = {
            remoteAddress: '127.0.0.1',
            remotePort: 0,
            encrypted: false,
            destroy: () => { },
        };
        this.socket = socketStub;
        this.connection = socketStub;
    }
    _read() { }
    // As Node's: ended before its body was read and complete, it was aborted;
    // the error it is destroyed with is told only to a listener for it.
    _destroy(error, callback) {
        if (!this.readableEnded || !this.complete) {
            this.aborted = true;
            this.emit('aborted');
        }
        process.nextTick(() => callback(this.listenerCount('error') === 0 ? null : error));
    }
    /** Its body, then its end. */
    deliver(body) {
        if (body)
            this.push(Buffer.from(body));
        this.complete = true;
        this.push(null);
    }
}
class ClientRequest extends EventEmitter {
    options;
    body = '';
    aborted = false;
    /** What abort() ends: the wait for a local server's answer among it. Made when a wait needs it. */
    abortController = null;
    portRegistry;
    routeLoopback;
    protocol;
    constructor(options, cb, portRegistry, protocol = 'http:', routeLoopback) {
        super();
        this.options = options;
        this.portRegistry = portRegistry;
        this.protocol = protocol;
        this.routeLoopback = routeLoopback;
        if (cb)
            this.on('response', cb);
        // Defer the actual fetch
        queueMicrotask(() => this.execute());
    }
    write(data) {
        this.body += data;
    }
    end(data) {
        if (data)
            this.body += data;
    }
    abort() {
        this.aborted = true;
        this.abortController?.abort();
    }
    /** This request's signal, which abort() aborts. */
    signal() {
        if (this.abortController === null) {
            this.abortController = new AbortController();
            if (this.aborted)
                this.abortController.abort();
        }
        return this.abortController.signal;
    }
    async execute() {
        if (this.aborted)
            return;
        const host = this.options.hostname || this.options.host || 'localhost';
        const port = this.options.port ? Number(this.options.port) : (this.protocol === 'http:' ? 80 : 443);
        const path = this.options.path || '/';
        const loopback = isLoopbackHost(host);
        // A loopback request is served as the workspace serves its own: a server
        // of this program's (once its handler has ended the response), else the
        // host's loopback router.
        if (loopback) {
            const method = this.options.method || 'GET';
            const hasBody = method !== 'GET' && method !== 'HEAD' && this.body.length > 0;
            const handler = this.portRegistry?.get(port);
            try {
                if (handler) {
                    // As Node gives them to a server: header names lower-cased.
                    const headers = {};
                    const given = this.options.headers;
                    if (given)
                        for (const name of Object.keys(given))
                            headers[name.toLowerCase()] = String(given[name]);
                    // Node's HTTP carries a GET's body too: only a Fetch Request (below) may not.
                    const served = serveFromPort(handler, { method, url: path, headers, body: this.body });
                    if (served === null) {
                        this.failed('refused', host, port);
                        return;
                    }
                    // Aborted while its server answered (its handler can reach it): nothing more is said.
                    if (this.aborted)
                        return;
                    const ended = served._donePromise === undefined ? 'ended' : await awaitServedEnd(served._donePromise, this.signal());
                    if (ended !== 'ended') {
                        this.failed(ended, host, port);
                        return;
                    }
                    // The server's answer, as this request's: its status and reason, its headers, then its body and end.
                    const msg = new IncomingMessage(served.statusCode, servedReason(served), served.headers);
                    this.emit('response', msg);
                    msg.deliver(servedBody(served));
                    return;
                }
                if (!this.routeLoopback) {
                    this.failed('refused', host, port);
                    return;
                }
                const result = await routeToLoopback(this.routeLoopback, port, new Request(`${this.protocol}//${host}:${port}${path}`, {
                    method,
                    headers: this.options.headers,
                    body: hasBody ? this.body : undefined,
                    signal: this.signal(),
                }));
                if (result.kind === 'response')
                    await this.answer(result.response);
                else
                    this.failed(result.kind, host, port);
            }
            catch (error) {
                this.emit('error', error);
            }
            return;
        }
        // Fall through to real fetch
        const proto = this.protocol.replace(':', ''); // 'http:' -> 'http' or 'https:' -> 'https'
        const portStr = this.options.port ? `:${this.options.port}` : '';
        const url = `${proto}://${host}${portStr}${path}`;
        try {
            await this.answer(await fetch(url, {
                method: this.options.method || 'GET',
                headers: this.options.headers,
                body: this.options.method !== 'GET' && this.body ? this.body : undefined,
            }));
        }
        catch (e) {
            this.emit('error', e);
        }
    }
    /** A local hop that got no response: nothing for an abort; the connection's error otherwise. */
    failed(kind, host, port) {
        if (kind === 'refused')
            this.emit('error', new Error(`connect ECONNREFUSED ${host}:${port}`));
        else if (kind === 'timeout')
            this.emit('error', new Error(`connect ETIMEDOUT ${host}:${port}`));
    }
    /** `response` as this request's: its status, reason and headers, then its body and end. */
    async answer(response) {
        const headers = {};
        response.headers.forEach((value, key) => { headers[key] = value; });
        const msg = new IncomingMessage(response.status, response.statusText, headers);
        this.emit('response', msg);
        msg.deliver(await response.text());
    }
    setTimeout(_ms, cb) {
        if (cb)
            this.on('timeout', cb);
        return this;
    }
}
// --- ServerResponse class ---
class ServerResponse extends EventEmitter {
    statusCode = 200;
    /** Its reason phrase: unset until writeHead names one or end() gives its status's, as Node's. */
    statusMessage = undefined;
    headersSent = false;
    finished = false;
    writableEnded = false;
    writableFinished = false;
    _headers = {};
    _body = '';
    _vRes;
    // Minimal socket stub that middleware may reference
    socket;
    // Promise that resolves when end() is called (for async middleware)
    _donePromise;
    _doneResolve;
    constructor(vRes) {
        super();
        this._vRes = vRes;
        this._donePromise = new Promise((resolve) => {
            this._doneResolve = resolve;
        });
        // Socket stub that resolves _donePromise on destroy (error abort path)
        this.socket = {
            writable: true,
            readable: true,
            remoteAddress: '127.0.0.1',
            destroy: () => {
                this.socket.writable = false;
                if (!this.finished) {
                    this._vRes.statusCode = this.statusCode || 500;
                    this._vRes.headers = {};
                    this._vRes.body = '';
                    this.finished = true;
                    this._doneResolve();
                }
            },
        };
    }
    writeHead(statusCode, reasonOrHeaders, headers) {
        this.statusCode = statusCode;
        let h;
        if (typeof reasonOrHeaders === 'string') {
            this.statusMessage = reasonOrHeaders;
            h = headers;
        }
        else {
            h = reasonOrHeaders;
        }
        if (h) {
            for (const [k, v] of Object.entries(h)) {
                this._headers[k.toLowerCase()] = v;
            }
        }
        this.headersSent = true;
        return this;
    }
    setHeader(name, value) {
        this._headers[name.toLowerCase()] = value;
        return this;
    }
    getHeader(name) {
        return this._headers[name.toLowerCase()];
    }
    getHeaders() {
        return { ...this._headers };
    }
    getHeaderNames() {
        return Object.keys(this._headers);
    }
    hasHeader(name) {
        return name.toLowerCase() in this._headers;
    }
    removeHeader(name) {
        delete this._headers[name.toLowerCase()];
    }
    appendHeader(name, value) {
        const key = name.toLowerCase();
        const existing = this._headers[key];
        if (existing === undefined) {
            this._headers[key] = value;
        }
        else if (Array.isArray(existing)) {
            this._headers[key] = existing.concat(value);
        }
        else {
            this._headers[key] = Array.isArray(value) ? [existing, ...value] : [existing, value];
        }
        return this;
    }
    flushHeaders() {
        this.headersSent = true;
    }
    write(data) {
        if (typeof data === 'string') {
            this._body += data;
        }
        else {
            this._body += new TextDecoder().decode(data);
        }
        return true;
    }
    end(data, _encoding, cb) {
        if (typeof data === 'function') {
            cb = data;
            data = undefined;
        }
        if (typeof data === 'string') {
            this._body += data;
        }
        else if (data instanceof Uint8Array) {
            this._body += new TextDecoder().decode(data);
        }
        this.finished = true;
        this.writableEnded = true;
        this.writableFinished = true;
        // Flatten header arrays to comma-separated strings for the virtual response
        const flatHeaders = {};
        for (const [k, v] of Object.entries(this._headers)) {
            flatHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        // Flush to virtual response
        this.statusMessage ||= statusText(this.statusCode);
        this._vRes.statusCode = this.statusCode;
        this._vRes.statusMessage = this.statusMessage;
        this._vRes.headers = flatHeaders;
        this._vRes.body = this._body;
        this.headersSent = true;
        this.emit('finish');
        this._doneResolve();
        if (cb)
            cb();
    }
    // Cork/uncork stubs (used by some frameworks)
    cork() { }
    uncork() { }
}
// --- Server class ---
/**
 * A server listens by holding its port in the registry; that is all that
 * keeps it, and the process it runs in, alive (the realm's event loop counts
 * listening ports: commands/system/node-guest.ts).
 */
class Server extends EventEmitter {
    portRegistry;
    _port = null;
    constructor(portRegistry, requestHandler) {
        super();
        this.portRegistry = portRegistry;
        if (requestHandler) {
            this.on('request', requestHandler);
        }
    }
    listen(port, ...rest) {
        let callback;
        for (const arg of rest) {
            if (typeof arg === 'function') {
                callback = arg;
                break;
            }
        }
        this._port = port;
        // Register the handler in portRegistry
        const handler = (vReq, vRes) => {
            const req = new IncomingMessage(0, '', vReq.headers);
            req.method = vReq.method;
            req.url = vReq.url;
            const res = new ServerResponse(vRes);
            this.emit('request', req, res);
            // A handler that has not ended the response yet (a timer, an await, async
            // middleware) is waited for: whoever serves the request awaits this.
            if (!res.finished)
                vRes._donePromise = res._donePromise;
            req.deliver(vReq.body ?? null);
        };
        this.portRegistry.set(port, handler);
        // 'listening' is emitted asynchronously, as Node emits it; a callback is one of its listeners, the server its this.
        if (callback)
            this.once('listening', callback);
        queueMicrotask(() => this.emit('listening'));
        return this;
    }
    close(callback) {
        if (this._port !== null) {
            this.portRegistry.delete(this._port);
            this._port = null;
        }
        if (callback) {
            queueMicrotask(callback);
        }
        this.emit('close');
        return this;
    }
    address() {
        if (this._port === null)
            return null;
        return { port: this._port, address: '127.0.0.1', family: 'IPv4' };
    }
}
// --- Factory function ---
export function createHttp(portRegistry, protocol = 'http:', routeLoopback) {
    // Track active servers created by this http module instance
    function httpRequest(urlOrOptions, optionsOrCb, cb) {
        let options;
        let callback;
        if (typeof urlOrOptions === 'string') {
            const u = new URL(urlOrOptions);
            options = {
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                method: 'GET',
            };
            if (typeof optionsOrCb === 'function') {
                callback = optionsOrCb;
            }
            else {
                options = { ...options, ...optionsOrCb };
                callback = cb;
            }
        }
        else {
            options = urlOrOptions;
            callback = optionsOrCb;
        }
        return new ClientRequest(options, callback, portRegistry, protocol, routeLoopback);
    }
    function httpGet(urlOrOptions, optionsOrCb, cb) {
        const req = httpRequest(urlOrOptions, optionsOrCb, cb);
        req.end();
        return req;
    }
    function httpCreateServer(requestHandler) {
        if (!portRegistry) {
            throw new Error('http.createServer() is not supported in Lifo');
        }
        return new Server(portRegistry, requestHandler);
    }
    const mod = {
        request: httpRequest,
        get: httpGet,
        createServer: httpCreateServer,
        IncomingMessage,
        ClientRequest,
        Server,
        ServerResponse,
    };
    return mod;
}
// --- Legacy static exports (for backward compatibility) ---
export function request(urlOrOptions, optionsOrCb, cb) {
    return createHttp().request(urlOrOptions, optionsOrCb, cb);
}
export function get(urlOrOptions, optionsOrCb, cb) {
    return createHttp().get(urlOrOptions, optionsOrCb, cb);
}
export function createServer() {
    throw new Error('http.createServer() is not supported in Lifo');
}
export default { request, get, createServer, IncomingMessage, ClientRequest };
