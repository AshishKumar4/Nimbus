/**
 * virtual-socket-kernel.ts - shared in-facet loopback socket substrate.
 *
 * The supervisor-facing surface stays the existing PortRegistry:
 * /port/<n>/ and /preview/?port=<n> route a real Worker Request to a
 * facet's handleHttpRequest(Request). Inside the facet this kernel
 * converts that Request into an accepted HTTP/1.1 byte stream so guest
 * runtimes can implement normal socket APIs without Cloudflare inbound
 * TCP support.
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

/** Hooks the per-runtime adapter glue installs on the facet global scope. */
export interface VirtualSocketHost {
  /** Called when a new port starts listening so the adapter can register it with the supervisor. */
  __nimbusVirtualSocketDidListen?: (port: number) => void;
  /** Gives the runtime a chance to (re)create a listener before a request 502s. */
  __nimbusVirtualSocketEnsureListener?: (port: number) => unknown;
  /**
   * Cooperative accept pump. Pyodide/ruby.wasm cannot run a background
   * accept loop (JSPI suspension is only legal on this dedicated pump),
   * so the kernel queues the connection and then asks the runtime to
   * process it. Returning false rejects the queued request.
   */
  __nimbusVirtualSocketRequestQueued?: (port: number) => Promise<boolean | undefined> | boolean | undefined;
  /** Detail string surfaced when the request pump returns false. */
  __nimbusVirtualSocketLastError?: string;
}

/** Facet global scope once the kernel is installed. */
export interface VirtualSocketGlobalScope extends VirtualSocketHost {
  __nimbusVirtualSockets?: VirtualSocketKernel;
}

/** Buffer and timing bounds enforced by the kernel. */
export interface VirtualSocketKernelLimits {
  /** How long handleHttpRequest waits for a complete response before answering 504. */
  responseTimeoutMs: number;
  /** Largest request body accepted into the inbound read queue (whole-body buffered in stage 1). */
  maxRequestBodyBytes: number;
  /** Largest total response byte count accepted into the outbound write queue (whole-response buffered in stage 1). */
  maxResponseBufferBytes: number;
}

/** Result shape of accept()/acceptNow(); host/port mirror a loopback peer. */
export interface AcceptedVirtualConnection {
  id: number;
  host: string;
  port: number;
}

/** Pyodide proxies cross the FFI boundary with a toJs() converter. */
interface PyodideProxyLike {
  toJs(): unknown;
}

/** Byte payloads accepted by send(); covers JS, Pyodide, and ruby.wasm callers. */
export type VirtualSocketBytesLike =
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | readonly number[]
  | string
  | PyodideProxyLike;

/**
 * Stage 2 contract: what the kernel must grow before request/response
 * bodies can stream end-to-end instead of being fully buffered. Stage 1
 * keeps the cooperative accept model (see
 * VirtualSocketHost.__nimbusVirtualSocketRequestQueued) - it exists
 * because Pyodide JSPI can only suspend inside the dedicated pump call,
 * so these members are the seam, not a replacement for that model.
 */
export interface VirtualSocketStreamingStage2 {
  /**
   * Suspending read for request bodies streamed into the inbound queue
   * chunk-by-chunk; replaces buffering the whole request before the
   * connection is pushed to the listener. Resolves null at EOF.
   */
  recvAsync(id: number, maxBytes: number): Promise<Uint8Array | null>;
  /**
   * Write-side backpressure: resolves once queued response bytes drop
   * below the high-water mark, replacing the hard
   * maxResponseBufferBytes cap with flow control.
   */
  awaitWritable(id: number): Promise<void>;
  /**
   * Headers-first streaming Response whose body is a ReadableStream fed
   * from the outbound queue. Requires the runtime pump to interleave
   * body writes with consumer reads instead of completing one whole
   * request per __nimbusVirtualSocketRequestQueued call.
   */
  streamHttpResponse(port: number, request: Request): Promise<Response>;
}

const DEFAULT_LIMITS: VirtualSocketKernelLimits = {
  responseTimeoutMs: 30_000,
  maxRequestBodyBytes: 32 * 1024 * 1024,
  maxResponseBufferBytes: 64 * 1024 * 1024,
};

