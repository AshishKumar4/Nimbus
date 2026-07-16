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
 *   `request.method`/`headers` mirror the outer request, and
 *   `request.body` is a ReadableStream (or null for GET/HEAD) that
 *   the facet can consume once. The returned Response is returned
 *   to the outer fetch as-is; its body is streamed directly.
 */

export interface RouteableFacetTarget {
  handleHttpRequest(request: Request): Promise<Response>;
}

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

  /** Register a facet as listening on a port. */
  register(port: number, pid: number, facetStub: unknown): void {
    const routeableStub =
      routeableFacetTarget(this.facetStubsByPid.get(pid)) ||
      routeableFacetTarget(facetStub);
    this.ports.set(port, { port, pid, facetStub: routeableStub, registeredAt: Date.now() });
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

  async waitForRouteablePortsByPid(pid: number, facetStub: unknown, timeoutMs: number): Promise<number[]> {
    this.bindFacetStub(pid, facetStub);
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
   * port". Headers and body are forwarded unchanged; the body is a
   * ReadableStream so binary payloads aren't materialised in memory.
   *
   * Binary safety: Workers RPC transfers Request/Response values with
   * their streaming bodies; it does not structured-clone them. No UTF-8
   * round-trip occurs anywhere.
   * A user-facet serving a PNG will return the exact same bytes the
   * client receives.
   */
  async routeRequest(port: number, request: Request, pathname: string): Promise<Response | null> {
    const entry = this.ports.get(port);
    // Some short-lived/foreground paths can reserve a port through
    // SupervisorRPC.registerPort before a routeable WorkerEntrypoint
    // exists. Explicit long-running processes (for example
    // `node --watch server.js`) register a non-null facet stub and route
    // below. For a null-stub reservation, return an honest 501 instead
    // of a misleading "no process listening" 502.
    if (!entry?.facetStub) {
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
      headers.set('X-Nimbus-Port', String(port));
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

      // RPC: the facet receives the Request and returns a Response.
      // Both cross the isolate boundary via Workers RPC's native
      // Request/Response transport — bytes are streamed with
      // flow-control, never materialised.
      const response: Response = await entry.facetStub.handleHttpRequest(forwarded);

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

      // Return the facet's Response as-is. Body is streamed; headers,
      // status, and status-text pass through unchanged. We do NOT
      // inject Access-Control-Allow-Origin — a port proxy forwards
      // whatever CORS policy the user's HTTP server chose (audit C3
      // discourages gratuitous wildcards on non-static routes).
      return response;
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
  const method = Reflect.get(value, 'fetch') || Reflect.get(value, 'handleHttpRequest');
  if (typeof method !== 'function') return null;
  return {
    handleHttpRequest: method.bind(value),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
