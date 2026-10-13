/**
 * undici-shim.ts — the `undici` npm package, mapped onto the platform HTTP stack.
 *
 * Like sqlite-shim.ts, this emits a raw JS string embedded in the
 * generated facet module (interpolated by node-shims.ts). It defines
 * `__undiciMod`, which node-shims registers as `builtins.undici`.
 *
 * Why this exists
 * ───────────────
 * `undici` is Node's reference `fetch` implementation and one of the most
 * common transitive dependencies on npm. Its own implementation speaks HTTP
 * over raw TCP sockets through Node internals a Worker facet does not have, so
 * inside a facet it is doubly broken:
 *
 *   1. `undici.install()` REPLACES `globalThis.fetch` with undici's, which then
 *      throws `TypeError: addAbortListenerNative is not a function` on its
 *      first call. Any tool that installs it (pi's dist/core/http-dispatcher.js
 *      does, at import time) loses fetch entirely — surfacing to the user as an
 *      unexplained "Connection error".
 *   2. That replacement also silently defeats Nimbus's own machinery. In-session
 *      loopback routing (`127.0.0.1:<port>` → the facet owning that port) and
 *      AI-egress mediation (a request presenting the session's AI capability
 *      token is served by the session's own gateway) both live on the patched
 *      `globalThis.fetch` in node-shims.ts. Swapping in undici's fetch drops
 *      both.
 *
 * Making undici's socket path work is not the fix — the facet has no sockets.
 * The fix is that in Nimbus, the thing undici exists to provide is already
 * there: WHATWG `fetch`/`Request`/`Response`, patched with loopback + egress
 * mediation. So `require('undici')` resolves here instead of to node_modules,
 * and every export is backed by that same patched fetch.
 *
 * Registration goes in the `builtins` table, which `__requireFrom` consults
 * BEFORE node_modules resolution — so this wins over any installed copy of the
 * real package without a second module-resolution path, and the ESM→CJS
 * pre-pass (facets/manager.ts `transformEsmInBundle`, plus esbuild's
 * `dynamic-import: false` lowering) rewrites every `import`/`import()` of
 * 'undici' into that same `require`, so both module systems land here.
 *
 * Honesty contract
 * ────────────────
 * Every export exists. Each one is either backed by the platform, inert in a
 * way that cannot change the answer a caller gets, or a named thrower stating
 * exactly what is missing. Nothing silently returns something other than what
 * was asked for:
 *
 *   - Connection-pool tuning (`Agent`/`Pool`/`Client` options: keep-alive,
 *     pipelining, connections, timeouts) is accepted and ignored — connection
 *     management is the platform's and none of it changes the response.
 *   - Anything that reroutes or intercepts traffic — `ProxyAgent`, mocks, the
 *     low-level `dispatch()` protocol, interceptors — throws, because ignoring
 *     it would send traffic the caller believes it redirected or stubbed.
 *   - `EnvHttpProxyAgent` is inert when no proxy environment variable is set
 *     (which is what it does in Node too) and throws when one is, rather than
 *     quietly bypassing it.
 *
 * Runtime scope dependencies (in scope where the shim block is interpolated):
 *   - globalThis.fetch — ALREADY patched by node-shims.ts (loopback + AI egress)
 *   - __streamMod (Readable.fromWeb, pipeline), __eventsMod, env
 */
import { HTTP_REDIRECT_POLICY_SOURCE } from './compiled-bodies.generated.js';
/**
 * The names the shim's module has beside \`default\`: what an ES module may
 * import from 'undici' (worker facets/esm-stage.ts builds its facade with
 * them). tests/unit/undici-shim-exports.mjs evaluates the shim and checks the
 * list against its keys.
 */