const EMPTY_BYTES = new Uint8Array(0);

class Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;

  constructor() {
    let resolve: (value: T) => void = () => {};
    let reject: (reason: Error) => void = () => {};
    this.promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.resolve = resolve;
    this.reject = reject;
  }
}

function isPyodideProxyLike(value: unknown): value is PyodideProxyLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toJs?: unknown }).toJs === 'function'
  );
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (isPyodideProxyLike(value)) return toBytes(value.toJs());
  return EMPTY_BYTES;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function responseCanHaveBody(requestMethod: string, status: number): boolean {
  if (requestMethod.toUpperCase() === 'HEAD') return false;
  return status !== 204 && status !== 205 && status !== 304;
}

/** Serialize the Worker Request into HTTP/1.1 request bytes for the guest server. */
function encodeHttpRequest(request: Request, body: Uint8Array): Uint8Array {
  const url = new URL(request.url);
  const path = (url.pathname || '/') + url.search;
  const headers = new Headers(request.headers);
  if (!headers.has('Host')) headers.set('Host', url.host || 'nimbus.local');
  if (body.byteLength > 0 && !headers.has('Content-Length')) {
    headers.set('Content-Length', String(body.byteLength));
  }
  const lines = [`${request.method} ${path} HTTP/1.1`];
  headers.forEach((value, key) => lines.push(`${key}: ${value}`));
  lines.push('', '');
  return concatBytes([new TextEncoder().encode(lines.join('\r\n')), body]);
}

/**
 * Bounded FIFO of byte chunks. One instance carries request bytes from
 * handleHttpRequest to recv() (inbound) and one carries response bytes
 * from send() to the HTTP parser (outbound). Stage 1 fills the inbound
 * queue in one shot and drains the outbound queue synchronously; the
 * async halves are declared on VirtualSocketStreamingStage2.
 */
class ByteChunkQueue {
  private readonly chunks: Uint8Array[] = [];
  private headOffset = 0;
  private enqueuedTotalBytes = 0;

  constructor(
    private readonly limitTotalBytes: number,
    private readonly overflowLabel: string,
  ) {}

  enqueue(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    if (this.enqueuedTotalBytes + bytes.byteLength > this.limitTotalBytes) {
      throw new Error(
        `Nimbus virtual socket: ${this.overflowLabel} exceeds ${this.limitTotalBytes} bytes`,
      );
    }
    this.enqueuedTotalBytes += bytes.byteLength;
    this.chunks.push(bytes);
  }

  /** Drain up to maxBytes from the head chunk; empty result means no data is queued. */
  readUpTo(maxBytes: number): Uint8Array {
    const head = this.chunks[0];
    if (!head) return EMPTY_BYTES;
    const available = head.byteLength - this.headOffset;
    const take = Math.min(available, Math.max(1, maxBytes));
    const out = head.subarray(this.headOffset, this.headOffset + take);
    this.headOffset += take;
    if (this.headOffset >= head.byteLength) {
      this.chunks.shift();
      this.headOffset = 0;
    }
    return out;
  }
}

interface ParsedHttpResponse {
  status: number;
  statusText: string;
  headerPairs: readonly [name: string, value: string][];
  body: Uint8Array | null;
}

type HttpParseOutcome =
  | { kind: 'response'; response: ParsedHttpResponse }
  | { kind: 'failed'; message: string };

type HttpBodyFraming = 'none' | 'content-length' | 'chunked' | 'until-close';

/**
 * Incremental HTTP/1.1 response parser. Consumes response bytes as the
 * guest server writes them: status line and headers first, then the body
 * under content-length, chunked, or until-close framing. Completing or
 * failing is monotonic; later input is ignored.
 */
class HttpResponseParser {
  private phase: 'headers' | 'body' | 'done' = 'headers';
  private settled: HttpParseOutcome | null = null;

  private headerBuffer: Uint8Array = EMPTY_BYTES;
  private headerScanOffset = 0;

  private status = 200;
  private statusText = '';
  private headerPairs: [string, string][] = [];

