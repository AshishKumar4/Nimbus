import { EventEmitter } from './events.js';
class IncomingMessage extends EventEmitter {
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
    readable = true;
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
    setEncoding(_enc) {
        return this;
    }
    // Stream-like methods that middleware may call
    resume() {
        return this;
    }
    pause() {
        return this;
    }
    destroy() {
        this.aborted = true;
        return this;
    }
}
class ClientRequest extends EventEmitter {
    options;
    body = '';
    aborted = false;
    portRegistry;
    protocol;
    constructor(options, cb, portRegistry, protocol = 'http:') {
        super();
        this.options = options;
        this.portRegistry = portRegistry;
        this.protocol = protocol;
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
    }
    async execute() {
        if (this.aborted)
            return;
        const host = this.options.hostname || this.options.host || 'localhost';
        const port = this.options.port ? Number(this.options.port) : undefined;
        const path = this.options.path || '/';
        // Check if target is a virtual server
        if (this.portRegistry && port && (host === 'localhost' || host === '127.0.0.1')) {
            const handler = this.portRegistry.get(port);
            if (handler) {
                const vReq = {
                    method: this.options.method || 'GET',
                    url: path,
                    headers: this.options.headers || {},
                    body: this.body,
                };
                const vRes = {
                    statusCode: 200,
                    headers: {},
                    body: '',
                };
                try {
                    handler(vReq, vRes);
                    const msg = new IncomingMessage(vRes.statusCode, 'OK', vRes.headers);
                    this.emit('response', msg);
                    queueMicrotask(() => {
                        msg.emit('data', vRes.body);
                        msg.emit('end');
                    });
                }
                catch (e) {
                    this.emit('error', e);
                }
                return;
            }
        }
        // Fall through to real fetch
        const proto = this.protocol.replace(':', ''); // 'http:' -> 'http' or 'https:' -> 'https'
        const portStr = this.options.port ? `:${this.options.port}` : '';
        const url = `${proto}://${host}${portStr}${path}`;
        try {
            const resp = await fetch(url, {
                method: this.options.method || 'GET',
                headers: this.options.headers,
                body: this.options.method !== 'GET' && this.body ? this.body : undefined,
            });
            const headers = {};
            resp.headers.forEach((v, k) => { headers[k] = v; });
            const msg = new IncomingMessage(resp.status, resp.statusText, headers);
            this.emit('response', msg);
            const text = await resp.text();
            msg.emit('data', text);
            msg.emit('end');
        }
        catch (e) {
            this.emit('error', e);
        }
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
    statusMessage = 'OK';
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
        this._vRes.statusCode = this.statusCode;
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
// Symbol used to track active server promises on the http module instance
export const ACTIVE_SERVERS = Symbol.for('lifo.http.activeServers');
class Server extends EventEmitter {
    portRegistry;
    _port = null;
    _closeResolve = null;
    _promise = null;
    _activeServers;
    constructor(portRegistry, activeServers, requestHandler) {
        super();
        this.portRegistry = portRegistry;
        this._activeServers = activeServers;
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
        // Create a promise that resolves when server.close() is called
        this._promise = new Promise((resolve) => {
            this._closeResolve = resolve;
        });
        // Register the handler in portRegistry
        const handler = (vReq, vRes) => {
            const req = new IncomingMessage(0, '', vReq.headers);
            req.method = vReq.method;
            req.url = vReq.url;
            const res = new ServerResponse(vRes);
            // Attach the done promise to vRes so consumers (tunnel, curl) can await async middleware
            vRes._donePromise = res._donePromise;
            this.emit('request', req, res);
            // Emit body data + end so middleware that reads the request body works
            queueMicrotask(() => {
                if (vReq.body) {
                    req.emit('data', vReq.body);
                }
                req.complete = true;
                req.emit('end');
            });
        };
        this.portRegistry.set(port, handler);
        // Track this server
        this._activeServers.push(this);
        // Emit 'listening' event asynchronously (like Node does) and call callback
        queueMicrotask(() => {
            this.emit('listening');
            if (callback)
                callback();
        });
        return this;
    }
    close(callback) {
        if (this._port !== null) {
            this.portRegistry.delete(this._port);
        }
        // Remove from active servers list
        const idx = this._activeServers.indexOf(this);
        if (idx !== -1)
            this._activeServers.splice(idx, 1);
        if (this._closeResolve) {
            this._closeResolve();
            this._closeResolve = null;
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
    getPromise() {
        return this._promise;
    }
}
// --- Factory function ---
export function createHttp(portRegistry, protocol = 'http:') {
    // Track active servers created by this http module instance
    const activeServers = [];
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
        return new ClientRequest(options, callback, portRegistry, protocol);
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
        return new Server(portRegistry, activeServers, requestHandler);
    }
    const mod = {
        request: httpRequest,
        get: httpGet,
        createServer: httpCreateServer,
        IncomingMessage,
        ClientRequest,
        Server,
        ServerResponse,
        [ACTIVE_SERVERS]: activeServers,
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