export const UNDICI_SHIM_EXPORTS = Object.freeze([
    "Agent", "BalancedPool", "Blob", "Client", "CloseEvent", "DecoratorHandler", "Dispatcher", "Dispatcher1Wrapper",
    "EnvHttpProxyAgent", "ErrorEvent", "EventSource", "File", "FormData", "H2CClient", "Headers", "MessageEvent",
    "MockAgent", "MockCallHistory", "MockCallHistoryLog", "MockClient", "MockPool", "Pool", "ProxyAgent",
    "RedirectHandler", "Request", "Response", "RetryAgent", "RetryHandler", "RoundRobinPool", "SnapshotAgent",
    "Socks5ProxyAgent", "Undici", "WebSocket", "WebSocketError", "WebSocketStream", "buildConnector", "cacheStores",
    "caches", "connect", "deleteCookie", "errors", "fetch", "getCookies", "getGlobalDispatcher", "getGlobalOrigin",
    "getSetCookies", "install", "interceptors", "mockErrors", "parseCookie", "parseMIMEType", "ping", "pipeline",
    "request", "serializeAMimeType", "setCookie", "setGlobalDispatcher", "setGlobalOrigin", "stream", "upgrade",
    "util",
]);
export function generateUndiciShimCode() {
    return `
const __undiciMod = (() => {
  const { isRedirectStatus, applyRedirectPolicy } = ${HTTP_REDIRECT_POLICY_SOURCE};
  // The patched global fetch, captured now. Captured rather than dereferenced
  // per call so that user code doing \`globalThis.fetch = undici.fetch\` — a real
  // pattern — cannot build an infinite delegation loop. This is the binding
  // that carries in-session loopback routing and AI-egress mediation.
  const __fetch = globalThis.fetch;

  const fail = (api, why) => new Error(
    "Nimbus: undici." + api + " is not available in a Nimbus session — " + why +
    ". Nimbus maps the 'undici' module onto the platform HTTP stack, so " +
    "fetch/Request/Response and undici.request/stream work and stay routed " +
    "through the session (in-session loopback and AI egress included).",
  );

  /** A named export that cannot work here: constructing or calling it throws. */
  const unsupported = (api, why) => {
    const thrower = function () { throw fail(api, why); };
    Object.defineProperty(thrower, "name", { value: api });
    return thrower;
  };

  /** A global the platform may not define — fail by name, not as "undefined is not a constructor". */
  const globalOr = (name, why) => globalThis[name] || unsupported(name, why);

  const dispatchWhy = "the low-level dispatch protocol needs socket-level control the platform does not expose; use undici.request(), undici.stream() or fetch()";
  const mockWhy = "request interception needs the dispatch protocol, so mocked requests would escape to the real network";
  const proxyWhy = "outbound proxying is unavailable, and ignoring it would send traffic straight to the origin";
  const socketWhy = "it needs a raw TCP socket";
  const unmappedWhy = "it is not part of Nimbus's mapping of 'undici' onto the platform HTTP stack";

  // ── errors ──────────────────────────────────────────────────────────────
  // Real classes, because consumers branch on \`instanceof\` and on \`err.code\`.
  class UndiciError extends Error {
    constructor(message) { super(message); this.name = "UndiciError"; this.code = "UND_ERR"; }
  }
  const errorCodes = {
    AbortError: "UND_ERR_ABORT",
    ConnectTimeoutError: "UND_ERR_CONNECT_TIMEOUT",
    HeadersTimeoutError: "UND_ERR_HEADERS_TIMEOUT",
    HeadersOverflowError: "UND_ERR_HEADERS_OVERFLOW",
    BodyTimeoutError: "UND_ERR_BODY_TIMEOUT",
    InvalidArgumentError: "UND_ERR_INVALID_ARG",
    InvalidReturnValueError: "UND_ERR_INVALID_RETURN_VALUE",
    RequestAbortedError: "UND_ERR_ABORTED",
    InformationalError: "UND_ERR_INFO",
    RequestContentLengthMismatchError: "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
    ResponseContentLengthMismatchError: "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
    ClientDestroyedError: "UND_ERR_DESTROYED",
    ClientClosedError: "UND_ERR_CLOSED",
    SocketError: "UND_ERR_SOCKET",
    NotSupportedError: "UND_ERR_NOT_SUPPORTED",
    BalancedPoolMissingUpstreamError: "UND_ERR_BPL_MISSING_UPSTREAM",
    HTTPParserError: "UND_ERR_HTTP_PARSER",
    ResponseExceededMaxSizeError: "UND_ERR_RES_EXCEEDED_MAX_SIZE",
    RequestRetryError: "UND_ERR_REQ_RETRY",
    ResponseError: "UND_ERR_RESPONSE",
    SecureProxyConnectionError: "UND_ERR_PRX_TLS",
    ProxyConnectionError: "UND_ERR_PRX_CONN",
    MaxOriginsReachedError: "UND_ERR_MAX_ORIGINS_REACHED",
    Socks5ProxyError: "UND_ERR_SOCKS5_PROXY",
    MessageSizeExceededError: "UND_ERR_MESSAGE_SIZE_EXCEEDED",
  };
  const errors = { UndiciError };
  for (const [name, code] of Object.entries(errorCodes)) {
    const Cls = class extends UndiciError {
      constructor(message) { super(message || name); this.name = name; this.code = code; }
    };
    Object.defineProperty(Cls, "name", { value: name });
    errors[name] = Cls;
  }
  // Carries the response it rejected on — callers read .statusCode/.body.
  class ResponseStatusCodeError extends UndiciError {
    constructor(message, statusCode, headers, body) {
      super(message || "Response status code " + statusCode);
      this.name = "ResponseStatusCodeError";
      this.code = "UND_ERR_RESPONSE_STATUS_CODE";
      this.status = statusCode;
      this.statusCode = statusCode;
      this.headers = headers;
      this.body = body;
    }
  }
  errors.ResponseStatusCodeError = ResponseStatusCodeError;

  // ── request plumbing ────────────────────────────────────────────────────
  let globalOrigin = null;

  const targetUrl = (url, opts) => {
    let target;
    if (typeof url === "string" || url instanceof URL) {
      target = new URL(String(url), globalOrigin || undefined);
    } else if (url && typeof url === "object") {
      // The { origin, protocol, hostname, port, path } option form.
      const origin = url.origin
        || (url.protocol && url.hostname
          ? url.protocol + "//" + url.hostname + (url.port ? ":" + url.port : "")
          : null);
      if (!origin) throw new errors.InvalidArgumentError("undici: request needs a URL or an origin");
      target = new URL(url.path || url.pathname || "/", origin);
    } else {
      throw new errors.InvalidArgumentError("undici: request needs a URL");
    }
    if (opts && opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (Array.isArray(v)) for (const item of v) target.searchParams.append(k, String(item));
        else if (v !== undefined && v !== null) target.searchParams.set(k, String(v));
      }
    }
    return target;
  };

  const requestHeaders = (headers) => {
    const out = new Headers();
    if (!headers) return out;
    if (typeof headers.forEach === "function" && typeof headers.get === "function") {
      headers.forEach((v, k) => out.append(k, v));
    } else if (Array.isArray(headers)) {
      // Both the flat [k, v, k, v] and the paired [[k, v], …] forms.
      if (headers.length && Array.isArray(headers[0])) {
        for (const pair of headers) out.append(String(pair[0]), String(pair[1]));
      } else {
        for (let i = 0; i + 1 < headers.length; i += 2) out.append(String(headers[i]), String(headers[i + 1]));
      }
    } else {
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) for (const item of v) out.append(k, String(item));
        else out.append(k, String(v));
      }
    }
    return out;
  };

  /** undici hands back a plain lowercased header bag; set-cookie stays an array. */
  const responseHeaders = (response) => {
    const out = {};
    response.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    if (cookies.length) out["set-cookie"] = cookies;
    return out;
  };

  const collect = async (source) => {
    const parts = [];
    let total = 0;
    for await (const chunk of source) {
      const bytes = typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : new Uint8Array(chunk.buffer || chunk, chunk.byteOffset || 0, chunk.byteLength ?? chunk.length);
      parts.push(bytes);
      total += bytes.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  };

  const requestBody = async (body) => {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) return body;
    if (typeof Blob !== "undefined" && body instanceof Blob) return body;
    if (typeof FormData !== "undefined" && body instanceof FormData) return body;
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body;
    // A Node Readable, a Web ReadableStream or any other iterable: drained into the request.
    if (typeof body[Symbol.asyncIterator] === "function" || typeof body[Symbol.iterator] === "function") return collect(body);
    throw new errors.InvalidArgumentError("undici: unsupported request body type");
  };

  /** A hop's body length, as undici checks a Content-Length against it; null for what fetch encodes (FormData, URLSearchParams). */
  const bodyLength = (body) => {
    if (body === undefined) return 0;
    if (typeof body === "string") return new TextEncoder().encode(body).length;
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) return body.byteLength;
    if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
    return null;
  };

  /**
   * undici's response body: a Node Readable that also carries the WHATWG body
   * mixin. Both surfaces read the same stream, so consuming one marks the body
   * used for the other — matching undici, where \`body.text()\` after a manual
   * read throws.
   */
  const bodyStream = (response) => {
    const stream = response.body
      ? __streamMod.Readable.fromWeb(response.body)
      : __streamMod.Readable.from([]);
    const claim = () => {
      if (stream.bodyUsed) throw new TypeError("Body is unusable: Body has already been read");
      stream.bodyUsed = true;
    };
    stream.bodyUsed = false;
    stream.bytes = async () => { claim(); return collect(stream); };
    stream.arrayBuffer = async () => {
      claim();
      const bytes = await collect(stream);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    };
    stream.text = async () => { claim(); return new TextDecoder().decode(await collect(stream)); };
    stream.json = async () => { claim(); return JSON.parse(new TextDecoder().decode(await collect(stream))); };
    stream.blob = async () => {
      claim();
      return new Blob([await collect(stream)], { type: response.headers.get("content-type") || "" });
    };
    // Re-wrap through the platform Response so multipart/urlencoded parsing is
    // the platform's, not a second implementation of it.
    stream.formData = async () => {
      claim();
      const type = response.headers.get("content-type");
      return new Response(await collect(stream), { headers: type ? { "content-type": type } : {} }).formData();
    };
    stream.dump = async () => {
      if (stream.bodyUsed) return;
      stream.bodyUsed = true;
      try { await collect(stream); } catch { /* the point is to discard it */ }
    };
    return stream;
  };

  /** A dispatcher only reaches the network by being one of ours; anything else would be silently bypassed. */
  const assertInertDispatcher = (dispatcher, api) => {
    if (dispatcher && !(dispatcher instanceof Dispatcher)) {
      throw fail(api, "a dispatcher Nimbus did not create cannot intercept requests here, so honouring it is impossible");
    }
  };

  /**
   * undici's top-level request(). Redirects are followed manually so that
   * \`maxRedirections\` (default 0 — do NOT follow) is honoured exactly rather
   * than approximated by fetch's own follow limit.
   */
  const request = async (url, options) => {
    const opts = options || {};
    assertInertDispatcher(opts.dispatcher, "request({ dispatcher })");
    // Node 22's real RedirectHandler is installed only for a nonzero count.
    // Do not coerce strings/fractions into a different redirect policy.
    const maxRedirections = opts.maxRedirections || 0;
    if (maxRedirections && (!Number.isInteger(maxRedirections) || maxRedirections < 0)) {
      throw new errors.InvalidArgumentError("maxRedirections must be a positive number");
    }
    const hop = {
      url: targetUrl(url, opts),
      method: String(opts.method || "GET").toUpperCase(),
      headers: requestHeaders(opts.headers),
      body: await requestBody(opts.body),
    };
    // How undici 6's RedirectHandler sends a body again (lib/handler/redirect-handler.js).
    // A Node stream is marked used once read: a redirect after it was sent is
    // not followed. Any other iterable but a string or a byte view is sent as
    // itself, then iterated again for a hop that keeps the body: an array
    // gives its bytes again, a spent generator or stream nothing. A string,
    // bytes, a Blob, FormData and URLSearchParams are the same every hop.
    const source = opts.body;
    const sentOnce = source != null && typeof source.pipe === "function" && typeof source.on === "function";
    const iteratedAgain = !sentOnce && source != null && typeof source === "object"
      && !(source instanceof Uint8Array) && !(source instanceof ArrayBuffer)
      && !(typeof FormData !== "undefined" && source instanceof FormData)
      && !(typeof URLSearchParams !== "undefined" && source instanceof URLSearchParams)
      && (typeof source[Symbol.asyncIterator] === "function" || typeof source[Symbol.iterator] === "function");

    let response;
    for (let followed = 0; ; followed++) {
      // A socket transport normally synthesizes Host. Fetch's in-process HTTP
      // route has no wire to do that, so regenerate it here after the policy
      // removed the previous hop's Host, including on same-origin redirects.
      if (!hop.headers.has("host")) hop.headers.set("host", hop.url.host);
      // undici refuses a hop whose body is not as long as its Content-Length.
      const declared = hop.headers.get("content-length");
      const length = bodyLength(hop.body);
      if (declared !== null && length !== null && Number(declared) !== length) {
        throw new errors.RequestContentLengthMismatchError("Request body length does not match content-length header");
      }
      response = await __fetch(hop.url.href, {
        method: hop.method,
        headers: hop.headers,
        body: hop.body,
        signal: opts.signal || undefined,
        redirect: "manual",
      });
      // undici 6 checks this on every response at the cap, even a final 200.
      if (maxRedirections > 0 && opts.throwOnMaxRedirect && followed >= maxRedirections) {
        await response.body?.cancel();
        throw new Error("max redirects");
      }
      if (followed >= maxRedirections || (sentOnce && __streamMod.isDisturbed(source))) break;
      const location = response.headers.get("location");
      if (!isRedirectStatus(response.status, "undici") || !location) break;
      await response.body?.cancel();
      const next = new URL(location, hop.url);
      applyRedirectPolicy(hop, response.status, next, "undici");
      if (hop.body !== undefined && iteratedAgain) hop.body = await collect(source);
    }

    const resHeaders = responseHeaders(response);
    const stream = bodyStream(response);
    if (opts.throwOnError && response.status >= 400) {
      throw new ResponseStatusCodeError(
        "Response status code " + response.status, response.status, resHeaders, await stream.text(),
      );
    }
    return {
      statusCode: response.status,
      statusText: response.statusText,
      headers: resHeaders,
      trailers: {},
      body: stream,
      opaque: opts.opaque === undefined ? null : opts.opaque,
      context: opts.context || {},
    };
  };

  /** undici's stream(): pipe the response body into the writable the caller builds. */
  const stream = async (url, options, factory) => {
    if (typeof options === "function") { factory = options; options = {}; }
    if (typeof factory !== "function") {
      throw new errors.InvalidArgumentError("undici: stream() needs a factory function");
    }
    const result = await request(url, options);
    const writable = factory({
      statusCode: result.statusCode,
      headers: result.headers,
      opaque: result.opaque,
      context: result.context,
    });
    if (!writable || typeof writable.write !== "function") {
      throw new errors.InvalidReturnValueError("undici: the stream() factory must return a writable");
    }
    await new Promise((resolve, reject) => {
      __streamMod.pipeline(result.body, writable, (err) => (err ? reject(err) : resolve()));
    });
    return {
      statusCode: result.statusCode,
      headers: result.headers,
      trailers: {},
      opaque: result.opaque,
      context: result.context,
    };
  };

  // ── dispatchers ─────────────────────────────────────────────────────────
  // A dispatcher here is a connection-management object with nothing to
  // manage: pooling, keep-alive, pipelining and socket timeouts are the
  // platform's, and none of them change the response a caller sees, so the
  // options are accepted and ignored. The parts of the dispatcher contract
  // that WOULD change the response — dispatch(), compose() — throw.
  const kOrigin = Symbol("undici.origin");
  class Dispatcher extends __eventsMod {
    constructor(origin, options) {
      super();
      if (origin && typeof origin === "object" && !(origin instanceof URL)) { options = origin; origin = undefined; }
      this[kOrigin] = origin ? new URL(String(origin)).origin : null;
      this.destroyed = false;
      this.closed = false;
      this.options = options || {};
    }
    request(options) {
      const opts = options || {};
      return request(this[kOrigin] ? new URL(opts.path || "/", this[kOrigin]) : opts, opts);
    }
    stream(options, factory) {
      const opts = options || {};
      return stream(this[kOrigin] ? new URL(opts.path || "/", this[kOrigin]) : opts, opts, factory);
    }
    dispatch() { throw fail("Dispatcher.dispatch()", dispatchWhy); }
    compose() { throw fail("Dispatcher.compose()", "interceptor composition operates on the dispatch protocol, and " + dispatchWhy); }
    pipeline() { throw fail("Dispatcher.pipeline()", "duplex dispatch needs socket-level control; use undici.request() or undici.stream()"); }
    connect() { throw fail("Dispatcher.connect()", "CONNECT tunnelling needs a raw TCP socket"); }
    upgrade() { throw fail("Dispatcher.upgrade()", "protocol upgrade needs a raw TCP socket; use the WebSocket global"); }
    close(cb) { this.closed = true; if (cb) { cb(null, null); return undefined; } return Promise.resolve(); }
    destroy(err, cb) {
      if (typeof err === "function") cb = err;
      this.destroyed = true;
      this.closed = true;
      if (cb) { cb(null, null); return undefined; }
      return Promise.resolve();
    }
  }
  class Agent extends Dispatcher {}
  class Pool extends Dispatcher {}
  class Client extends Dispatcher {}
  class BalancedPool extends Dispatcher {}
  class RoundRobinPool extends Dispatcher {}
  class Dispatcher1Wrapper extends Dispatcher {}
  // Reads the proxy environment exactly as undici does. With no proxy
  // configured it is a plain direct dispatcher, which is what it is in Node
  // too — so tools that construct one unconditionally (pi does, at import
  // time) work. With one configured, staying silent would send the traffic
  // direct, so it fails instead.
  const PROXY_ENV = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"];
  class EnvHttpProxyAgent extends Dispatcher {
    constructor(options) {
      super(options);
      let configured = "";
      try { configured = PROXY_ENV.find((name) => env && env[name]) || ""; } catch { configured = ""; }
      if (configured) throw fail("EnvHttpProxyAgent", "$" + configured + " is set but " + proxyWhy);
    }
  }

  let globalDispatcher = new Agent();
  const setGlobalDispatcher = (dispatcher) => {
    if (!dispatcher || typeof dispatcher.dispatch !== "function") {
      throw new errors.InvalidArgumentError("undici: setGlobalDispatcher needs a Dispatcher");
    }
    assertInertDispatcher(dispatcher, "setGlobalDispatcher()");
    globalDispatcher = dispatcher;
  };

  const mod = {
    // Backed by the patched global fetch, so in-session loopback and AI-egress
    // mediation apply to undici's callers exactly as they do to fetch's.
    fetch: __fetch,
    Headers,
    Request,
    Response,
    FormData,
    Blob,
    File: globalOr("File", unmappedWhy),
    WebSocket: globalOr("WebSocket", socketWhy),
    EventSource: globalOr("EventSource", socketWhy + "; use fetch() and read the streamed body"),
    MessageEvent: globalOr("MessageEvent", unmappedWhy),
    CloseEvent: globalOr("CloseEvent", unmappedWhy),
    ErrorEvent: globalOr("ErrorEvent", unmappedWhy),

    // In Node, install() swaps undici's WHATWG implementations onto globalThis.
    // Here the globals ARE the platform's WHATWG implementations, already
    // carrying Nimbus's loopback + AI-egress routing — so install() has nothing
    // left to do, and replacing globalThis.fetch would destroy both.
    install() {},

    request,
    stream,
    setGlobalDispatcher,
    getGlobalDispatcher: () => globalDispatcher,
    setGlobalOrigin: (origin) => { globalOrigin = origin ? new URL(String(origin)).origin : null; },
    getGlobalOrigin: () => (globalOrigin ? new URL(globalOrigin) : undefined),

    Dispatcher, Agent, Pool, Client, BalancedPool, RoundRobinPool,
    Dispatcher1Wrapper, EnvHttpProxyAgent,
    errors,

    // Raw sockets.
    connect: unsupported("connect", "CONNECT tunnelling needs a raw TCP socket"),
    upgrade: unsupported("upgrade", "protocol upgrade needs a raw TCP socket; use the WebSocket global"),
    buildConnector: unsupported("buildConnector", "socket construction has no equivalent in a facet"),
    pipeline: unsupported("pipeline", "duplex dispatch needs socket-level control; use undici.request() or undici.stream()"),
    H2CClient: unsupported("H2CClient", "cleartext HTTP/2 with prior knowledge needs socket-level control"),
    WebSocketStream: unsupported("WebSocketStream", socketWhy),
    WebSocketError: unsupported("WebSocketError", unmappedWhy),
    ping: unsupported("ping", socketWhy),
    // Routing changes that would otherwise be silently dropped.
    ProxyAgent: unsupported("ProxyAgent", proxyWhy),
    Socks5ProxyAgent: unsupported("Socks5ProxyAgent", proxyWhy),
    RetryAgent: unsupported("RetryAgent", "retry is a dispatch interceptor, and " + dispatchWhy),
    // Interception (test doubles) — letting these through would send real
    // requests a test believes it stubbed.
    MockAgent: unsupported("MockAgent", mockWhy),
    MockPool: unsupported("MockPool", mockWhy),
    MockClient: unsupported("MockClient", mockWhy),
    MockCallHistory: unsupported("MockCallHistory", mockWhy),
    MockCallHistoryLog: unsupported("MockCallHistoryLog", mockWhy),
    SnapshotAgent: unsupported("SnapshotAgent", mockWhy),
    mockErrors: errors,
    // Handler decorators over the dispatch protocol.
    DecoratorHandler: unsupported("DecoratorHandler", "handler decoration operates on the dispatch protocol, and " + dispatchWhy),
    RedirectHandler: unsupported("RedirectHandler", "handler decoration operates on the dispatch protocol; use request({ maxRedirections })"),
    RetryHandler: unsupported("RetryHandler", "handler decoration operates on the dispatch protocol, and " + dispatchWhy),
    interceptors: {},
    // HTTP caching is the platform's; a second cache layer here would answer
    // from state the platform does not know about.
    caches: unsupported("caches", unmappedWhy),
    cacheStores: {
      MemoryCacheStore: unsupported("cacheStores.MemoryCacheStore", unmappedWhy),
      SqliteCacheStore: unsupported("cacheStores.SqliteCacheStore", unmappedWhy),
    },
    util: {
      parseHeaders: unsupported("util.parseHeaders", "raw header buffers only exist on the socket path"),
      headerNameToString: (name) => String(name).toLowerCase(),
    },
    getCookies: unsupported("getCookies", unmappedWhy),
    getSetCookies: unsupported("getSetCookies", unmappedWhy),
    setCookie: unsupported("setCookie", unmappedWhy),
    deleteCookie: unsupported("deleteCookie", unmappedWhy),
    parseCookie: unsupported("parseCookie", unmappedWhy),
    parseMIMEType: unsupported("parseMIMEType", unmappedWhy),
    serializeAMimeType: unsupported("serializeAMimeType", unmappedWhy),
  };
  for (const name of ["redirect", "responseError", "retry", "dump", "dns", "cache", "decompress", "deduplicate"]) {
    mod.interceptors[name] = unsupported("interceptors." + name, "interceptors operate on the dispatch protocol, and " + dispatchWhy);
  }
  // Interop: undici is CJS with an \`export default Undici\`; an interpreted
  // module's \`import undici from 'undici'\` reads \`.default\`. \`.Undici\`
  // mirrors the package's own self-reference.
  mod.default = mod;
  mod.Undici = mod;
  return mod;
})();
`;
}