  private framing: HttpBodyFraming = 'none';
  private expectedBodyBytes = 0;
  private readonly bodyChunks: Uint8Array[] = [];
  private bodyByteCount = 0;

  private chunkState: 'size' | 'data' | 'data-end' = 'size';
  private readonly chunkSizeLine: number[] = [];
  private chunkDataRemaining = 0;

  constructor(private readonly requestMethod: string) {}

  get outcome(): HttpParseOutcome | null {
    return this.settled;
  }

  feed(chunk: Uint8Array): void {
    if (this.phase === 'done' || chunk.byteLength === 0) return;
    if (this.phase === 'headers') {
      this.feedHeaders(chunk);
      return;
    }
    this.feedBody(chunk);
  }

  /** EOF from the guest server closing the connection (or the request being torn down). */
  finish(): void {
    if (this.phase === 'done') return;
    if (this.phase === 'headers') {
      this.fail('connection closed before response headers');
      return;
    }
    if (this.framing === 'until-close') {
      this.completeWithBody(concatBytes(this.bodyChunks));
      return;
    }
    this.fail('connection closed before the response completed');
  }

  private feedHeaders(chunk: Uint8Array): void {
    this.headerBuffer = concatBytes([this.headerBuffer, chunk]);
    const headerEnd = this.findHeaderEnd();
    if (headerEnd < 0) {
      this.headerScanOffset = Math.max(0, this.headerBuffer.byteLength - 3);
      return;
    }
    this.parseHeaderBlock(this.headerBuffer.subarray(0, headerEnd));
    const leftover = this.headerBuffer.subarray(headerEnd);
    this.headerBuffer = EMPTY_BYTES;

    if (!responseCanHaveBody(this.requestMethod, this.status)) {
      this.completeWithBody(null);
      return;
    }
    const transferEncoding = this.headerValue('Transfer-Encoding');
    if (transferEncoding !== null && /chunked/i.test(transferEncoding)) {
      this.framing = 'chunked';
    } else {
      const contentLength = this.headerValue('Content-Length');
      const expected = contentLength === null ? Number.NaN : parseInt(contentLength, 10);
      if (Number.isFinite(expected) && expected >= 0) {
        this.framing = 'content-length';
        this.expectedBodyBytes = expected;
        if (expected === 0) {
          this.completeWithBody(EMPTY_BYTES);
          return;
        }
      } else {
        this.framing = 'until-close';
      }
    }
    this.phase = 'body';
    this.feedBody(leftover);
  }

  private feedBody(chunk: Uint8Array): void {
    if (this.framing === 'chunked') {
      this.feedChunkedBody(chunk);
      return;
    }
    if (chunk.byteLength === 0) return;
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

  private feedChunkedBody(chunk: Uint8Array): void {
    let i = 0;
    while (i < chunk.byteLength && this.phase === 'body') {
      if (this.chunkState === 'size') {
        const byte = chunk[i++];
        if (byte === 10) {
          const line = new TextDecoder().decode(Uint8Array.from(this.chunkSizeLine)).trim();
          this.chunkSizeLine.length = 0;
          const size = parseInt(line.split(';', 1)[0], 16);
          if (!Number.isFinite(size) || size < 0) {
            this.fail('malformed chunked response encoding');
            return;
          }
          if (size === 0) {
            this.completeWithBody(concatBytes(this.bodyChunks));
            return;
          }
          this.chunkState = 'data';
          this.chunkDataRemaining = size;
        } else if (byte !== 13) {
          this.chunkSizeLine.push(byte);
        }
      } else if (this.chunkState === 'data') {
        const take = Math.min(this.chunkDataRemaining, chunk.byteLength - i);
        this.appendBody(chunk.subarray(i, i + take));
        i += take;
        this.chunkDataRemaining -= take;
        if (this.chunkDataRemaining === 0) this.chunkState = 'data-end';
      } else {
        const byte = chunk[i++];
        if (byte === 10) {
          this.chunkState = 'size';
        } else if (byte !== 13) {
          this.fail('malformed chunked response encoding');
          return;
        }
      }
    }
  }

  private appendBody(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.bodyChunks.push(bytes);
    this.bodyByteCount += bytes.byteLength;
  }

  private findHeaderEnd(): number {
    const bytes = this.headerBuffer;
    for (let i = this.headerScanOffset; i + 3 < bytes.byteLength; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
        return i + 4;
      }
    }
    return -1;
  }

