/**
 * port-registry.ts — Maps virtual ports to facet stubs.
 *
 * When a facet calls http.createServer().listen(3000), it notifies the
 * supervisor via SupervisorRPC.registerPort(3000). The supervisor stores
 * the facet stub here. When the DO receives a request to /port/3000/*,
 * it looks up the facet and forwards the request.
 *
 * Transport (audit C2):
 *   The proxy forwards a real Request and returns a real Response.
 *   Workers RPC natively transfers Request/Response values between
 *   isolates with streaming bodies and flow control (they are NOT
 *   structured-cloneable — RPC has its own transfer mechanism for
 *   these types). Binary payloads (images, wasm, gzip, multipart
 *   uploads, audio/video) go through byte-for-byte with no UTF-8
 *   coercion or JSON envelope anywhere in the path.
 *
 *   Facet contract for handleHttpRequest:
 *     async handleHttpRequest(request: Request): Promise<Response>
 *
 *   where `request.url` is the inner URL the user's HTTP server
 *   expects (pathname + search, absolute against a synthetic origin),
 *   `request.method` and application headers mirror the outer request,
 *   Nimbus credentials/internal headers are removed, and
 *   `request.body` is a ReadableStream (or null for GET/HEAD) that
 *   the facet can consume once. The returned Response is streamed
 *   straight back, with one normalization: the hop speaks identity,
 *   so a compressed body is decoded here. See `decodeContentCoding`.
 */

import { sanitizeUntrustedHeaders } from '../_shared/untrusted-request.js';
import type { RouteableFacetTarget } from './os-contracts.js';

export interface PortEntry {
  port: number;
  pid: number;
  /**
   * Facet stub exposing `handleHttpRequest(Request): Promise<Response>`.
   * May be null when a facet has reserved a port but not yet wired up
   * the request handler (see _rpcRegisterPort in nimbus-session.ts).
   */
  facetStub: RouteableFacetTarget | null;
  registeredAt: number;
  /**
   * Unguessable token for the lifetime of THIS registration, so an embedder
   * can hand out one port's traffic without handing out the session. A fresh
   * one per `register`, which is what makes an unexposed port stay unexposed.
   */
  capability: string;
}

/**
 * Content codings this hop can undo. `DecompressionStream` decodes exactly
 * these; brotli and zstd have no decoder in the runtime, so a body in one of
 * those cannot be repaired here.
 */
const DECODABLE_CONTENT_CODINGS = new Map<string, 'gzip' | 'deflate'>([
  ['gzip', 'gzip'],
  ['x-gzip', 'gzip'],
  ['deflate', 'deflate'],
]);

/**
 * Hand back a port target's response with its bytes and its headers in
 * agreement.
 *
 * A `Response` a facet builds always holds an identity body. The runtime
 * treats the bytes a `Response` is constructed from as unencoded and runs its
 * own content negotiation on the way out: it drops a `Content-Encoding` the
 * client did not ask for, and compresses again when the client did. Either
 * way a guest server's `Content-Encoding` is a label with nothing behind it,
 * and the browser renders compressed bytes as text.
 *
 * The forwarded request asks the target for `identity`, so this decode covers
 * the server that compresses whatever the client said. A coding with no
 * decoder answers 502: an honest failure beats a page of mojibake.
 */
