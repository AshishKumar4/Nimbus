/**
 * virtual-socket-kernel.ts - shared in-facet loopback socket substrate.
 *
 * The kernel has two halves, and they are mirror images of each other.
 *
 * Inbound (a guest server accepting a connection). The supervisor-facing
 * surface stays the existing PortRegistry: /port/<n>/ and
 * /preview/?port=<n> route a real Worker Request to a facet's
 * handleHttpRequest(Request). Inside the facet this kernel converts that
 * Request into an accepted HTTP/1.1 byte stream so guest runtimes can
 * implement normal socket APIs without Cloudflare inbound TCP support.
 *
 * Outbound (a guest client dialing 127.0.0.1:<port>). connect() hands back
 * a connection whose write side parses the HTTP/1.1 request the guest
 * emits, hands it to the host's loopback router - the same
 * SUPERVISOR.routeLoopback the shell's curl and node's patched fetch use -
 * and streams the Response back as HTTP/1.1 response bytes on the read
 * side. Cloudflare has no outbound TCP to 127.0.0.1, so a loopback client
 * socket can only ever be HTTP-shaped; see the connect() doc comment for
 * exactly what that does and does not support.
 *
 * Runtime adapters (Python socket.py, Ruby socket.rb, future
 * wasm32-wasi-nimbus syscalls) call this shared kernel instead of each
 * implementing their own preview bridge.
 *
 * This file is the typed source of truth. scripts/bundle-facet-workers.mjs
 * bundles it at build time into virtual-socket-kernel.generated.ts as the
 * self-contained VIRTUAL_SOCKET_KERNEL_SRC string that python-runner and
 * ruby-runner splice into dynamic worker module sources. Because that
 * bundle ships as injected source text, this module must stay free of
 * runtime imports - supervisor modules are unreachable from facet isolates.
 */
const DEFAULT_LIMITS = {
    responseTimeoutMs: 30_000,
    maxRequestBodyBytes: 32 * 1024 * 1024,
    maxResponseBufferBytes: 64 * 1024 * 1024,
};
const EMPTY_BYTES = new Uint8Array(0);
class Deferred {
    promise;
    resolve;
    reject;
    constructor() {
        let resolve = () => { };
        let reject = () => { };
        this.promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        this.resolve = resolve;
        this.reject = reject;
    }
}
function isPyodideProxyLike(value) {
    return (value !== null &&
        typeof value === 'object' &&
        typeof value.toJs === 'function');
}
function toBytes(value) {
    if (value instanceof Uint8Array)
        return value;
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    if (ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value))
        return Uint8Array.from(value);
    if (typeof value === 'string')
        return new TextEncoder().encode(value);
    if (isPyodideProxyLike(value))
        return toBytes(value.toJs());
    return EMPTY_BYTES;
}
function concatBytes(parts) {
    let length = 0;
    for (const part of parts)
        length += part.byteLength;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}
function responseCanHaveBody(requestMethod, status) {
    if (requestMethod.toUpperCase() === 'HEAD')
        return false;
    return status !== 204 && status !== 205 && status !== 304;
}
/** Serialize the Worker Request into HTTP/1.1 request bytes for the guest server. */
function encodeHttpRequest(request, body) {
    const url = new URL(request.url);
    const path = (url.pathname || '/') + url.search;
    const headers = new Headers(request.headers);
    if (!headers.has('Host'))
        headers.set('Host', url.host || 'nimbus.local');
    if (body.byteLength > 0 && !headers.has('Content-Length')) {
        headers.set('Content-Length', String(body.byteLength));
    }
    const lines = [`${request.method} ${path} HTTP/1.1`];
    headers.forEach((value, key) => lines.push(`${key}: ${value}`));
    lines.push('', '');
    return concatBytes([new TextEncoder().encode(lines.join('\r\n')), body]);
}
/**
 * Serialize a Response's head into HTTP/1.1 bytes for a guest client.
 *
 * Bodies always go out chunked rather than with a Content-Length: the
 * loopback Response may be a stream of unknown length (SSE from the AI
 * gateway, a Vite HMR channel), and chunked is the one framing that both
 * delimits the body explicitly and needs no length up front. Every
 * response also carries `Connection: close` - see LoopbackClientConnection
 * for why one connection carries exactly one exchange.
 */