  private parseHeaderBlock(headerBytes: Uint8Array): void {
    const headerText = new TextDecoder().decode(headerBytes);
    const lines = headerText.replace(/\r\n/g, '\n').split('\n').filter((line) => line.length > 0);
    const statusLine = lines.shift() ?? 'HTTP/1.1 200 OK';
    const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
    this.status = match ? parseInt(match[1], 10) : 200;
    this.statusText = match?.[2] ?? '';
    for (const line of lines) {
      const separator = line.indexOf(':');
      if (separator <= 0) continue;
      this.headerPairs.push([line.slice(0, separator), line.slice(separator + 1).trimStart()]);
    }
  }

  private headerValue(name: string): string | null {
    const target = name.toLowerCase();
    for (const [key, value] of this.headerPairs) {
      if (key.toLowerCase() === target) return value;
    }
    return null;
  }

  private completeWithBody(body: Uint8Array | null): void {
    this.phase = 'done';
    this.settled = {
      kind: 'response',
      response: {
        status: this.status,
        statusText: this.statusText,
        headerPairs: this.headerPairs,
        body,
      },
    };
  }

  private fail(message: string): void {
    this.phase = 'done';
    this.settled = { kind: 'failed', message };
  }
}

class VirtualConnection {
  /** Request bytes the guest server reads; filled in one shot in stage 1. */
  private readonly inbound: ByteChunkQueue;
  /** Response bytes the guest server writes; drained into the parser. */
  private readonly outbound: ByteChunkQueue;
  private readonly parser: HttpResponseParser;
  private readonly responseReady = new Deferred<Response>();
  private settled = false;
  private closed = false;

  constructor(
    readonly id: number,
    requestMethod: string,
    requestBytes: Uint8Array,
    limits: VirtualSocketKernelLimits,
  ) {
    this.inbound = new ByteChunkQueue(requestBytes.byteLength, 'request buffer');
    this.inbound.enqueue(requestBytes);
    this.outbound = new ByteChunkQueue(limits.maxResponseBufferBytes, 'response buffer');
    this.parser = new HttpResponseParser(requestMethod);
  }

  read(maxBytes: number): number[] {
    return Array.from(this.inbound.readUpTo(Math.max(1, maxBytes | 0)));
  }

  write(bytesLike: VirtualSocketBytesLike): number {
    const bytes = toBytes(bytesLike);
    if (bytes.byteLength === 0 || this.settled || this.closed) return bytes.byteLength;
    // Copy once: Pyodide/ruby.wasm callers reuse their transfer buffers.
    this.outbound.enqueue(bytes.slice());
    this.pumpParser();
    return bytes.byteLength;
  }

  /** EOF from the server side (or request teardown); completes until-close bodies. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.settled) return;
    this.parser.finish();
    this.pumpParser();
  }

  /** Abort propagation: settle the pending preview request with a terminal status. */
  abort(message: string, status: number): void {
    this.closed = true;
    this.settle(new Response(`Nimbus virtual socket: ${message}`, { status }));
  }

