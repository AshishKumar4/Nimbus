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

export interface PortEntry {
  port: number;
  pid: number;
  /**
   * Facet stub exposing `handleHttpRequest(Request): Promise<Response>`.
   * May be null when a facet has reserved a port but not yet wired up
   * the request handler (see _rpcRegisterPort in nimbus-session.ts).
   */
  facetStub: any;
  registeredAt: number;
}

export class PortRegistry {
  private ports = new Map<number, PortEntry>();

  /** Register a facet as listening on a port. */
  register(port: number, pid: number, facetStub: any): void {
    this.ports.set(port, { port, pid, facetStub, registeredAt: Date.now() });
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
    return count;
  }

  /** Look up a port entry. */
  get(port: number): PortEntry | undefined {
    return this.ports.get(port);
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
   * Binary safety: both directions use structured-cloneable Request/
   * Response values over Workers RPC. No UTF-8 round-trip anywhere.
   * A user-facet serving a PNG will return the exact same bytes the
   * client receives.
   */
  async routeRequest(port: number, request: Request, pathname: string): Promise<Response | null> {
    const entry = this.ports.get(port);
    // Audit F3 (STABILITY-AUDIT.md C-S3): the supervisor half of the
    // binary-safe port proxy shipped in AUDIT.md C2 (ad8153a), but the
    // facet-side producer (an actual `handleHttpRequest` on a
    // WorkerEntrypoint + a non-null facetStub in _rpcRegisterPort)
    // was never wired. Zero implementations of handleHttpRequest
    // exist in the tree. Returning null here used to fall through to
    // a misleading 502 ("No process listening on port N") which made
    // users think the server had crashed. Return an honest 501 with
    // a TODO pointer so the feature's state is visible at the API.
    if (!entry?.facetStub) {
      return new Response(
        JSON.stringify({
          error: 'port proxying not yet wired end-to-end',
          port,
          todo: 'STABILITY-AUDIT.md F3',
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
      // `duplex: 'half'` is required by workerd when body is a
      // ReadableStream — otherwise `new Request(…)` throws. It's not
      // part of the published @cloudflare/workers-types RequestInit,
      // so extend the type locally rather than casting the whole
      // init — that keeps typos in other fields caught by the compiler.
      const init: RequestInit & { duplex?: 'half' } = {
        method: request.method,
        headers: request.headers,
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
    } catch (e: any) {
      // Server-side triage — users see only the 502 body, operators
      // see the full error + stack in Worker logs.
      console.error('[port-registry] routeRequest failed for port', port, ':', e);
      return new Response(
        JSON.stringify({ error: e?.message || String(e) }),
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
}