function encodeHttpResponseHead(status, statusText, headers, chunkedBody) {
    const lines = [`HTTP/1.1 ${status} ${statusText}`];
    headers.forEach((value, key) => lines.push(`${key}: ${value}`));
    if (chunkedBody)
        lines.push('Transfer-Encoding: chunked');
    lines.push('Connection: close');
    lines.push('', '');
    return new TextEncoder().encode(lines.join('\r\n'));
}
function encodeChunkedFrame(bytes) {
    return concatBytes([
        new TextEncoder().encode(`${bytes.byteLength.toString(16)}\r\n`),
        bytes,
        new TextEncoder().encode('\r\n'),
    ]);
}
const CHUNKED_TERMINATOR = new TextEncoder().encode('0\r\n\r\n');
/** Response bytes buffered ahead of a slow guest reader before the body pump pauses. */
const LOOPBACK_READ_HIGH_WATER_BYTES = 1024 * 1024;
/** Largest slice `connectStream`'s readable hands to one stream read. */
const LOOPBACK_STREAM_CHUNK_BYTES = 64 * 1024;
/**
 * Bounded FIFO of byte chunks. One instance carries request bytes from
 * handleHttpRequest to recv() (inbound) and one carries response bytes
 * from send() to the HTTP parser (outbound). Stage 1 fills the inbound
 * queue in one shot and drains the outbound queue synchronously; the
 * async halves are declared on VirtualSocketStreamingStage2.
 */
class ByteChunkQueue {
    limitTotalBytes;
    overflowLabel;
    chunks = [];
    headOffset = 0;
    enqueuedTotalBytes = 0;
    undrainedBytes = 0;
    constructor(limitTotalBytes, overflowLabel) {
        this.limitTotalBytes = limitTotalBytes;
        this.overflowLabel = overflowLabel;
    }
    /** Bytes enqueued but not yet read. Drives flow control on streamed queues. */
    get pendingBytes() {
        return this.undrainedBytes;
    }
    enqueue(bytes) {
        if (bytes.byteLength === 0)
            return;
        if (this.enqueuedTotalBytes + bytes.byteLength > this.limitTotalBytes) {
            throw new Error(`Nimbus virtual socket: ${this.overflowLabel} exceeds ${this.limitTotalBytes} bytes`);
        }
        this.enqueuedTotalBytes += bytes.byteLength;
        this.undrainedBytes += bytes.byteLength;
        this.chunks.push(bytes);
    }
    /** Drain up to maxBytes from the head chunk; empty result means no data is queued. */
    readUpTo(maxBytes) {
        const head = this.chunks[0];
        if (!head)
            return EMPTY_BYTES;
        const available = head.byteLength - this.headOffset;
        const take = Math.min(available, Math.max(1, maxBytes));
        const out = head.subarray(this.headOffset, this.headOffset + take);
        this.headOffset += take;
        this.undrainedBytes -= take;
        if (this.headOffset >= head.byteLength) {
            this.chunks.shift();
            this.headOffset = 0;
        }
        return out;
    }
}
/**
 * Incremental HTTP/1.1 message parser: start line and headers first, then
 * the body under content-length, chunked, or until-close framing.
 * Completing or failing is monotonic; later input is ignored.
 *
 * Both directions of a loopback connection need exactly this - the server
 * half parses what a guest server writes, the client half parses what a
 * guest client writes - so the framing lives here once and the subclasses
 * supply only what differs: the start line and whether a body is expected.
 */