  async response(timeoutMs: number): Promise<Response> {
    const timer = setTimeout(() => {
      this.settle(
        new Response('Nimbus virtual socket: timed out waiting for response', { status: 504 }),
      );
    }, Math.max(1, timeoutMs));
    try {
      return await this.responseReady.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  private pumpParser(): void {
    for (;;) {
      const chunk = this.outbound.readUpTo(Number.MAX_SAFE_INTEGER);
      if (chunk.byteLength === 0) break;
      this.parser.feed(chunk);
    }
    const outcome = this.parser.outcome;
    if (!outcome) return;
    if (outcome.kind === 'failed') {
      this.settle(new Response(`Nimbus virtual socket: ${outcome.message}`, { status: 502 }));
      return;
    }
    const { status, statusText, headerPairs, body } = outcome.response;
    const headers = new Headers();
    for (const [key, value] of headerPairs) {
      // The framing is consumed here; the Worker Response re-frames the body itself.
      if (/^transfer-encoding$/i.test(key)) continue;
      headers.append(key, value);
    }
    this.settle(new Response(body, { status, statusText, headers }));
  }

  private settle(response: Response): void {
    if (this.settled) return;
    this.settled = true;
    this.responseReady.resolve(response);
  }
}

class VirtualListener {
  private readonly queue: VirtualConnection[] = [];
  private readonly acceptWaiters: Deferred<VirtualConnection>[] = [];

  constructor(readonly port: number) {}

  push(conn: VirtualConnection): void {
    const waiter = this.acceptWaiters.shift();
    if (waiter) waiter.resolve(conn);
    else this.queue.push(conn);
  }

  accept(): Promise<VirtualConnection> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    const waiter = new Deferred<VirtualConnection>();
    this.acceptWaiters.push(waiter);
    return waiter.promise;
  }

  take(): VirtualConnection | null {
    return this.queue.shift() ?? null;
  }

  pending(): number {
    return this.queue.length;
  }

  drainQueued(): VirtualConnection[] {
    return this.queue.splice(0);
  }

  rejectPendingAccepts(error: Error): void {
    for (const waiter of this.acceptWaiters.splice(0)) waiter.reject(error);
  }
}

interface ReadableWaiter {
  ports: readonly number[];
  deferred: Deferred<number[]>;
  timer: ReturnType<typeof setTimeout>;
}

export class VirtualSocketKernel {
  /** Public: runner glue inspects listeners.keys() for the default preview port. */
  readonly listeners = new Map<number, VirtualListener>();
  private readonly connections = new Map<number, VirtualConnection>();
  private readonly limits: VirtualSocketKernelLimits;
  private nextConnectionId = 1;
  private nextEphemeralPort = 49152;
  private listenWaiters: Deferred<number>[] = [];
  private readonly readableWaiters = new Set<ReadableWaiter>();