function decodeContentCoding(response: Response, port: number): Response {
  const coding = response.headers.get('Content-Encoding')?.trim().toLowerCase();
  if (!coding || coding === 'identity' || response.body === null) return response;

  const format = DECODABLE_CONTENT_CODINGS.get(coding);
  if (!format) {
    void response.body.cancel().catch(() => {});
    return new Response(
      JSON.stringify({
        error: `port proxy: target answered Content-Encoding "${coding}", which this hop cannot decode`,
        port,
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const headers = new Headers(response.headers);
  headers.delete('Content-Encoding');
  // The decoded body has a different length; the Response re-derives it.
  headers.delete('Content-Length');
  return new Response(response.body.pipeThrough(new DecompressionStream(format)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createPortCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class PortRegistry {
  private ports = new Map<number, PortEntry>();
  private facetStubsByPid = new Map<number, RouteableFacetTarget>();
  private portWaitersByPid = new Map<number, Set<() => void>>();

  /** Remember the available facet capabilities for a running process. */
  bindFacetStub(pid: number, facetStub: unknown): void {
    const target = routeableFacetTarget(facetStub);
    if (!target) return;
    this.facetStubsByPid.set(pid, target);
    this.attachFacetStubByPid(pid, target);
    this.notifyPortWaiters(pid);
  }

  /**
   * Register a process as listening on a port. The route target comes from
   * the pid's binding — one target per process, owned by whoever started it —
   * so a port announced by the facet itself and one reserved by the spawn
   * resolve to the same handler.
   */
  register(port: number, pid: number): void {
    const target = this.facetStubsByPid.get(pid) ?? null;
    this.ports.set(port, {
      port,
      pid,
      facetStub: target,
      registeredAt: Date.now(),
      capability: createPortCapability(),
    });
    this.notifyPortWaiters(pid);
  }

  /** Unregister a port. */
  unregister(port: number): boolean {
    return this.ports.delete(port);
  }

  /** Unregister all ports owned by a specific PID. */
  unregisterByPid(pid: number): number {
    let count = 0;
    for (const [port, entry] of this.ports) {
      if (entry.pid === pid) {
        this.ports.delete(port);
        count++;
      }
    }
    this.facetStubsByPid.delete(pid);
    return count;
  }

  /** Look up a port entry. */
  get(port: number): PortEntry | undefined {
    return this.ports.get(port);
  }

  /** Attach a normalized route target to ports previously reserved by a PID. */
  private attachFacetStubByPid(pid: number, target: RouteableFacetTarget): number[] {
    const ports: number[] = [];
    for (const entry of this.ports.values()) {
      if (entry.pid !== pid || entry.facetStub) continue;
      entry.facetStub = target;
      ports.push(entry.port);
    }
    if (ports.length > 0) this.notifyPortWaiters(pid);
    return ports;
  }

  getRouteablePortsByPid(pid: number): number[] {
    return [...this.ports.values()]
      .filter((entry) => entry.pid === pid && entry.facetStub)
      .map((entry) => entry.port);
  }

  async waitForRouteablePortsByPid(pid: number, timeoutMs: number): Promise<number[]> {
    const immediate = this.getRouteablePortsByPid(pid);
    if (immediate.length > 0) return immediate;
    await this.waitForPidPortChange(pid, timeoutMs);
    return this.getRouteablePortsByPid(pid);
  }

  /** Check if a port is registered. */
  has(port: number): boolean {
    return this.ports.has(port);
  }

  /** Get all registered ports. */
  getAll(): PortEntry[] {
    return [...this.ports.values()];
  }

  /** Answer only whether this capability matches, never what is registered. */
  hasCapability(port: number, capability: string): boolean {
    return this.ports.get(port)?.capability === capability;
  }

  /**
   * Re-adopt a capability the embedder was already handed, after the supervisor
   * was rebuilt. A restored dev server is a NEW registration with a new token,
   * which would silently invalidate every preview URL already in circulation
   * across an eviction — so the durable value wins over the fresh one.
   */
  restoreCapability(port: number, capability: string): boolean {
    const entry = this.ports.get(port);
    if (!entry || !/^[a-f0-9]{24}$/.test(capability)) return false;
    entry.capability = capability;
    return true;
  }

  /**
   * Forward an HTTP request to the facet owning a port.
   *
   * Returns null if no facet is listening on this port (or if a port
   * is registered but its stub is not yet attached — see PortEntry).
   *
   * The Request passed to the facet has a rewritten URL whose pathname
   * is the inner path (without the `/port/<n>` prefix) and whose origin
   * matches the outer request, so user code reading `request.url`
   * sees a URL shape consistent with "my server is running at this
   * port". Application headers and the body are forwarded; Nimbus
   * credentials and internal routing headers are removed before crossing
   * the user-code trust boundary. The body remains a ReadableStream so
   * binary payloads aren't materialised in memory.
   *
   * Binary safety: Workers RPC transfers Request/Response values with
   * their streaming bodies; it does not structured-clone them. No UTF-8
   * round-trip occurs anywhere.
   * A user-facet serving a PNG will return the exact same bytes the
   * client receives.
   */
  async routeRequest(port: number, request: Request, pathname: string): Promise<Response | null> {
    return this.routeRequestInternal(port, request, pathname, false);
  }

  /**
   * Route a request a trusted embedder has already authenticated against the
   * port's capability and stripped its own credentials from.
   *
   * Unlike the generic route, this one PRESERVES `Authorization`. The generic
   * route strips it because the header it sees is Nimbus's own, and handing a
   * session credential to untrusted code is the thing that must never happen.
   * Here the embedder has removed that credential already and what remains
   * belongs to the guest application, which needs it to authenticate its own
   * users.
   */
  async routeCapabilityRequest(
    port: number,
    capability: string,
    request: Request,
    pathname: string,
  ): Promise<Response | null> {
    if (!this.hasCapability(port, capability)) return null;
    return this.routeRequestInternal(port, request, pathname, true);
  }

  private async routeRequestInternal(
    port: number,
    request: Request,
    pathname: string,
    preserveAuthorization: boolean,
  ): Promise<Response | null> {
    const entry = this.ports.get(port);
    // Honour the documented contract: no entry at all → null, so callers
    // report "no process listening". (Pre-fix this fell into the 501 below,
    // which mislabelled a wiped/unregistered port as a half-registered one.)
    if (!entry) return null;
    // Some short-lived/foreground paths can reserve a port through
    // SupervisorRPC.registerPort before a routeable WorkerEntrypoint
    // exists. Explicit long-running processes (for example
    // `node --watch server.js`) register a non-null facet stub and route
    // below. For a null-stub reservation, return an honest 501 instead
    // of a misleading "no process listening" 502.
    if (!entry.facetStub) {
      return new Response(
        JSON.stringify({
          error: 'port is registered but has no routeable facet handler',
          port,
        }),
        {
          status: 501,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    try {
      const outerUrl = new URL(request.url);
      // Preserve query; replace the pathname with the inner path so
      // the user's HTTP server sees its own URL shape. (Fragments
      // never make it onto the wire, so there's nothing to forward.)
      const innerUrl = new URL(pathname + outerUrl.search, outerUrl.origin);

      // Rebuild a Request targeting the inner URL. Body is forwarded as
      // a stream — we do NOT await `.text()`/`.arrayBuffer()`, which
      // would corrupt any binary payload and block large uploads.
      //
      // Construct via (url, init) so we can override the URL while
      // inheriting method/headers/body from the original. For GET/HEAD
      // we must omit `body` entirely — the Request constructor throws
      // if a body is supplied on those methods.
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      const headers = new Headers(request.headers);
      // The strip below removes Nimbus's own credentials. On a capability
      // route the embedder has already removed those, so what is left belongs
      // to the guest application and has to survive the hop.
      const authorization = preserveAuthorization ? headers.get('authorization') : null;
      sanitizeUntrustedHeaders(headers);
      if (authorization) headers.set('authorization', authorization);

      headers.set('X-Nimbus-Port', String(port));
      // A Response cannot carry an encoded body across this hop, so the
      // target is asked for the one coding that survives it. See
      // `decodeContentCoding` for the server that compresses anyway.
      headers.set('Accept-Encoding', 'identity');
      // `duplex: 'half'` is required by workerd when body is a
      // ReadableStream — otherwise `new Request(…)` throws. It's not
      // part of the published @cloudflare/workers-types RequestInit,
      // so extend the type locally rather than casting the whole
      // init — that keeps typos in other fields caught by the compiler.
      const init: RequestInit & { duplex?: 'half' } = {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
      };
      if (hasBody) init.duplex = 'half';
      const forwarded = new Request(innerUrl.toString(), init);

      // HTTP crosses Workers RPC as Request/Response values, streamed with
      // flow control and never materialised. A WebSocket upgrade cannot: its
      // 101 owns a live socket, so it takes the fetch-semantic entrypoint,
      // which every hop preserves. A target with no such entrypoint serves
      // HTTP only, and says so rather than dropping the socket.
      const isWebSocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
      const handler = isWebSocket
        ? entry.facetStub.handleWebSocketRequest
        : entry.facetStub.handleHttpRequest;
      if (!handler) {
        return new Response('Port target does not expose a WebSocket fetch route', { status: 501 });
      }
      const response: Response = await handler(forwarded);

      if (!(response instanceof Response)) {
        // Defensive: if a facet ever returns something else (JSON
        // envelope, string, etc.), treat it as a 502 so the client
        // sees a clear signal rather than a confusing surprise.
        return new Response(
          JSON.stringify({
            error: 'port proxy: facet returned non-Response value',
            type: typeof response,
          }),
          {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      // Stream the facet's Response back. Status, status-text, and every
      // header pass through; only a content coding the hop cannot carry is
      // undone. We do NOT inject Access-Control-Allow-Origin — a port proxy
      // forwards whatever CORS policy the user's HTTP server chose (audit C3
      // discourages gratuitous wildcards on non-static routes).
      return decodeContentCoding(response, port);
    } catch (error: unknown) {
      // Server-side triage — users see only the 502 body, operators
      // see the full error + stack in Worker logs.
      console.error('[port-registry] routeRequest failed for port', port, ':', error);
      return new Response(
        JSON.stringify({ error: errorMessage(error) }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  }

  get stats() {
    return {
      activePorts: this.ports.size,
      ports: [...this.ports.entries()].map(([port, e]) => ({ port, pid: e.pid })),
    };
  }

  private waitForPidPortChange(pid: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        const waiters = this.portWaitersByPid.get(pid);
        if (waiters) {
          waiters.delete(finish);
          if (waiters.size === 0) this.portWaitersByPid.delete(pid);
        }
        resolve();
      };
      timeout = setTimeout(finish, timeoutMs);
      const waiters = this.portWaitersByPid.get(pid) || new Set<() => void>();
      waiters.add(finish);
      this.portWaitersByPid.set(pid, waiters);
    });
  }

  private notifyPortWaiters(pid: number): void {
    const waiters = this.portWaitersByPid.get(pid);
    if (!waiters) return;
    this.portWaitersByPid.delete(pid);
    for (const resolve of waiters) resolve();
  }
}

function routeableFacetTarget(value: unknown): RouteableFacetTarget | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
  // A `fetch` target already has fetch semantics, so it serves both.
  const fetchMethod = Reflect.get(value, 'fetch');
  if (typeof fetchMethod === 'function') {
    const fetch = fetchMethod.bind(value) as (request: Request) => Promise<Response>;
    return { handleHttpRequest: fetch, handleWebSocketRequest: fetch };
  }
  const httpMethod = Reflect.get(value, 'handleHttpRequest');
  if (typeof httpMethod !== 'function') return null;
  const webSocketMethod = Reflect.get(value, 'handleWebSocketRequest');
  return {
    handleHttpRequest: httpMethod.bind(value),
    ...(typeof webSocketMethod === 'function'
      ? { handleWebSocketRequest: webSocketMethod.bind(value) }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