class HttpMessageParser {
    phase = 'headers';
    settled = null;
    headerBuffer = EMPTY_BYTES;
    headerScanOffset = 0;
    headerPairs = [];
    framing = 'none';
    expectedBodyBytes = 0;
    bodyChunks = [];
    bodyByteCount = 0;
    chunkState = 'size';
    chunkSizeLine = [];
    chunkDataRemaining = 0;
    get outcome() {
        return this.settled;
    }
    feed(chunk) {
        if (this.phase === 'done' || chunk.byteLength === 0)
            return;
        if (this.phase === 'headers') {
            this.feedHeaders(chunk);
            return;
        }
        this.feedBody(chunk);
    }
    /** EOF from the peer closing the connection (or the request being torn down). */
    finish() {
        if (this.phase === 'done')
            return;
        if (this.phase === 'headers') {
            this.fail(`connection closed before ${this.messageLabel} headers`);
            return;
        }
        if (this.framing === 'until-close') {
            this.completeWithBody(concatBytes(this.bodyChunks));
            return;
        }
        this.fail(`connection closed before the ${this.messageLabel} completed`);
    }
    feedHeaders(chunk) {
        this.headerBuffer = concatBytes([this.headerBuffer, chunk]);
        const headerEnd = this.findHeaderEnd();
        if (headerEnd < 0) {
            this.headerScanOffset = Math.max(0, this.headerBuffer.byteLength - 3);
            return;
        }
        const parsed = this.parseHeaderBlock(this.headerBuffer.subarray(0, headerEnd));
        const leftover = this.headerBuffer.subarray(headerEnd);
        this.headerBuffer = EMPTY_BYTES;
        if (!parsed)
            return;
        if (!this.bodyAllowed()) {
            this.completeWithBody(null);
            return;
        }
        const transferEncoding = this.headerValue('Transfer-Encoding');
        if (transferEncoding !== null && /chunked/i.test(transferEncoding)) {
            this.framing = 'chunked';
        }
        else {
            const contentLength = this.headerValue('Content-Length');
            const expected = contentLength === null ? Number.NaN : parseInt(contentLength, 10);
            if (Number.isFinite(expected) && expected >= 0) {
                this.framing = 'content-length';
                this.expectedBodyBytes = expected;
                if (expected === 0) {
                    this.completeWithBody(EMPTY_BYTES);
                    return;
                }
            }
            else {
                this.framing = this.defaultFramingWhenUnframed();
                if (this.framing === 'none') {
                    this.completeWithBody(null);
                    return;
                }
            }
        }
        this.phase = 'body';
        this.feedBody(leftover);
    }
    feedBody(chunk) {
        if (this.framing === 'chunked') {
            this.feedChunkedBody(chunk);
            return;
        }
        if (chunk.byteLength === 0)
            return;
        if (this.framing === 'content-length') {
            const needed = this.expectedBodyBytes - this.bodyByteCount;
            this.appendBody(chunk.subarray(0, Math.min(needed, chunk.byteLength)));
            if (this.bodyByteCount >= this.expectedBodyBytes) {
                this.completeWithBody(concatBytes(this.bodyChunks));
            }
            return;
        }
        this.appendBody(chunk);
    }
    feedChunkedBody(chunk) {
        let i = 0;
        while (i < chunk.byteLength && this.phase === 'body') {
            if (this.chunkState === 'size') {
                const byte = chunk[i++];
                if (byte === 10) {
                    const line = new TextDecoder().decode(Uint8Array.from(this.chunkSizeLine)).trim();
                    this.chunkSizeLine.length = 0;
                    const size = parseInt(line.split(';', 1)[0], 16);
                    if (!Number.isFinite(size) || size < 0) {
                        this.fail('malformed chunked transfer encoding');
                        return;
                    }
                    if (size === 0) {
                        this.completeWithBody(concatBytes(this.bodyChunks));
                        return;
                    }
                    this.chunkState = 'data';
                    this.chunkDataRemaining = size;
                }
                else if (byte !== 13) {
                    this.chunkSizeLine.push(byte);
                }
            }
            else if (this.chunkState === 'data') {
                const take = Math.min(this.chunkDataRemaining, chunk.byteLength - i);
                this.appendBody(chunk.subarray(i, i + take));
                i += take;
                this.chunkDataRemaining -= take;
                if (this.chunkDataRemaining === 0)
                    this.chunkState = 'data-end';
            }
            else {
                const byte = chunk[i++];
                if (byte === 10) {
                    this.chunkState = 'size';
                }
                else if (byte !== 13) {
                    this.fail('malformed chunked transfer encoding');
                    return;
                }
            }
        }
    }
    appendBody(bytes) {
        if (bytes.byteLength === 0)
            return;
        this.bodyChunks.push(bytes);
        this.bodyByteCount += bytes.byteLength;
    }
    findHeaderEnd() {
        const bytes = this.headerBuffer;
        for (let i = this.headerScanOffset; i + 3 < bytes.byteLength; i++) {
            if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
                return i + 4;
            }
        }
        return -1;
    }
    /** Returns false when the start line is malformed (the parser has already failed). */
    parseHeaderBlock(headerBytes) {
        const headerText = new TextDecoder().decode(headerBytes);
        const lines = headerText.replace(/\r\n/g, '\n').split('\n').filter((line) => line.length > 0);
        const startLine = lines.shift() ?? '';
        if (!this.parseStartLine(startLine))
            return false;
        for (const line of lines) {
            const separator = line.indexOf(':');
            if (separator <= 0)
                continue;
            this.headerPairs.push([line.slice(0, separator), line.slice(separator + 1).trimStart()]);
        }
        return true;
    }
    headerValue(name) {
        const target = name.toLowerCase();
        for (const [key, value] of this.headerPairs) {
            if (key.toLowerCase() === target)
                return value;
        }
        return null;
    }
    completeWithBody(body) {
        this.phase = 'done';
        this.settled = { kind: 'message', message: this.buildMessage(body) };
    }
    fail(message) {
        this.phase = 'done';
        this.settled = { kind: 'failed', message };
    }
}
/**
 * Parses the response a guest server writes onto an accepted connection.
 * An unframed response reads until the guest closes the connection, which
 * is how HTTP/1.0-style handlers signal end-of-body.
 */