  constructor(
    private readonly host: VirtualSocketHost,
    limits?: Partial<VirtualSocketKernelLimits>,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  listen(port: number): number {
    let n = Number(port);
    if (!Number.isInteger(n) || n < 0 || n >= 65536) throw new Error(`invalid port: ${port}`);
    if (n === 0) {
      while (this.listeners.has(this.nextEphemeralPort)) {
        this.nextEphemeralPort++;
        if (this.nextEphemeralPort >= 65535) this.nextEphemeralPort = 49152;
      }
      n = this.nextEphemeralPort++;
      if (this.nextEphemeralPort >= 65535) this.nextEphemeralPort = 49152;
    }
    if (!this.listeners.has(n)) {
      this.listeners.set(n, new VirtualListener(n));
      try {
        this.host.__nimbusVirtualSocketDidListen?.(n);
      } catch {}
      for (const waiter of this.listenWaiters.splice(0)) waiter.resolve(n);
    }
    return n;
  }

  closeListener(port: number): void {
    const n = Number(port);
    const listener = this.listeners.get(n);
    if (!listener) return;
    this.listeners.delete(n);
    for (const conn of listener.drainQueued()) {
      this.connections.delete(conn.id);
      conn.abort(`listener closed on port ${n}`, 502);
    }
    listener.rejectPendingAccepts(new Error(`port is not listening: ${n}`));
  }

  async accept(port: number): Promise<AcceptedVirtualConnection> {
    const listener = this.listeners.get(Number(port));
    if (!listener) throw new Error(`port is not listening: ${port}`);
    const conn = await listener.accept();
    return { id: conn.id, host: '127.0.0.1', port: 0 };
  }

  acceptNow(port: number): AcceptedVirtualConnection | null {
    const listener = this.listeners.get(Number(port));
    if (!listener) throw new Error(`port is not listening: ${port}`);
    const conn = listener.take();
    return conn ? { id: conn.id, host: '127.0.0.1', port: 0 } : null;
  }

  /** Plain number array: Pyodide bytes() and the ruby.wasm base64 bridge both consume it. */
  recv(id: number, maxBytes: number): number[] {
    const conn = this.connections.get(Number(id));
    if (!conn) return [];
    return conn.read(Number(maxBytes));
  }

  send(id: number, bytesLike: VirtualSocketBytesLike): number {
    const conn = this.connections.get(Number(id));
    if (!conn) throw new Error(`connection is closed: ${id}`);
    return conn.write(bytesLike);
  }

  close(id: number): void {
    const conn = this.connections.get(Number(id));
    if (!conn) return;
    conn.close();
    this.connections.delete(Number(id));
  }

  pending(port: number): number {
    return this.listeners.get(Number(port))?.pending() ?? 0;
  }

  firstListeningPort(): number | null {
    for (const port of this.listeners.keys()) return port;
    return null;
  }

  /** select()-style readiness: resolves ports with queued connections, [] on timeout. */
  waitReadable(ports: readonly number[], timeoutSeconds?: number | null): Promise<number[]> {
    const normalized = (Array.isArray(ports) ? ports : [])
      .map((p) => Number(p))
      .filter((p) => Number.isInteger(p));
    const readyNow = normalized.filter((port) => this.pending(port) > 0);
    if (readyNow.length > 0) return Promise.resolve(readyNow);
    const timeoutMs =
      timeoutSeconds == null
        ? this.limits.responseTimeoutMs
        : Math.max(0, Number(timeoutSeconds) * 1000);
    const deferred = new Deferred<number[]>();
    const waiter: ReadableWaiter = {
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

  async waitForListen(timeoutMs?: number): Promise<number | null> {
    const existing = this.firstListeningPort();
    if (existing) return existing;
    const waiter = new Deferred<number>();
    this.listenWaiters.push(waiter);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs ?? 5_000));
    });
    try {
      return await Promise.race([waiter.promise, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async handleHttpRequest(port: number, request: Request): Promise<Response> {
    const n = Number(port);
    let listener = this.listeners.get(n);
    if (!listener) {
      try {
        await this.host.__nimbusVirtualSocketEnsureListener?.(n);
      } catch {}
      listener = this.listeners.get(n);
    }
    if (!listener) {
      return new Response(`Nimbus virtual socket: no listener on port ${port}`, { status: 502 });
    }

    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? EMPTY_BYTES
        : new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > this.limits.maxRequestBodyBytes) {
      return new Response(
        `Nimbus virtual socket: request body exceeds ${this.limits.maxRequestBodyBytes} bytes`,
        { status: 413 },
      );
    }

    const id = this.nextConnectionId++;
    const conn = new VirtualConnection(id, request.method, encodeHttpRequest(request, body), this.limits);
    this.connections.set(id, conn);
    listener.push(conn);
    this.notifyReadable(n);

    const signal: AbortSignal | undefined = request.signal;
    const onAbort = () => conn.abort('client aborted the request', 499);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort);
    try {
      try {
        const accepted = await this.host.__nimbusVirtualSocketRequestQueued?.(n);
        if (accepted === false) {
          const detail =
            typeof this.host.__nimbusVirtualSocketLastError === 'string'
              ? this.host.__nimbusVirtualSocketLastError.trim()
              : '';
          const suffix = detail ? `: ${detail}` : '';
          return new Response(
            `Nimbus virtual socket: runtime handler did not accept the request${suffix}`,
            { status: 502 },
          );
        }
      } catch {}
      return await conn.response(this.limits.responseTimeoutMs);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      conn.close();
      this.connections.delete(id);
    }
  }

  private notifyReadable(port: number): void {
    for (const waiter of Array.from(this.readableWaiters)) {
      if (!waiter.ports.includes(port)) continue;
      const ready = waiter.ports.filter((p) => this.pending(p) > 0);
      if (ready.length === 0) continue;
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
export function installVirtualSocketKernel(
  scope: VirtualSocketGlobalScope = globalThis as VirtualSocketGlobalScope,
): VirtualSocketKernel {
  if (!scope.__nimbusVirtualSockets) {
    scope.__nimbusVirtualSockets = new VirtualSocketKernel(scope);
  }
  return scope.__nimbusVirtualSockets;
}