class HttpResponseParser extends HttpMessageParser {
    requestMethod;
    status = 200;
    statusText = '';
    constructor(requestMethod) {
        super();
        this.requestMethod = requestMethod;
    }
    get messageLabel() {
        return 'response';
    }
    parseStartLine(line) {
        const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(line || 'HTTP/1.1 200 OK');
        this.status = match ? parseInt(match[1], 10) : 200;
        this.statusText = match?.[2] ?? '';
        return true;
    }
    bodyAllowed() {
        return responseCanHaveBody(this.requestMethod, this.status);
    }
    defaultFramingWhenUnframed() {
        return 'until-close';
    }
    buildMessage(body) {
        return { status: this.status, statusText: this.statusText, headerPairs: this.headerPairs, body };
    }
}
/**
 * Parses the request a guest client writes onto a loopback connection.
 * An unframed request has no body - unlike a response, a request may not
 * use connection close to delimit one, since the peer still has to reply.
 */
class HttpRequestParser extends HttpMessageParser {
    method = 'GET';
    target = '/';
    get messageLabel() {
        return 'request';
    }
    parseStartLine(line) {
        const match = /^([A-Za-z]+)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/.exec(line);
        if (!match) {
            this.fail(`malformed HTTP request line: ${JSON.stringify(line.slice(0, 120))}`);
            return false;
        }
        this.method = match[1].toUpperCase();
        this.target = match[2];
        return true;
    }
    bodyAllowed() {
        return true;
    }
    defaultFramingWhenUnframed() {
        return 'none';
    }
    buildMessage(body) {
        return { method: this.method, target: this.target, headerPairs: this.headerPairs, body };
    }
}
function errorResponse(status, message) {
    return {
        status,
        statusText: '',
        headerPairs: [['content-type', 'text/plain; charset=utf-8']],
        body: new TextEncoder().encode(`Nimbus virtual socket: ${message}`),
    };
}
function toResponse(settled) {
    const headers = new Headers();
    for (const [key, value] of settled.headerPairs)
        headers.append(key, value);
    return new Response(settled.body, {
        status: settled.status,
        statusText: settled.statusText,
        headers,
    });
}
class VirtualConnection {
    id;
    /** Request bytes the guest server reads; filled in one shot in stage 1. */
    inbound;
    /** Response bytes the guest server writes; drained into the parser. */
    outbound;
    parser;
    responseReady = new Deferred();
    settled = false;
    closed = false;
    constructor(id, requestMethod, requestBytes, limits) {
        this.id = id;
        this.inbound = new ByteChunkQueue(requestBytes.byteLength, 'request buffer');
        this.inbound.enqueue(requestBytes);
        this.outbound = new ByteChunkQueue(limits.maxResponseBufferBytes, 'response buffer');
        this.parser = new HttpResponseParser(requestMethod);
    }
    read(maxBytes) {
        return Array.from(this.inbound.readUpTo(Math.max(1, maxBytes | 0)));
    }
    /** The whole request is buffered before the connection is accepted, so nothing is ever awaited. */
    readAsync(maxBytes) {
        return Promise.resolve(this.read(maxBytes));
    }
    readBytesAsync(maxBytes) {
        return Promise.resolve(this.inbound.readUpTo(Math.max(1, maxBytes | 0)));
    }
    /** Same reason: an empty read on an accepted connection is always genuine EOF. */
    atEof() {
        return true;
    }
    write(bytesLike) {
        const bytes = toBytes(bytesLike);
        if (bytes.byteLength === 0 || this.settled || this.closed)
            return bytes.byteLength;
        // Copy once: Pyodide/ruby.wasm callers reuse their transfer buffers.
        this.outbound.enqueue(bytes.slice());
        this.pumpParser();
        return bytes.byteLength;
    }
    /** EOF from the server side (or request teardown); completes until-close bodies. */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.settled)
            return;
        this.parser.finish();
        this.pumpParser();
    }
    /** Abort propagation: settle the pending preview request with a terminal status. */
    abort(message, status) {
        this.closed = true;
        this.settle(errorResponse(status, message));
    }
    async response(timeoutMs) {
        const timer = setTimeout(() => {
            this.settle(errorResponse(504, 'timed out waiting for response'));
        }, Math.max(1, timeoutMs));
        try {
            return toResponse(await this.responseReady.promise);
        }
        finally {
            clearTimeout(timer);
        }
    }
    pumpParser() {
        for (;;) {
            const chunk = this.outbound.readUpTo(Number.MAX_SAFE_INTEGER);
            if (chunk.byteLength === 0)
                break;
            this.parser.feed(chunk);
        }
        const outcome = this.parser.outcome;
        if (!outcome)
            return;
        if (outcome.kind === 'failed') {
            this.settle(errorResponse(502, outcome.message));
            return;
        }
        const { status, statusText, headerPairs, body } = outcome.message;
        this.settle({
            status,
            statusText,
            // The framing is consumed here; the Worker Response re-frames the body itself.
            headerPairs: headerPairs.filter(([key]) => !/^transfer-encoding$/i.test(key)),
            body,
        });
    }
    settle(response) {
        if (this.settled)
            return;
        this.settled = true;
        this.responseReady.resolve(response);
    }
}
/**
 * A guest client's connection to an in-session loopback port - the mirror
 * of VirtualConnection.
 *
 * The guest writes an HTTP/1.1 request; once it parses, the kernel hands
 * the resulting Request to the host's loopback router and streams the
 * Response back as response bytes the guest reads. That is the whole of
 * it, and it is HTTP-only by construction: Cloudflare gives a Worker no
 * outbound TCP to 127.0.0.1, so the only thing a loopback client socket
 * can carry is a request/response exchange. A guest that writes a non-HTTP
 * protocol (Redis, Postgres, a bare `nc` pipe) gets a parse failure rather
 * than a silent hang.
 *
 * One connection carries exactly one exchange. Every response is marked
 * `Connection: close`, which is the signal every HTTP client understands
 * to stop reusing the socket, so pooling clients (urllib3, httpcore) open
 * a fresh connection per request instead of pipelining onto a dead one.
 */
class LoopbackClientConnection {
    id;
    port;
    route;
    limits;
    parser = new HttpRequestParser();
    /** Response bytes the guest client reads. */
    inbound = new ByteChunkQueue(Number.MAX_SAFE_INTEGER, 'loopback response buffer');
    readable = null;
    drained = null;
    dispatched = false;
    eof = false;
    closed = false;
    constructor(id, port, route, limits) {
        this.id = id;
        this.port = port;
        this.route = route;
        this.limits = limits;
    }
    write(bytesLike) {
        const bytes = toBytes(bytesLike);
        if (bytes.byteLength === 0 || this.closed)
            return bytes.byteLength;
        if (this.dispatched) {
            throw new Error(`Nimbus loopback socket: port ${this.port} answered with "Connection: close"; ` +
                'open a new connection for the next request');
        }
        // Copy once: Pyodide/ruby.wasm callers reuse their transfer buffers.
        this.parser.feed(bytes.slice());
        const outcome = this.parser.outcome;
        if (!outcome)
            return bytes.byteLength;
        this.dispatched = true;
        if (outcome.kind === 'failed')
            this.failWith(400, outcome.message);
        else
            void this.dispatch(outcome.message);
        return bytes.byteLength;
    }
    read(maxBytes) {
        return Array.from(this.readBytes(maxBytes));
    }
    /** Byte-array read. The fd-backed path uses this so a stream never round-trips through number[]. */
    readBytes(maxBytes) {
        const out = this.inbound.readUpTo(Math.max(1, maxBytes | 0));
        if (this.drained && this.inbound.pendingBytes <= LOOPBACK_READ_HIGH_WATER_BYTES) {
            const waiter = this.drained;
            this.drained = null;
            waiter.resolve();
        }
        return out;
    }
    atEof() {
        return (this.eof || this.closed) && this.inbound.pendingBytes === 0;
    }
    /** Blocks the guest until response bytes arrive; an empty result is EOF. */
    async readAsync(maxBytes) {
        return Array.from(await this.readBytesAsync(maxBytes));
    }
    async readBytesAsync(maxBytes) {
        for (;;) {
            const chunk = this.readBytes(maxBytes);
            if (chunk.byteLength > 0)
                return chunk;
            if (this.eof || this.closed)
                return EMPTY_BYTES;
            if (!this.dispatched) {
                throw new Error('Nimbus loopback socket: read before a complete HTTP request was written ' +
                    '(loopback sockets carry HTTP requests, not arbitrary byte streams)');
            }
            const waiter = (this.readable ??= new Deferred());
            await waiter.promise;
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.wakeReader();
        if (this.drained) {
            const waiter = this.drained;
            this.drained = null;
            waiter.resolve();
        }
    }
    async dispatch(parsed) {
        let request;
        try {
            request = this.buildRequest(parsed);
        }
        catch (error) {
            this.failWith(400, describeError(error));
            return;
        }
        let response;
        try {
            response = await this.withTimeout(this.route(this.port, request));
        }
        catch (error) {
            this.failWith(502, describeError(error));
            return;
        }
        await this.streamResponse(request.method, response);
    }
    buildRequest(parsed) {
        const headers = new Headers();
        let authority = `127.0.0.1:${this.port}`;
        for (const [key, value] of parsed.headerPairs) {
            if (/^host$/i.test(key)) {
                authority = value;
                continue;
            }
            // Hop-by-hop framing is re-derived by the Request itself.
            if (/^(transfer-encoding|connection|content-length|keep-alive)$/i.test(key))
                continue;
            headers.append(key, value);
        }
        const target = parsed.target.startsWith('/') ? parsed.target : `/${parsed.target}`;
        const url = /^https?:\/\//i.test(parsed.target) ? parsed.target : `http://${authority}${target}`;
        const body = parsed.body && parsed.body.byteLength > 0 ? parsed.body : null;
        const methodTakesBody = parsed.method !== 'GET' && parsed.method !== 'HEAD';
        return new Request(url, {
            method: parsed.method,
            headers,
            body: methodTakesBody ? body : null,
        });
    }
    async streamResponse(method, response) {
        const withBody = responseCanHaveBody(method, response.status) && response.body !== null;
        const headers = new Headers(response.headers);
        for (const hopByHop of ['transfer-encoding', 'content-length', 'connection', 'keep-alive']) {
            headers.delete(hopByHop);
        }
        this.pushBytes(encodeHttpResponseHead(response.status, response.statusText, headers, withBody));
        if (!withBody || !response.body) {
            this.finishStream();
            return;
        }
        const reader = response.body.getReader();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                if (this.closed)
                    return;
                const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
                if (bytes.byteLength === 0)
                    continue;
                this.pushBytes(encodeChunkedFrame(bytes));
                await this.awaitDrain();
            }
            this.pushBytes(CHUNKED_TERMINATOR);
        }
        catch {
            // A truncated body is what a real peer would deliver on a mid-stream
            // failure: stop here and let the guest see the short read.
        }
        finally {
            try {
                await reader.cancel();
            }
            catch { }
            this.finishStream();
        }
    }
    /** Synthesize a complete response so the guest sees an HTTP error, never a hang. */
    failWith(status, detail) {
        const body = new TextEncoder().encode(`Nimbus loopback socket: ${detail}`);
        const headers = new Headers({
            'content-type': 'text/plain; charset=utf-8',
            'content-length': String(body.byteLength),
        });
        this.pushBytes(encodeHttpResponseHead(status, '', headers, false));
        this.pushBytes(body);
        this.finishStream();
    }
    pushBytes(bytes) {
        if (this.closed)
            return;
        this.inbound.enqueue(bytes);
        this.wakeReader();
    }
    finishStream() {
        this.eof = true;
        this.wakeReader();
    }
    wakeReader() {
        const waiter = this.readable;
        if (!waiter)
            return;
        this.readable = null;
        waiter.resolve();
    }
    /** Pause the body pump while the guest is behind, so a big stream cannot grow unbounded. */
    awaitDrain() {
        if (this.inbound.pendingBytes <= LOOPBACK_READ_HIGH_WATER_BYTES)
            return Promise.resolve();
        return (this.drained ??= new Deferred()).promise;
    }
    withTimeout(promise) {
        let timer = null;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`port ${this.port} did not respond within ${this.limits.responseTimeoutMs}ms`)), Math.max(1, this.limits.responseTimeoutMs));
        });
        return Promise.race([promise, timeout]).finally(() => {
            if (timer !== null)
                clearTimeout(timer);
        });
    }
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
function socketStreamFor(conn) {
    return {
        // Neither direction has a handshake: an accepted connection already holds
        // the request, and a dialed one starts its exchange on the first write.
        opened: Promise.resolve(),
        readable: new ReadableStream({
            async pull(controller) {
                const bytes = await conn.readBytesAsync(LOOPBACK_STREAM_CHUNK_BYTES);
                if (bytes.byteLength === 0)
                    controller.close();
                else
                    controller.enqueue(bytes);
            },
            cancel() {
                conn.close();
            },
        }, 
        // highWaterMark 0 so the stream never pulls speculatively. A default
        // strategy pulls once at construction, which on a client connection
        // means reading before the guest has written its request.
        { highWaterMark: 0 }),
        writable: new WritableStream({
            write(chunk) {
                conn.write(chunk);
            },
            abort() {
                conn.close();
            },
        }),
        close() {
            conn.close();
            return Promise.resolve();
        },
    };
}
class VirtualListener {
    port;
    queue = [];
    acceptWaiters = [];
    constructor(port) {
        this.port = port;
    }
    push(conn) {
        const waiter = this.acceptWaiters.shift();
        if (waiter)
            waiter.resolve(conn);
        else
            this.queue.push(conn);
    }
    accept() {
        const queued = this.queue.shift();
        if (queued)
            return Promise.resolve(queued);
        const waiter = new Deferred();
        this.acceptWaiters.push(waiter);
        return waiter.promise;
    }
    take() {
        return this.queue.shift() ?? null;
    }
    pending() {
        return this.queue.length;
    }
    drainQueued() {
        return this.queue.splice(0);
    }
    rejectPendingAccepts(error) {
        for (const waiter of this.acceptWaiters.splice(0))
            waiter.reject(error);
    }
}
export class VirtualSocketKernel {
    host;
    /** Public: runner glue inspects listeners.keys() for the default preview port. */
    listeners = new Map();
    connections = new Map();
    limits;
    nextConnectionId = 1;
    nextEphemeralPort = 49152;
    listenWaiters = [];
    readableWaiters = new Set();
    constructor(host, limits) {
        this.host = host;
        this.limits = { ...DEFAULT_LIMITS, ...limits };
    }
    listen(port) {
        let n = Number(port);
        if (!Number.isInteger(n) || n < 0 || n >= 65536)
            throw new Error(`invalid port: ${port}`);
        if (n === 0) {
            while (this.listeners.has(this.nextEphemeralPort)) {
                this.nextEphemeralPort++;
                if (this.nextEphemeralPort >= 65535)
                    this.nextEphemeralPort = 49152;
            }
            n = this.nextEphemeralPort++;
            if (this.nextEphemeralPort >= 65535)
                this.nextEphemeralPort = 49152;
        }
        if (!this.listeners.has(n)) {
            this.listeners.set(n, new VirtualListener(n));
            try {
                this.host.__nimbusVirtualSocketDidListen?.(n);
            }
            catch { }
            for (const waiter of this.listenWaiters.splice(0))
                waiter.resolve(n);
        }
        return n;
    }
    closeListener(port) {
        const n = Number(port);
        const listener = this.listeners.get(n);
        if (!listener)
            return;
        this.listeners.delete(n);
        for (const conn of listener.drainQueued()) {
            this.connections.delete(conn.id);
            conn.abort(`listener closed on port ${n}`, 502);
        }
        listener.rejectPendingAccepts(new Error(`port is not listening: ${n}`));
    }
    async accept(port) {
        const listener = this.listeners.get(Number(port));
        if (!listener)
            throw new Error(`port is not listening: ${port}`);
        const conn = await listener.accept();
        return { id: conn.id, host: '127.0.0.1', port: 0 };
    }
    acceptNow(port) {
        const listener = this.listeners.get(Number(port));
        if (!listener)
            throw new Error(`port is not listening: ${port}`);
        const conn = listener.take();
        return conn ? { id: conn.id, host: '127.0.0.1', port: 0 } : null;
    }
    /**
     * Open a client connection to `port` on the session's loopback.
     *
     * The returned id is an ordinary connection id: send() writes the
     * request, recv()/recvAsync() read the response, close() releases it.
     * Only HTTP/1.1 crosses a loopback connection - see
     * LoopbackClientConnection for why - and each one carries a single
     * request/response exchange.
     */
    connect(port) {
        const conn = this.openLoopbackClient(port);
        this.connections.set(conn.id, conn);
        return conn.id;
    }
    /**
     * The same client connection as `connect`, handed back in Cloudflare's
     * `Socket` shape.
     *
     * Guests whose sockets are real WASI file descriptors (ruby.wasm, and any
     * future wasm32-wasi program) reach loopback through this: the WASI shim
     * stores it in exactly the fd slot a `cloudflare:sockets` connection would
     * occupy, so `fd_read` on an in-session port is the same suspending read as
     * `fd_read` on a remote host.
     */
    connectStream(port) {
        return socketStreamFor(this.openLoopbackClient(port));
    }
    /**
     * An already-accepted connection in the same `Socket` shape, so a server's
     * accepted socket is the same kind of file descriptor as a client's dialed
     * one. `accept`/`acceptNow` still hand out the connection id, because accept
     * itself stays on the cooperative pump - this only binds the result.
     */
    streamFor(id) {
        const conn = this.connections.get(Number(id));
        if (!conn)
            throw new Error(`connection is closed: ${id}`);
        return socketStreamFor(conn);
    }
    openLoopbackClient(port) {
        const n = Number(port);
        if (!Number.isInteger(n) || n <= 0 || n >= 65536)
            throw new Error(`invalid port: ${port}`);
        const route = this.host.__nimbusVirtualSocketRouteLoopback;
        if (typeof route !== 'function') {
            throw new Error('Nimbus loopback sockets are unavailable in this runtime');
        }
        return new LoopbackClientConnection(this.nextConnectionId++, n, route, this.limits);
    }
    /** Plain number array: Pyodide bytes() and the ruby.wasm base64 bridge both consume it. */
    recv(id, maxBytes) {
        const conn = this.connections.get(Number(id));
        if (!conn)
            return [];
        return conn.read(Number(maxBytes));
    }
    /**
     * Suspending read. A client connection has nothing to hand back until
     * the loopback response arrives, so guests that can suspend (Pyodide
     * `run_sync`, a JSPI-suspending WASI call) await this instead of
     * spinning on recv(). An empty result is EOF.
     */
    async recvAsync(id, maxBytes) {
        const conn = this.connections.get(Number(id));
        if (!conn)
            return [];
        return conn.readAsync(Number(maxBytes));
    }
    /**
     * Whether an empty recv() means end-of-response rather than "not yet".
     * Guests that poll instead of suspending (ruby.wasm, whose JS bridge is
     * synchronous) need the two apart to avoid truncating a response.
     */
    atEof(id) {
        const conn = this.connections.get(Number(id));
        return conn ? conn.atEof() : true;
    }
    send(id, bytesLike) {
        const conn = this.connections.get(Number(id));
        if (!conn)
            throw new Error(`connection is closed: ${id}`);
        return conn.write(bytesLike);
    }
    close(id) {
        const conn = this.connections.get(Number(id));
        if (!conn)
            return;
        conn.close();
        this.connections.delete(Number(id));
    }
    pending(port) {
        return this.listeners.get(Number(port))?.pending() ?? 0;
    }
    firstListeningPort() {
        for (const port of this.listeners.keys())
            return port;
        return null;
    }
    /** select()-style readiness: resolves ports with queued connections, [] on timeout. */
    waitReadable(ports, timeoutSeconds) {
        const normalized = (Array.isArray(ports) ? ports : [])
            .map((p) => Number(p))
            .filter((p) => Number.isInteger(p));
        const readyNow = normalized.filter((port) => this.pending(port) > 0);
        if (readyNow.length > 0)
            return Promise.resolve(readyNow);
        const timeoutMs = timeoutSeconds == null
            ? this.limits.responseTimeoutMs
            : Math.max(0, Number(timeoutSeconds) * 1000);
        const deferred = new Deferred();
        const waiter = {
            ports: normalized,
            deferred,
            timer: setTimeout(() => {
                this.readableWaiters.delete(waiter);
                deferred.resolve([]);
            }, timeoutMs),
        };
        this.readableWaiters.add(waiter);
        return deferred.promise;
    }
    async waitForListen(timeoutMs) {
        const existing = this.firstListeningPort();
        if (existing)
            return existing;
        const waiter = new Deferred();
        this.listenWaiters.push(waiter);
        let timer = null;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs ?? 5_000));
        });
        try {
            return await Promise.race([waiter.promise, timeout]);
        }
        finally {
            if (timer !== null)
                clearTimeout(timer);
        }
    }
    async handleHttpRequest(port, request) {
        const n = Number(port);
        let listener = this.listeners.get(n);
        if (!listener) {
            try {
                await this.host.__nimbusVirtualSocketEnsureListener?.(n);
            }
            catch { }
            listener = this.listeners.get(n);
        }
        if (!listener) {
            return new Response(`Nimbus virtual socket: no listener on port ${port}`, { status: 502 });
        }
        const body = request.method === 'GET' || request.method === 'HEAD'
            ? EMPTY_BYTES
            : new Uint8Array(await request.arrayBuffer());
        if (body.byteLength > this.limits.maxRequestBodyBytes) {
            return new Response(`Nimbus virtual socket: request body exceeds ${this.limits.maxRequestBodyBytes} bytes`, { status: 413 });
        }
        const id = this.nextConnectionId++;
        const conn = new VirtualConnection(id, request.method, encodeHttpRequest(request, body), this.limits);
        this.connections.set(id, conn);
        listener.push(conn);
        this.notifyReadable(n);
        const signal = request.signal;
        const onAbort = () => conn.abort('client aborted the request', 499);
        if (signal?.aborted)
            onAbort();
        else
            signal?.addEventListener('abort', onAbort);
        try {
            try {
                const accepted = await this.host.__nimbusVirtualSocketRequestQueued?.(n);
                if (accepted === false) {
                    const detail = typeof this.host.__nimbusVirtualSocketLastError === 'string'
                        ? this.host.__nimbusVirtualSocketLastError.trim()
                        : '';
                    const suffix = detail ? `: ${detail}` : '';
                    return new Response(`Nimbus virtual socket: runtime handler did not accept the request${suffix}`, { status: 502 });
                }
            }
            catch { }
            return await conn.response(this.limits.responseTimeoutMs);
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            conn.close();
            this.connections.delete(id);
        }
    }
    notifyReadable(port) {
        for (const waiter of Array.from(this.readableWaiters)) {
            if (!waiter.ports.includes(port))
                continue;
            const ready = waiter.ports.filter((p) => this.pending(p) > 0);
            if (ready.length === 0)
                continue;
            clearTimeout(waiter.timer);
            this.readableWaiters.delete(waiter);
            waiter.deferred.resolve(ready);
        }
    }
}
/**
 * Install the kernel on the facet global scope. The generated injection
 * bundle (VIRTUAL_SOCKET_KERNEL_SRC) is exactly this call against
 * globalThis, wrapped in an IIFE so no identifiers leak into the dynamic
 * worker module scope.
 */
export function installVirtualSocketKernel(scope = globalThis) {
    if (!scope.__nimbusVirtualSockets) {
        scope.__nimbusVirtualSockets = new VirtualSocketKernel(scope);
    }
    return scope.__nimbusVirtualSockets;
}
