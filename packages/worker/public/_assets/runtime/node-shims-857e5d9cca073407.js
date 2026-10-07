
// The runner's stop and replay (runtime/stop-replay.ts), private to its
// module: null in a runner without one.
const __nimbusReplay = typeof __nimbusStopReplay !== "undefined" ? __nimbusStopReplay : null;
// A connection opened through workerd's own socket class, which a program
// reaches past every export of node:net and node:tls (it is the prototype of
// tls.TLSSocket), is something a second run would do again: counted where
// the class connects, so the read after it fails where the program can catch
// it. (The session counts every connection too, where the program cannot
// reach.) The TLS shim's carrier is counted as its tls.connect.
let __nimbusCarrierOpening = false;
let __nimbusCarrierGate = null;
let __nimbusCarrierFailure = null;
if (__nimbusReplay && typeof __real_net !== "undefined") {
  const __NativeSocket = (__real_net.default ?? __real_net).Socket;
  const __nativeConnect = __NativeSocket && __NativeSocket.prototype ? __NativeSocket.prototype.connect : undefined;
  if (typeof __nativeConnect === "function") {
    Object.defineProperty(__NativeSocket.prototype, "connect", { configurable: true, writable: true, value: function connect(...args) {
      if (!__nimbusCarrierOpening) {
        const first = args[0];
        const where = first !== null && typeof first === "object"
          ? String(first.host ?? "") + ":" + String(first.port ?? first.path ?? "")
          : String(typeof args[1] === "string" ? args[1] : "") + ":" + String(first ?? "");
        __nimbusReplay.effect("net.connect " + where);
      }
      // A synchronous read crossed the replay boundary, but the session
      // must acknowledge its notice before any new native transport opens.
      // TLS's carrier joins that same gate AND its target registration.
      const ready = __nimbusCarrierOpening ? __nimbusCarrierGate : __nimbusReplay.afterBoundary();
      if (ready) {
        const socket = this;
        const fail = __nimbusCarrierFailure || ((error) => socket.destroy(error));
        // Writes/TLS wrapping must see a connecting socket while it waits,
        // just as they do after an ordinary native connect was issued.
        socket.connecting = true;
        __nimbusTrackOp(Promise.resolve(ready).then(() => {
          if (socket.destroyed) return;
          // The native implementation owns its own false -> true transition
          // and refuses a second connect while already connecting.
          socket.connecting = false;
          try { Reflect.apply(__nativeConnect, socket, args); }
          catch (error) { fail(error); }
        }, fail));
        return socket;
      }
      return Reflect.apply(__nativeConnect, this, args);
    } });
  }
}
function __nimbusDisposeRpcResult(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  const dispose = value[Symbol.dispose];
  if (typeof dispose === "function") { try { dispose.call(value); } catch {} }
}

// ═══════════════════════════════════════════════════════════════════════
// ──  in-flight async operations ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Node keeps a process alive for its ACTIVE REQUESTS — a pending fetch, a
// pending fs call, a running child — not for pending promises. The facet's
// entry drain cannot learn that by watching promises: `await` resolves
// through PerformPromiseThen, which never calls the patched
// Promise.prototype.then, so a floating `(async () => { await fetch(u);
// console.log(x); })()` looks finished the instant its synchronous part
// returns and the rest of the program is dropped on the floor.
//
// Every external operation a facet can start crosses one of two seams:
// globalThis.fetch (network, in-session loopback, AI egress — plus reading
// the body of the Response it returns) and the supervisor RPC helper below
// (fs, child_process, ports, stdio). Counting there is the honest liveness
// signal, and it is what globalThis.__nimbusPendingOps reports.
const __nimbusOrigThen = Promise.prototype.then;
if (typeof globalThis.__nimbusPendingOps !== "number") globalThis.__nimbusPendingOps = 0;
function __nimbusTrackOp(promise) {
  if (!promise || typeof promise.then !== "function") return promise;
  globalThis.__nimbusPendingOps++;
  const settled = () => { globalThis.__nimbusPendingOps--; globalThis.__nimbusHandleReleased?.(); };
  try { __nimbusOrigThen.call(promise, settled, settled); }
  catch { settled(); }
  return promise;
}

// A connection the program holds open keeps it alive, as its socket does in
// Node, until it closes or is unref'd: a WebSocket client, a tls.connect
// socket. The returned setter holds (true) or lets go (false); it is the one
// counter __nimbusLiveHandles reads for them, separate from startup work so a
// socket opened at boot does not hold a resident's boot answer.
function __nimbusHoldSocket() {
  let held = false;
  const hold = (want) => {
    if (want === held) return;
    held = want;
    globalThis.__nimbusOpenSockets = (globalThis.__nimbusOpenSockets || 0) + (want ? 1 : -1);
    if (!want) globalThis.__nimbusHandleReleased?.();
  };
  hold(true);
  return hold;
}

async function __nimbusUseRpcResult(promise, use) {
  globalThis.__nimbusPendingOps++;
  try { return await __nimbusUseRpcResultUnref(promise, use); }
  finally { globalThis.__nimbusPendingOps--; globalThis.__nimbusHandleReleased?.(); }
}
// Facet infrastructure that long-polls the supervisor for as long as the
// facet lives — the attached-process stdin pump — is the analogue of an
// unref'd handle: real I/O, but never a reason to keep the program alive.
async function __nimbusUseRpcResultUnref(promise, use) {
  const value = await promise;
  try { return await use(value); }
  finally { __nimbusDisposeRpcResult(value); }
}

/**
 * The ACQUIRE barrier, taken before the program sees anything that arrived
 * from outside it: a response or body from the network, a relayed socket
 * frame, a request routed to one of its ports, a stdin packet or signal, a
 * child's output or exit. Each of those can be the second half of a causal
 * chain that began with a write somewhere else — `echo v2 > f; curl :3000`,
 * a child that writes a file and then exits — and the handler's synchronous
 * reads must see that write. Nothing but this barrier carries it.
 *
 * What the supervisor delivers — a request, a stdin packet, a child's output
 * or exit — carries the answer to this barrier with it (`delivered`,
 * session/rpc.ts _acquireOnDelivery), computed after the thing delivered was
 * queued, so the barrier applies that answer instead of asking, and the
 * program resumes with no round trip of its own. It asks when there is none
 * or it cannot use the one delivered. A resumption the supervisor does not
 * deliver — a timer, the network — always asks.
 *
 * The barrier is installed by the fs module, which is evaluated after this
 * point; a facet with no supervisor has none and nothing to be coherent with.
 */
async function __nimbusInboundBarrier(delivered) {
  const acquire = globalThis.__nimbusVfsAcquireBarrier;
  if (typeof acquire === "function") await acquire(delivered);
}

/**
 * The arguments this process asks its ACQUIRE with (the fs module's
 * _acquireArgs), for a delivery to be answered from: a long poll sends them,
 * and what it delivers comes back carrying fsAcquire's answer to them.
 */
function __nimbusVfsAcquireArgs() {
  const args = globalThis.__nimbusVfsAcquireArgs;
  return typeof args === "function" ? args() : undefined;
}

// ═══════════════════════════════════════════════════════════════════════
// ──  Precompiled wasm ───────────────────────────────────────────────
// A wasm image can only become a WebAssembly.Module through the Worker
// Loader's module map; new WebAssembly.Module(bytes) at request time is
// refused by the runtime. A launch whose closure carries an image (its VFS
// path, or its content digest for an image inlined as base64) gets it
// compiled at load and parked here. fs.readFileSync tags the bytes it hands
// out for such a path, and the WebAssembly seam below answers a compile of
// tagged or digest-matched bytes with the module the loader already built —
// so a package's own new WebAssembly.Module(readFileSync(__dirname + '/x.wasm'))
// works unchanged.
const __nimbusPrecompiledWasm = globalThis.__nimbusPrecompiledWasm instanceof Map
  ? globalThis.__nimbusPrecompiledWasm : new Map();
const __nimbusWasmModuleTag = Symbol.for("nimbus.precompiledWasmModule");
/**
 * Precompiled modules keyed by a digest of their BYTES, for an image that
 * never passes through the filesystem.
 *
 * Vite inlines es-module-lexer's parser as a base64 literal in its own source
 * and compiles it at module top level — from a cell that is request time, and
 * the runtime refuses it. There is no path to tag, so the launch registers
 * the image by content instead and the seam recognises the same bytes when
 * they arrive.
 */
const __nimbusPrecompiledWasmByDigest = globalThis.__nimbusPrecompiledWasmByDigest instanceof Map
  ? globalThis.__nimbusPrecompiledWasmByDigest : new Map();
/**
 * A synchronous content key: length and FNV-1a over every byte.
 *
 * Synchronous because new WebAssembly.Module(bytes) is, and SubtleCrypto is
 * not. Collisions do not matter for correctness the way they would in a
 * security check: the set is the handful of images one launch registered, and
 * the length is part of the key.
 */
function __nimbusWasmDigest(bytes) {
  const view = bytes instanceof Uint8Array
    ? bytes
    : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null);
  if (!view) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < view.length; i++) {
    hash ^= view[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return view.length + ":" + hash.toString(16);
}
(() => {
  const WA = globalThis.WebAssembly;
  if (!WA || WA.__nimbusPrecompiledSeam) return;
  const RealModule = WA.Module;
  const tagged = (bytes) => {
    if (!bytes || typeof bytes !== "object") return undefined;
    const byTag = bytes[__nimbusWasmModuleTag];
    if (byTag !== undefined) return byTag;
    if (__nimbusPrecompiledWasmByDigest.size === 0) return undefined;
    const digest = __nimbusWasmDigest(bytes);
    return digest === null ? undefined : __nimbusPrecompiledWasmByDigest.get(digest);
  };
  // The runtime compiles wasm only while the loader stages a module map; a
  // compile from bytes at any later point is refused with a message that names
  // neither the module nor the reason it cannot work. Say both: the caller is
  // an installed package whose image has to travel as a map member (the
  // closure walk registers it), or be inlined in module text the loader
  // itself evaluates.
  const refusal = (e, bytes) => {
    const size = (bytes && typeof bytes === "object" && typeof bytes.byteLength === "number") ? bytes.byteLength : 0;
    const where = globalThis.__currentModulePath ? " while loading " + globalThis.__currentModulePath : "";
    return new Error(
      "Nimbus: WebAssembly cannot be compiled from bytes here" + where + " (" + size + " bytes): "
      + ((e && e.message) || String(e))
      + ". The runtime compiles wasm only when the module loader stages it, so the image must ride in the "
      + "process's module map — a launch names one via the closure's wasmImages — rather than be compiled at runtime."
      + " Images this launch does carry: " + (__nimbusPrecompiledWasm.size + __nimbusPrecompiledWasmByDigest.size) + ".",
    );
  };
  const Module = function Module(bytes) {
    const compiled = tagged(bytes);
    if (compiled !== undefined) return compiled;
    try { return new RealModule(bytes); } catch (e) { throw refusal(e, bytes); }
  };
  Module.prototype = RealModule.prototype;
  for (const k of ["exports", "imports", "customSections"]) Module[k] = RealModule[k];
  Object.defineProperty(WA, "Module", { value: Module, writable: true, configurable: true });
  const realCompile = WA.compile.bind(WA);
  WA.compile = (bytes) => {
    const compiled = tagged(bytes);
    if (compiled !== undefined) return Promise.resolve(compiled);
    return realCompile(bytes).catch((e) => { throw refusal(e, bytes); });
  };
  const realInstantiate = WA.instantiate.bind(WA);
  WA.instantiate = (source, imports) => {
    const compiled = tagged(source);
    if (compiled !== undefined) {
      return realInstantiate(compiled, imports).then((instance) => ({ module: compiled, instance }));
    }
    // A Module source instantiates; only BYTES are a compile, and only those
    // can be refused for it.
    if (source instanceof RealModule) return realInstantiate(source, imports);
    return realInstantiate(source, imports).catch((e) => { throw refusal(e, source); });
  };
  WA.__nimbusPrecompiledSeam = true;
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  RequestInit.cache, as Node takes it ─────────────────────────────
// Node's fetch keeps no HTTP cache, so the modes it accepts all go to the
// network. workerd accepts only "no-store" and "no-cache" (measured:
// "default", "reload" and "force-cache" throw "Unsupported cache mode"), and
// axios's fetch adapter passes cache: "default" on every request. A Request
// or fetch drops those three: the request goes to the network, as Node's
// would. What Node refuses ("only-if-cached" outside same-origin mode, an
// unknown mode) workerd refuses too, and is left to it.
const __nodeCacheInit = (init) => {
  if (!init || typeof init !== "object") return init;
  const mode = init.cache;
  if (mode !== "default" && mode !== "reload" && mode !== "force-cache") return init;
  const { cache, ...rest } = init;
  return rest;
};
if (typeof globalThis.Request === "function" && !globalThis.__nimbusNodeRequestInstalled) {
  globalThis.__nimbusNodeRequestInstalled = true;
  // A Proxy, not a subclass: every Request stays the platform's, so
  // instanceof holds for the ones the runtime itself makes.
  globalThis.Request = new Proxy(globalThis.Request, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, [args[0], __nodeCacheInit(args[1])], newTarget);
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ──  fetch default User-Agent ───────────────────────────────────────
// workerd's global fetch sends no User-Agent by default, but Node's
// undici fetch adds `User-Agent: node`. Servers that require a UA
// (notably GitHub's API, used by giget/create-* template downloaders)
// answer 403 to a UA-less request. Match Node by injecting the default
// UA only when the caller supplied none, preserving any explicit value.
// This also covers the http/https `request`/`get` shims, which route
// through this same global fetch.
(() => {
  if (typeof globalThis.fetch !== "function" || globalThis.__nimbusFetchUaInstalled) return;
  globalThis.__nimbusFetchUaInstalled = true;
  const __origFetch = globalThis.fetch.bind(globalThis);
  const __recordingNetwork = !!(__nimbusReplay && __nimbusReplay.outbound);
  const __networkResponses = __recordingNetwork ? new WeakMap() : null;
  const __networkBodies = __recordingNetwork ? new WeakMap() : null;
  const __observeBody = (body) => {
    const record = body && __networkBodies && __networkBodies.get(body);
    if (record && !record.done) {
      record.done = true;
      if (__nimbusReplay) { __nimbusReplay.observed("fetchBody"); __nimbusReplay.bodyFinished(record.id); }
    }
  };
  const __hasUa = (h) => {
    if (!h) return false;
    if (typeof h.get === "function") return h.get("user-agent") != null;
    if (Array.isArray(h)) return h.some((p) => String(p?.[0]).toLowerCase() === "user-agent");
    return Object.keys(h).some((k) => k.toLowerCase() === "user-agent");
  };
  const __loopbackHosts = new Set(["localhost","127.0.0.1","0.0.0.0","[::1]"]);
  const __fetchUrl = (input) => {
    try {
      const href = typeof input === "string" ? input
        : (input && typeof input === "object" && input.url) ? input.url : String(input);
      return new URL(href);
    } catch { return null; }
  };
  // Read one header off whatever the caller passed without constructing a
  // Request: `new Request(existing)` marks the original's body disturbed, and a
  // request we inspect but do not claim must still be sendable by real fetch.
  // `init.headers` replaces a Request's own headers, so it is consulted first.
  const __headerOf = (input, init, name) => {
    const h = (init && init.headers) || (typeof Request !== "undefined" && input instanceof Request ? input.headers : null);
    if (!h) return null;
    if (typeof h.get === "function") return h.get(name);
    if (Array.isArray(h)) {
      for (const pair of h) if (String(pair?.[0]).toLowerCase() === name) return String(pair?.[1]);
      return null;
    }
    for (const key of Object.keys(h)) if (key.toLowerCase() === name) return String(h[key]);
    return null;
  };
  // Strip the caller's AbortSignal before the RPC hop: workerd JSRPC does not
  // serialize Request.signal ("AbortSignal serialization is not enabled"), and
  // the opencode SDK stamps timeout signals on its startup requests — which
  // made 4/5 attach boot calls fail. Cancellation across the hop is advisory;
  // an aborted caller simply drops the response.
  const __supervisorRequest = (url, input, init) => (
    (typeof Request !== "undefined" && input instanceof Request)
      ? new Request(input, { ...(init || {}), signal: null })
      : new Request(url.href, { ...(init || {}), signal: null })
  );
  // In-session loopback: a facet's fetch to 127.0.0.1/localhost:<port> is routed
  // to the facet that owns <port> through the supervisor's port registry (the
  // same routing the shell curl/node loopback uses), so a facet can reach another
  // facet's server in-session (opencode attach reaching opencode serve). Returns
  // the target's Response (streamed over RPC, so SSE flows). Anything non-
  // loopback, or when no supervisor is bound, falls through to real fetch.
  const __maybeRouteLoopback = (url, input, init) => {
    if (!__loopbackHosts.has(url.hostname)) return null;
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    if (!Number.isFinite(port) || port <= 0) return null;
    return Promise.resolve(__supervisor.routeLoopback(port, __supervisorRequest(url, input, init)));
  };
  // AI-egress mediation: a request addressed anywhere on the network that
  // presents this session's AI capability token is inference the session owns,
  // so it is served by the session's own gateway (supervisor loopback port
  // 8790) instead of being sent out. That is how a tool holding a baked-in
  // vendor base URL — one that never reads OPENAI_BASE_URL — still reaches the
  // session's models with no configuration of its own.
  //
  // The match is on the credential, never on the destination: a request
  // carrying anything else (the user's own real provider key) is not ours, is
  // left alone, and goes to that provider. See _shared/ai-egress.ts.
  const __aiCredentialHeaders = ["authorization","x-api-key"];
  const __maybeRouteAiEgress = (url, input, init) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    let token = "";
    try { token = (env && env["NIMBUS_AI_TOKEN"]) || ""; } catch { return null; }
    if (!token) return null;
    for (const name of __aiCredentialHeaders) {
      const raw = __headerOf(input, init, name);
      if (!raw) continue;
      if (presentedCredential(String(raw)) !== token) continue;
      return Promise.resolve(__supervisor.routeLoopback(8790, __supervisorRequest(url, input, init)));
    }
    return null;
  };
  const __dispatch = (input, init) => {
    try {
      if (__supervisor && typeof __supervisor.routeLoopback === "function") {
        const url = __fetchUrl(input);
        const routed = url && (__maybeRouteLoopback(url, input, init) || __maybeRouteAiEgress(url, input, init));
        if (routed) return routed;
      }
    } catch { /* fall through to real fetch */ }
    const reqHasUa = typeof Request !== "undefined" && input instanceof Request && __hasUa(input.headers);
    if (reqHasUa || __hasUa(init && init.headers)) return __origFetch(input, init);
    const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
    headers.set("user-agent", "node");
    return __origFetch(input, { ...(init || {}), headers });
  };
  // Coherence at the outbound-fetch boundary (§0.2 witness 2 of the VFS
  // coherence protocol). A facet's fetch does not go through the supervisor:
  // the facet inherits the parent worker's network, so the response resumes
  // user code with no supervisor message an invalidation could ride on, and
  // an external third party can carry a happens-before edge between two
  // facets that never touches the authority.
  //
  // Both halves are sited here:
  //   RELEASE — this facet's parked writes are flushed before the request
  //     leaves, so nothing outside can observe an effect of a write the
  //     authority has not got yet.
  //   ACQUIRE — performed when the response lands, before the awaiting user
  //     code runs.
  //
  // ACQUIRE has to be AFTER the response, and the earlier design saying it
  // could ride concurrently with the request — free, hidden under the network
  // — was wrong, which a test caught rather than an argument. A concurrent
  // ACQUIRE is serviced at request time, so it reports the world as of when
  // the request left. The whole anomaly is that the RESPONSE encodes "the
  // write happened", so an ACQUIRE older than the response is exactly the one
  // that cannot see the write it is there to catch. That costs a real
  // supervisor round trip per outbound request, not a hidden one. It is the
  // price of the guarantee.
  //
  // The RELEASE barrier lives on globalThis because the fs module installs it
  // and is evaluated after this one; the ACQUIRE is __nimbusInboundBarrier.
  const __resumeCoherent = async (pending) => {
    const value = await pending;
    await __nimbusInboundBarrier();
    return value;
  };
  const __barriered = async (input, init) => {
    // A request other than a read may change something a second run of the
    // program would change again (runtime/stop-replay.ts). A read goes
    // through the session when the run can stop (its outbound), which records
    // the response and answers a run after a stop with it; a run whose network
    // does not go through the session cannot be run again once it used it.
    if (__nimbusReplay && __nimbusReplay.armed) {
      const method = String((init && init.method) || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
      if (!__nimbusReplay.outbound) __nimbusReplay.effect("used the network (" + method + " " + __fetchUrl(input) + "), which Nimbus does not record for this process");
      else if (method !== "GET" && method !== "HEAD") __nimbusReplay.effect(method + " " + __fetchUrl(input));
    }
    // The outbound uses its own supervisor binding. Like post-read calls
    // through the guest's proxy, it cannot pass the replay boundary notice.
    const afterRead = __nimbusReplay && __nimbusReplay.afterBoundary();
    if (afterRead) await afterRead;
    const release = globalThis.__nimbusVfsReleaseBarrier;
    if (typeof release === "function") await release();
    const pending = __resumeCoherent(__dispatch(input, init));
    if (!__recordingNetwork) return pending;
    let response;
    try { response = await pending; }
    catch (error) { if (__nimbusReplay && __nimbusReplay.outbound) __nimbusReplay.observed("fetchHeader"); throw error; }
    if (__nimbusReplay && __nimbusReplay.outbound) {
      __nimbusReplay.observed("fetchHeader");
      if (response.body) {
        const record = { id: __nimbusReplay.bodyStarted(String(__fetchUrl(input))), done: false };
        __networkResponses.set(response, record);
        __networkBodies.set(response.body, record);
      }
    }
    return response;
  };
  globalThis.fetch = function fetch(input, init) {
    return __nimbusTrackOp(__barriered(input, __nodeCacheInit(init)));
  };
  // A fetch settles once the headers arrive; reading the body is a SECOND
  // in-flight operation on the same connection, and `const r = await
  // fetch(u); const j = await r.json()` is the shape most programs use.
  // It is also a second resumption from the network, so it takes the same
  // ACQUIRE: a program that reads a file after parsing a response body is no
  // less entitled to current bytes than one that reads after the headers.
  for (const __name of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
    const __orig = Response.prototype[__name];
    if (typeof __orig !== "function") continue;
    try {
      Response.prototype[__name] = function(...args) {
        if (!__recordingNetwork) return __nimbusTrackOp(__resumeCoherent(__orig.apply(this, args)));
        const body = this.body;
        const pending = __orig.apply(this, args).then((value) => { __observeBody(body); return value; }, (error) => { __observeBody(body); throw error; });
        return __nimbusTrackOp(__resumeCoherent(pending));
      };
    } catch { /* host object is sealed — the drain still sees the fetch itself */ }
  }
  // No stdin/outbound journal: keep native stream readers and cloning intact.
  if (!__recordingNetwork) return;
  const __getReader = ReadableStream.prototype.getReader;
  const __cloneResponse = Response.prototype.clone;
  Response.prototype.clone = function(...args) {
    const clone = __cloneResponse.apply(this, args);
    const record = __networkResponses.get(this);
    if (record && clone.body) { __networkResponses.set(clone, record); __networkBodies.set(clone.body, record); }
    return clone;
  };
  const __readerBodies = new WeakMap();
  ReadableStream.prototype.getReader = function(...args) {
    const reader = __getReader.apply(this, args);
    if (__networkBodies.has(this)) __readerBodies.set(reader, this);
    return reader;
  };
  for (const Reader of [ReadableStreamDefaultReader, typeof ReadableStreamBYOBReader === "function" ? ReadableStreamBYOBReader : null]) {
    if (!Reader) continue;
    const read = Reader.prototype.read;
    Reader.prototype.read = function(...args) {
      const body = __readerBodies.get(this);
      const pending = read.apply(this, args);
      if (!body) return pending;
      return __nimbusTrackOp(pending.then((value) => { if (value.done) __observeBody(body); return value; }, (error) => { __observeBody(body); throw error; }));
    };
  }
})();

let __nimbusLiveStdinPump = null;
let __nimbusProcessExitReported = false;
// Set when the program has exited: its timers are cleared and its writes refused.
let __nimbusProgramStopped = false;
let __nimbusExitEmitted = false;
// 'exit' listeners run once, synchronously, before the program is stopped.
function __nimbusEmitExit(code) {
  if (__nimbusExitEmitted) return;
  __nimbusExitEmitted = true;
  try { __processEvents.emit("exit", code); } catch {}
}
// The news of this process's children, applied as each reply's effect is
// (__nimbusApplyNews), and what it says of itself to the session as that
// changes (facets/manager.ts __nimbusReportBlockedState): whether its only
// remaining work is waiting on its children, at which frontier (child-news.ts).
// A blocked program runs again only on news of a child (it has no timer,
// socket or read of its own), so the session takes the report only while
// the frontier is all the news it issued (fabric budgets.ts
// setProcessBlocked). Sent unref'd, in order: saying it is not work, and
// must not make the program look busy.
let __nimbusBlockedChain = Promise.resolve();
const __nimbusChildNews = (function createChildNews(send) {
  let frontier = 0;
  const ahead = new Set();
  let said = "";
  let seq = 0;
  return {
    apply(numbers) {
      if (!Array.isArray(numbers)) return;
      for (const n of numbers) if (typeof n === "number" && n > frontier) ahead.add(n);
      while (ahead.delete(frontier + 1)) frontier++;
    },
    say(blocked) {
      const key = blocked ? "blocked@" + frontier : "running";
      if (key === said || (!blocked && said === "")) return;
      said = key;
      send({ blocked: blocked === true, frontier, seq: ++seq });
    },
    inspect() {
      return { frontier, ahead: [...ahead].sort((a, b) => a - b), said, seq };
    },
  };
})((report) => {
  __nimbusBlockedChain = __nimbusBlockedChain
    .then(() => __nimbusUseRpcResultUnref(__supervisor.cpBlocked(report), () => undefined))
    .catch(() => {});
});
globalThis.__nimbusApplyNews = (numbers) => __nimbusChildNews.apply(numbers);
globalThis.__nimbusReportBlocked = (blocked) => {
  if (__nimbusProgramStopped) return;
  if (!__supervisor || typeof __supervisor.cpBlocked !== "function") return;
  __nimbusChildNews.say(blocked);
};
let __nimbusProcessExitResolve = null;
let __nimbusProcessExitCode = null;
const __nimbusProcessExitPromise = new Promise((resolve) => {
  __nimbusProcessExitResolve = resolve;
});

// ═══════════════════════════════════════════════════════════════════════
// ──  path module ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// A VFS key's normalization: "." and "" segments dropped, ".." applied,
// no trailing slash. Nimbus's own fs and resolver keys, not userland's path.
function __vfsNormalizePath(p) {
  const parts = p.split("/");
  const out = [];
  for (const s of parts) {
    if (s === "..") { if (out.length && out[out.length-1] !== "..") out.pop(); else out.push(s); }
    else if (s !== "." && s !== "") out.push(s);
  }
  return (p.startsWith("/") ? "/" : "") + out.join("/");
}
// Userland's path is workerd's node:path, Node's own lib/path.js
// (https://developers.cloudflare.com/workers/runtime-apis/nodejs/path/).
// A hand-rolled join kept empty segments, so totalist's
// `join("", "hello.txt")` was "/hello.txt" and sirv mapped every file under
// "//name" and answered 404. Only resolution is the process's: resolve and
// relative start from its cwd, not the Worker's.
const __pathMod = (() => {
  const native = typeof __real_path !== "undefined"
    ? (__real_path.default ?? __real_path) : globalThis.process.getBuiltinModule("path");
  const posix = native.posix ?? native;
  const resolve = (...p) => posix.resolve(cwd || "/home/user", ...p);
  const mod = {
    ...posix,
    resolve,
    relative: (from, to) => posix.relative(resolve(from), resolve(to)),
    win32: native.win32,
  };
  mod.posix = mod;
  return mod;
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  Native Buffer ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Workers' native Buffer is already used by crypto, zlib and node:http.
// Keep that one constructor everywhere: a second partial implementation lost
// offsets, UTF-16 writes and numeric/prototype APIs required by napi and Vite.
// Non-Workers embedders obtain the same native module through their Node API;
// there is deliberately no emulated Buffer fallback.
const __bufferModule = typeof __real_buffer !== "undefined"
  ? (__real_buffer.default ?? __real_buffer) : globalThis.process?.getBuiltinModule?.("node:buffer");
if (!__bufferModule?.Buffer) throw new Error("Nimbus node runtime requires native node:buffer");
const __BufferMod = __bufferModule.Buffer;

// ═══════════════════════════════════════════════════════════════════════
// ──  Process output is bytes ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// A process's stdout and stderr are byte streams: esbuild's service protocol
// is binary packets, and so is any program piping an image or an archive.
// The relay to the supervisor carries Uint8Array; a text producer encodes
// at its own edge, and the facet's REPORTED result — the `stdout`/`stderr`
// strings the wrapper declares — decodes at its edge with one streaming
// decoder per stream, so a multibyte character split across two writes
// still reads as one character.
const __nimbusOutEnc = new TextEncoder();
const __nimbusOutDec = { stdout: new TextDecoder("utf-8"), stderr: new TextDecoder("utf-8") };
/** `process.stdout.write(d, enc)` payload as bytes. */
function __nimbusOutBytes(d, enc) {
  if (d instanceof Uint8Array) return d;
  if (typeof d === "string") {
    return typeof enc === "string" && enc !== "utf8" && enc !== "utf-8"
      ? __BufferMod.from(d, enc)
      : __nimbusOutEnc.encode(d);
  }
  return __nimbusOutEnc.encode(String(d));
}
/** Decode one stream's bytes into its text accumulator, streaming. */
function __nimbusOutText(streamName, bytes) {
  return __nimbusOutDec[streamName === "stderr" ? "stderr" : "stdout"].decode(bytes, { stream: true });
}

/**
 * What the resident set holds under a directory prefix — the ONE question the
 * shims ask of it that a plain object cannot answer cheaply.
 *
 * The resident set is two things: a plain object on the heap, where the only
 * way to ask is to walk every key, and a table in the facet's own SQLite, where
 * the paths ARE a PRIMARY KEY index and the answer is a range scan. Asking the
 * object way against the table is what made a single `existsSync` of a
 * directory cost the whole filesystem — a `for..in` over the Proxy pulls every
 * key AND, through the descriptor trap, every file's bytes. Measured at pi
 * scale (19,470 files / 95 MiB): 222 ms, 17,821 chunk queries and 87 MiB of
 * content read and thrown away, PER CALL, against 1 ms and no content read for
 * the range scan. Node's module resolution does that lookup constantly, so the
 * two ways are not a style choice — one of them exhausts the process's CPU
 * budget on its own.
 *
 * Every prefix site in the shims goes through these, so the store's index is
 * reached from one place rather than nine, and the heap fallback stays the
 * literal walk it always was.
 */
function __residentUnder(prefix) {
  if (typeof __residentKeysUnder === "function") return __residentKeysUnder(prefix);
  const out = [];
  if (__vfsBundle) for (const bk in __vfsBundle) if (bk.startsWith(prefix)) out.push(bk);
  return out;
}

/** Whether ANYTHING is held under a prefix. The hot half — never materializes. */
function __residentAnyUnder(prefix) {
  if (typeof __residentHasUnder === "function") return __residentHasUnder(prefix);
  if (__vfsBundle) for (const bk in __vfsBundle) if (bk.startsWith(prefix)) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// ──  fs.constants (linux x64) ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// The ONE table behind fs.constants, fs.promises.constants, and the fs slice
// of node:constants / process.binding('fs'). Values are real Node on Linux
// x64 (node -p 'require("fs").constants'). Packages compose open flags from
// this table at module init — modern-tar (create-astro via @bluwy/giget-core)
// computes O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW|O_EXCL and passes the number
// to fs.open — so a partial table silently degrades every such open to
// O_RDONLY (0) and every extraction fails ENOENT. Frozen, as Node's is.
const __fsConstants = Object.freeze({
  // ── libuv fs flags ────────────────────────────────────────────────
  UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2,
  // ── open(2) flags ─────────────────────────────────────────────────
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
  UV_DIRENT_UNKNOWN: 0, UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2, UV_DIRENT_LINK: 3,
  UV_DIRENT_FIFO: 4, UV_DIRENT_SOCKET: 5, UV_DIRENT_CHAR: 6, UV_DIRENT_BLOCK: 7,
  EXTENSIONLESS_FORMAT_JAVASCRIPT: 0, EXTENSIONLESS_FORMAT_WASM: 1,
  // ── stat.mode file-type bits ──────────────────────────────────────
  S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192,
  S_IFBLK: 24576, S_IFIFO: 4096, S_IFLNK: 40960, S_IFSOCK: 49152,
  O_CREAT: 64, O_EXCL: 128, UV_FS_O_FILEMAP: 0, O_NOCTTY: 256, O_TRUNC: 512,
  O_APPEND: 1024, O_DIRECTORY: 65536, O_NOATIME: 262144, O_NOFOLLOW: 131072,
  O_SYNC: 1052672, O_DSYNC: 4096, O_DIRECT: 16384, O_NONBLOCK: 2048,
  // ── stat.mode permission bits ─────────────────────────────────────
  S_IRWXU: 448, S_IRUSR: 256, S_IWUSR: 128, S_IXUSR: 64,
  S_IRWXG: 56, S_IRGRP: 32, S_IWGRP: 16, S_IXGRP: 8,
  S_IRWXO: 7, S_IROTH: 4, S_IWOTH: 2, S_IXOTH: 1,
  // ── fs.access modes ───────────────────────────────────────────────
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  // ── fs.copyFile modes (libuv shape + Node alias) ──────────────────
  UV_FS_COPYFILE_EXCL: 1, COPYFILE_EXCL: 1,
  UV_FS_COPYFILE_FICLONE: 2, COPYFILE_FICLONE: 2,
  UV_FS_COPYFILE_FICLONE_FORCE: 4, COPYFILE_FICLONE_FORCE: 4,
});

// ═══════════════════════════════════════════════════════════════════════
// ──  fs shim (VFS-backed) ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __fsMod = (() => {
  const _enc = new TextEncoder();
  const _dec = new TextDecoder();

  // ── byte-shape helpers (binary-fs wave) ──
  // __vfsWrites + __vfsBundle now carry `Uint8Array | string`. Strings
  // are the hot path (module source, package.json, user JS); bytes are
  // the binary-fs path (wasm modules, images, binary protocol payloads).
  // Pre-fix the Uint8Array branch UTF-8-decoded the bytes to a string,
  // which mangled every byte ≥ 0x80 to U+FFFD (3-byte EF BF BD on the
  // re-encode), corrupting all binary fs writes. See
  function _isBytes(v) { return v instanceof Uint8Array; }
  // Length in bytes regardless of shape — used by statSync's size field
  // and the bundle-cap accounting on the host side.
  function _byteLen(v) {
    if (_isBytes(v)) return v.byteLength;
    if (typeof v === "string") return _enc.encode(v).length;
    return 0;
  }
  // Coerce to bytes for binary-write paths. Strings are UTF-8-encoded
  // (lossless for valid Unicode); bytes pass through.
  function _asBytes(v) {
    if (_isBytes(v)) return v;
    if (typeof v === "string") return _enc.encode(v);
    return new Uint8Array(0);
  }
  // Coerce to string for text-read paths. Bytes are UTF-8-decoded
  // (lossy for invalid sequences — same caveat as Node's
  // `Buffer.toString('utf8')`); strings pass through.
  function _asString(v) {
    if (typeof v === "string") return v;
    if (_isBytes(v)) return _dec.decode(v);
    return "";
  }

  // ── helpers ──
  function _strip(p) { return String(p).replace(/^\/+/, ""); }
  function _resolve(p) {
    // X.5-O: WHATWG-URL → POSIX path coercion. Pre-fix String(p) on
    // a URL instance or 'file://' string produced 'file:///package.json';
    // that failed the startsWith('/') guard below and got misrouted via
    // path.resolve(cwd, 'file:///…') → corrupt path → ENOENT (verify-90993b3
    // §3 bucket O: vite). Strip 'file://' and unwrap URL instances first.
    let s;
    if (p && typeof p === "object" && p.protocol === "file:" && typeof p.pathname === "string") {
      // URL instance — pathname is already a POSIX path with leading /
      try { s = decodeURIComponent(p.pathname); } catch { s = p.pathname; }
    } else {
      s = String(p);
      if (s.startsWith("file://")) {
        // 'file:///abs' → '/abs', 'file://host/abs' → '/abs'
        const tail = s.slice(7);
        const slashIdx = tail.indexOf("/");
        const pathPart = tail.startsWith("/") ? tail : (slashIdx >= 0 ? tail.slice(slashIdx) : "/" + tail);
        try { s = decodeURIComponent(pathPart); } catch { s = pathPart; }
      }
    }
    if (s.startsWith("/")) return __vfsNormalizePath(s);
    return __vfsNormalizePath(__pathMod.resolve(cwd || "/home/user", s));
  }

  // ── VFS bundle lookup (fast path — in-memory) ──
  function _bundleLookup(absPath) {
    const k = _strip(absPath);
    if (globalThis.__nimbusProfileStaged) globalThis.__nimbusProfileStaged.delete(k);
    // The parked write first, as _writtenCell reads: it is this process's own,
    // newer than anything the store holds, and it is the live cell (a store
    // read reassembles a copy, which a write loop would pay for per write).
    if (__vfsWrites && k in __vfsWrites) return __vfsWrites[k];
    if (__vfsBundle && k in __vfsBundle) return __vfsBundle[k];
    // The same bytes under the name they are held by: through a symlink, or
    // under the old name of a rename this process has not seen land yet.
    // A parked write is in the bundle too (_parkWrite).
    if (__vfsBundle && _nsActive()) {
      const held = _nsHeldKey(k);
      if (held !== null && held !== k && held in __vfsBundle) return __vfsBundle[held];
    }
    return undefined;
  }

  // Whether the store is bound: every embedding of these shims boots one (a
  // facet's SQLite, or a one-shot's heap), and this is the single place that asks.
  function _residentStorePresent() {
    return typeof __residentAdmit === "function" && typeof __residentReady !== "undefined" && __residentReady;
  }

  // ── The namespace (resident facets) ──
  //
  // A resident facet's store holds every name the credential can see, with
  // its stat, exact at the cursor (vfs/facet-resident-store.ts). While it
  // does, it answers every synchronous metadata question — stat, exists,
  // readdir, realpath, access — and an absent name is known absent, so none
  // of them records a miss or refuses. While it does not (a relist failed,
  // until the next barrier repairs it), each of them is refused by name
  // (_nsRequire).
  //
  // What the table cannot know is this process's own structural effects that
  // the authority has not reported back yet, so those sit in an overlay, one
  // entry per path: "absent" / "absentTree" (unlink, rmdir, rm), "dir"
  // (mkdir; `hide` when nothing was there, so no stale child shows through)
  // and "alias" (a rename: the new name denotes what the old one did). An
  // entry retires once its mutation has settled AND a barrier begun after
  // that has applied, because such a barrier's delta is answered after the
  // mutation committed, so the table then shows it or anything later.
  function _nsActive() {
    return typeof __nsReady === "function" && __nsReady();
  }
  // The namespace answers every synchronous metadata question, or none. While
  // it is not ready (a relist failed, until the next barrier repairs it) a
  // synchronous call is refused, naming why and the asynchronous form that
  // answers now. A launch never runs user code before it is ready.
  function _nsRequire(syscall, displayPath, asyncForm) {
    if (_nsActive()) return;
    _stats.namespaceRefusals++;
    const why = typeof __nsNotReadyCause === "function" ? __nsNotReadyCause() : "the process was started without one";
    const err = _fsErr("EAGAIN", syscall, displayPath);
    err.message = "EAGAIN: " + syscall + " '" + String(displayPath) + "': the namespace is being rebuilt after " + why
      + (_supervisor() ? "; use " + asyncForm : "");
    throw err;
  }
  /**
   * The mount point when the namespace cannot say whether `absPath` is there:
   * it is on a mount, in a directory the launch did not list (not named by
   * it, or past its bound). With `listing`, also when `absPath` is such a
   * directory, whose entries are not known. Null when the namespace knows.
   */
  function _nsUnlisted(absPath, follow, listing) {
    return _nsActive() && typeof __nsUnknown === "function" ? __nsUnknown(_strip(absPath), follow !== false, !!listing) : null;
  }
  /**
   * What a synchronous call answers on a mounted path its launch did not
   * list: the refusal the namespace gives any caller that cannot wait on an
   * asynchronous mount, and the asynchronous form that answers.
   */
  function _nsUnlistedErr(mount, syscall, displayPath, asyncForm, dest) {
    _stats.namespaceRefusals++;
    const err = _fsErr("EAGAIN", syscall, displayPath, dest);
    err.message = "EAGAIN: " + syscall + " '" + String(displayPath) + "'" + (dest === undefined ? "" : " -> '" + dest + "'") + ": " + mount
      + " is an asynchronous mount; this caller cannot wait for it"
      + (_supervisor() ? "; " + asyncForm + " reads it" : "");
    return err;
  }
  /** ENOENT for a name the namespace knows is not there; its refusal for one on a mount it did not list. */
  function _absentErr(absPath, syscall, displayPath, asyncForm, follow) {
    const mount = _nsUnlisted(absPath, follow, false);
    return mount === null ? _fsErr("ENOENT", syscall, displayPath) : _nsUnlistedErr(mount, syscall, displayPath, asyncForm);
  }
  const _nsOwn = new Map();
  let _nsFresh = [];
  let _barrierBegins = 0;
  function _nsOwnSet(k, state, extra) {
    const before = _nsOwn.get(k);
    const entry = { state, from: extra?.from, link: extra?.link, hide: !!extra?.hide, settled: null };
    try { __residentNamespaceOverlayDelta(_nsOwnCost(k, entry) - (before ? _nsOwnCost(k, before) : 0)); }
    catch (error) {
      // The view is sealed by the store. Let the already-projected structural
      // operation reach its authority/ack; aborting midway would strand
      // earlier overlays with no owning mutation to retire them.
      if (__residentInHeap && error?.code === "ENOSPC") return;
      throw error;
    }
    _nsOwn.set(k, entry);
    _nsFresh.push(entry);
  }
  function _nsOwnCost(k, entry) { return __namespaceRowBytes("", k, (entry.from ?? "") + (entry.link ?? "")); }
  /** Hand the overlay entries made since the last mutation to the one being queued. */
  function _nsTakeFresh() {
    const mine = _nsFresh;
    _nsFresh = [];
    return () => { for (const entry of mine) if (entry.settled === null) entry.settled = _barrierBegins; };
  }
  function _nsRetire(begin) {
    for (const [k, entry] of _nsOwn) if (entry.settled !== null && entry.settled < begin) {
      _nsOwn.delete(k);
      __residentNamespaceOverlayDelta(-_nsOwnCost(k, entry));
    }
  }

  /**
   * The overlay's word on `k`: "absent", { alias } (look the table up at
   * this key instead), { dir } (own directory), { hide } (the table knows
   * nothing under an own fresh directory), or null (ask the table).
   *
   * An alias's `link`: the moved name is a symlink, whose own entry (what
   * lstat sees) is the table's row at that key. `alias` is what following
   * it reaches, absent when that is nothing (a dangling link, a loop).
   */
  function _nsOwnView(k) {
    if (_nsOwn.size === 0) return null;
    const own = _nsOwn.get(k);
    if (own) {
      if (own.state === "absent" || own.state === "absentTree") return "absent";
      if (own.state === "alias") return { alias: own.from, link: own.link };
      return { dir: true };
    }
    for (let i = k.lastIndexOf("/"); i > 0; i = k.lastIndexOf("/", i - 1)) {
      const above = _nsOwn.get(k.slice(0, i));
      if (!above) continue;
      if (above.state === "absent" || above.state === "absentTree") return "absent";
      if (above.state === "alias") return above.from === undefined ? "absent" : { alias: above.from + k.slice(i) };
      if (above.hide) return { hide: true };
    }
    return null;
  }

  /**
   * The key an operation that follows symlinks lands on: every link on `k`
   * followed, the last one too, as open(2) and chmod(2) follow them; null on
   * a loop. It is the name a barrier reports when that file changes, so
   * this process's own state for it (parked bytes, a pending mode or times,
   * a creation, a resident fill) is kept there. Kept under a link's own
   * name, a write became a regular file where the link is, and nothing a
   * later write to the target reported ever replaced it.
   *
   * The namespace resolves it, as the authority will. `k` as given when the
   * namespace cannot say: it is not active, or this process's own unsettled
   * rename, unlink or mkdir is on the path, which the table does not show.
   */
  function _nsLandingKey(k) {
    if (!_nsActive() || _nsOwnView(k) !== null) return k;
    const found = __nsLookup(k, true);
    return found === "ELOOP" ? null : found.path;
  }

  /** `p` resolved to the path an operation that follows symlinks lands on (_nsLandingKey). */
  function _resolveFollow(p, syscall) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    const landing = _nsLandingKey(k);
    if (landing === null) throw _fsErr("ELOOP", syscall, p);
    return landing === k ? absPath : "/" + landing;
  }

  /**
   * Where the bytes `k` denotes are held, if they are anywhere: symlinks
   * followed, and the old name of this process's own rename that has not
   * landed. A name the table does not list yet is held too (a file this
   * process made through a link). Null when nothing can be there.
   */
  function _nsHeldKey(k) {
    const own = _nsOwnView(k);
    if (own === "absent" || (own && (own.dir || own.hide))) return null;
    const found = __nsLookup(own && own.alias !== undefined ? own.alias : k, true);
    return found === "ELOOP" ? null : found.path;
  }

  /** The table key of the entry `k` names itself, a link not followed (overlay and the links above it applied), or null. */
  function _nsEntryKey(k) {
    const own = _nsOwnView(k);
    if (own === "absent" || (own && (own.dir || own.hide))) return null;
    const found = __nsResolve(own && own.link !== undefined ? _nsMovedEntry(k, own) : own && own.alias !== undefined ? own.alias : k, false);
    return found && found !== "ELOOP" ? found.path : null;
  }

  /**
   * The table key of a symlink this process moved to `k` (_nsOwnView's
   * `link`): its row under the old name, or under `k` once the move is
   * reported and the old row gone. Only the link's own entry reads this; the
   * overlay still stands between `k` and everything that follows it, until
   * the rename's own answer retires it.
   */
  function _nsMovedEntry(k, own) {
    return __nsRowAt(__residentRequire(), own.link) !== undefined ? own.link : k;
  }

  /** The table key `k` denotes (overlay and symlinks applied), or null. */
  function _nsRealKey(k) {
    const held = _nsHeldKey(k);
    return held !== null && __nsRowAt(__residentRequire(), held) !== undefined ? held : null;
  }

  function _nsRowMeta(row) {
    const kind = Number(row.kind);
    return {
      type: kind === 1 ? "directory" : kind === 2 ? "symlink" : "file",
      size: Number(row.size), mode: Number(row.mode), uid: Number(row.uid), gid: Number(row.gid),
      atime: Number(row.atime), mtime: Number(row.mtime), ctime: Number(row.ctime),
      ino: Number(row.ino),
    };
  }

  /**
   * Everything the namespace says about `k`: a stat record, "absent", or
   * "ELOOP". Own pending writes and directories first, then the overlay,
   * then the table, then content this process wrote that the table has not
   * caught up with.
   */
  function _nsMeta(k, follow) {
    if (k === "") return _nsRowMeta(__nsResolve("", true).row);
    if (__vfsWrites && k in __vfsWrites && _denialCode(__vfsWrites[k]) === null) {
      const size = _byteLen(__vfsWrites[k]);
      if (_createdHere.has(k)) {
        return { type: "file", size, mode: 0o100666 & ~__processUmask, uid: cred.uid, gid: cred.gid, own: true };
      }
      // A rewrite of a file that was there: its owner and mode stay what the
      // authority says they are, under the name it had before a rename.
      const renamed = _nsOwnView(k);
      const found = __nsResolve(renamed && renamed.alias !== undefined ? renamed.alias : k, follow);
      if (found && found !== "ELOOP" && Number(found.row.kind) === 0) return { ..._nsRowMeta(found.row), size };
    }
    const own = _nsOwnView(k);
    if (own === "absent") return "absent";
    if (own && own.dir) return { type: "directory", size: 0, mode: 0o40777 & ~__processUmask, uid: cred.uid, gid: cred.gid, own: true };
    // A symlink this process moved is still a link to lstat.
    if (!follow && own && own.link !== undefined) {
      const found = __nsResolve(_nsMovedEntry(k, own), false);
      if (found === "ELOOP") return "ELOOP";
      return found ? _nsRowMeta(found.row) : "absent";
    }
    // A directory this process made hides what the namespace held under its
    // name before, but not what this process has put there since: those rows
    // are its own writes, recorded when the authority accepted them.
    if (!own || own.alias !== undefined || (own.hide && _createdHere.has(k))) {
      const found = __nsResolve(own && own.alias !== undefined ? own.alias : k, follow);
      if (found === "ELOOP") return "ELOOP";
      if (found) return _nsRowMeta(found.row);
      // Followed to a name the table does not list yet: a file this process
      // made through the link, which its own write holds.
      if (follow) {
        const held = _nsHeldKey(k);
        if (held !== null && held !== k && __vfsWrites && held in __vfsWrites) return _nsMeta(held, false);
      }
    }
    // The namespace is exact, so a name it lacks is not there, whatever bytes
    // the module map carries under it (a file removed since the map was
    // built). Content never stands in for metadata.
    return "absent";
  }

  /** Names directly under directory `k`: Map name → type. */
  function _nsList(k) {
    const names = new Map();
    const own = _nsOwnView(k);
    if (own !== "absent" && !(own && own.hide) && !(own && own.dir && _nsOwn.get(k)?.hide)) {
      const real = __nsResolve(own && own.alias !== undefined ? own.alias : k, true);
      if (real && real !== "ELOOP") {
        for (const child of __nsChildren(real.path)) {
          names.set(child.name, child.kind === 1 ? "directory" : child.kind === 2 ? "symlink" : _direntTypeOfMode(child.mode, "file"));
        }
      }
    }
    const prefix = k ? k + "/" : "";
    if (__vfsWrites) {
      for (const wk in __vfsWrites) {
        if (!wk.startsWith(prefix)) continue;
        const rest = wk.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (rest) names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? "file" : "directory");
      }
    }
    for (const [ok, entry] of _nsOwn) {
      if (!ok.startsWith(prefix) || ok.slice(prefix.length).includes("/")) continue;
      const name = ok.slice(prefix.length);
      if (entry.state === "absent" || entry.state === "absentTree") { if (!(__vfsWrites && ok in __vfsWrites)) names.delete(name); }
      else if (entry.state === "dir") names.set(name, "directory");
      else {
        const meta = _nsMeta(ok, false);
        if (meta !== "absent" && meta !== "ELOOP") names.set(name, meta.type);
      }
    }
    return names;
  }

  function _metadata(absPath) {
    _nsRequire("stat", absPath, "fs.promises.stat");
    const meta = _nsMeta(_strip(absPath), true);
    return meta === "absent" || meta === "ELOOP" ? undefined : meta;
  }

  function _denialCode(cell) {
    return cell && typeof cell === "object" && !(cell instanceof Uint8Array) &&
      typeof cell.error === "string" ? cell.error : null;
  }

  // Removal retracts the path from the sync existence view: the namespace's
  // overlay of this process's own effects says it is gone until a barrier's
  // delta does.
  function _forgetSyncPath(k) {
    delete _ownWriteTimes[k];
    _createdHere.delete(k);
    _announcedDirs.delete(k);
    _nsOwnSet(k, "absent");
  }

  /**
   * Park a synchronous mutation: the cell the program reads back, the record
   * that the path is there, and the retirement of any revision stamp the old
   * content carried. One place, because every sync mutation owes all three.
   */
  function _parkWrite(k, cell) {
    _noteCreation(k);
    _ownWriteTimes[k] = Date.now();
    __vfsWrites[k] = cell;
    if (__vfsBundle) __vfsBundle[k] = cell;
    delete __vfsBundleRevisions[k];
  }

  /**
   * The paths this process itself created, whose owner and mode are its own:
   * its uid and gid, and what its umask leaves. Every other stat answer comes
   * from the authority's metadata, and a path the authority never described
   * is not given one. A stat invented from the reader's own credential made a
   * root-owned file read as the reader's own and writable.
   *
   * A path counts as created when nothing was there before the write and the
   * view KNOWS nothing was there. Unknown is not created: a file the process
   * never staged may exist at the authority, owned by someone else.
   */
  const _createdHere = new Set();
  function _noteCreation(k) {
    if (_createdHere.has(k)) return;
    const absPath = "/" + k;
    // Known absent: the namespace names everything this credential can see,
    // except on a mount where the launch did not list it, which is unknown.
    if (_statLadder(absPath) !== undefined || _nsUnlisted(absPath, true, false) !== null) return;
    _createdHere.add(k);
  }
  function _forgetCreation(k) {
    const prefix = k + "/";
    for (const key of [..._createdHere]) if (key === k || key.startsWith(prefix)) _createdHere.delete(key);
  }

  function _forgetSyncTree(k) {
    const prefix = k + "/";
    _forgetCreation(k);
    _nsOwnSet(k, "absentTree");
    for (const dir of _announcedDirs) if (dir.startsWith(prefix)) _announcedDirs.delete(dir);
    _forgetSyncPath(k);
  }

  /**
   * The honest error for a sync read the resident view cannot serve. A facet
   * has no synchronous I/O primitive, so a sync read is limited to content
   * staged into this process, but the namespace names every path the
   * credential can see. ENOENT is correct only when it names none; for a path
   * that exists it would send the caller hunting for a missing file instead
   * of awaiting the read that would return it.
   */
  function _notResidentError(absPath, displayPath, syscall, asyncForm) {
    const st = _statLadder(absPath);
    if (st === undefined) return _absentErr(absPath, syscall, displayPath, asyncForm);
    if (st.isDirectory()) return _fsErr("EISDIR", syscall, displayPath);
    // Unreadable to this credential: the namespace's mode says so, and no
    // bytes could have been staged for it.
    if (!_modeAllows(st, 4)) return _fsErr("EACCES", syscall, displayPath);
    if (typeof __residentStorageMiss === "function" && __residentStorageMiss(_strip(absPath))) {
      // The process's own write, which neither its store nor its heap budget
      // could hold: the workspace's storage is full.
      const full = _fsErr("ENOSPC", syscall, displayPath);
      full.message = "ENOSPC: workspace storage is full; '" + String(displayPath) + "' is readable asynchronously"
        + (_supervisor() ? " (" + asyncForm + ")" : "");
      return full;
    }
    _recordResidencyMiss(absPath);
    const err = _fsErr("EAGAIN", syscall, displayPath);
    err.message += " — '" + String(displayPath) + "' exists but its content is not " +
      "resident in this facet, and synchronous I/O cannot block to fetch it" +
      // The async form only reaches the live VFS when a supervisor is bound;
      // without one it re-enters this same resident view, so promising that
      // it would return the bytes would be its own lie.
      (_supervisor() ? "; " + asyncForm + " reads it from the live filesystem" : "");
    return err;
  }

  /**
   * Every path a synchronous access asked for and did not get.
   *
   * EAGAIN is the honest code, and it is still one no program branches on:
   * it cannot arise from a read of a real POSIX regular file, so no library
   * has a handler for it. Whatever catch block does receive it was written
   * for a file that is missing, and the reader carries on with the answer it
   * prepared for that — a wrong answer, silently. Throwing alone therefore
   * cannot be the whole behaviour; the miss is recorded too, and two
   * consumers read the record for different reasons:
   *
   *   - The runner, at exit: an entry that survived to the end was never
   *     answered, so the program's result rests on a read that failed. It
   *     names the files and exits non-zero rather than let that report
   *     success.
   *   - The supervisor, from the exit envelope: the next bundle built for
   *     the same entry stages exactly these paths, so the miss stops
   *     recurring. Observation, not a guess about what a program will read.
   *
   * An entry clears only when the PROGRAM is handed the bytes for that path.
   * Residency repaired behind its back does not un-answer the access that
   * already failed.
   */
  const _residencyMisses = globalThis.__nimbusVfsResidencyMisses
    || (globalThis.__nimbusVfsResidencyMisses = new Set());

  function _recordMiss(k) {
    if (k === "" || _residencyMisses.has(k)) return;
    _residencyMisses.add(k);
    if (typeof __nimbusNotifyRuntimeCode === "function") __nimbusNotifyRuntimeCode();
    _stats.misses++;
  }

  /**
   * Repairs already issued, so each one costs one round trip.
   *
   * Kept apart from the ledger above because the two answer different
   * questions and a path can need both: the same file can be refused first
   * for being unmapped, which is repaired by fetching its parent's listing,
   * and then for having no resident content, which is repaired by fetching
   * the file. Sharing one set let the second repair be swallowed by the
   * first, and the read never became answerable.
   */
  const _faulted = new Set();
  function _faultOnce(kind, k) {
    const token = kind + ":" + k;
    if (_faulted.has(token)) return false;
    _faulted.add(token);
    return true;
  }

  /**
   * Paths the authority did not have when the access was refused.
   *
   * What the exit report asks is whether the program's result rests on a read
   * that failed, and that is not the same question as whether the path is
   * there NOW. A program told there is no config writes one, so by the time
   * the run ends the file exists — authored by the program itself, out of the
   * very branch the not-found answer sent it down. Nothing was withheld from
   * it. Measured: create-next-app's update notifier reads /tmp/update-check,
   * does not find it, writes it, and the whole scaffold was failed over a file
   * that had never existed; c3 does the same with its wrangler metrics file.
   *
   * So the repair records what it saw, and it asks with a stat rather than a
   * read. A read flushes this facet's pending writes to the authority before
   * issuing, so it would hand back the bytes the program had just parked and
   * report the path as one that was there all along.
   */
  const _observedAbsent = new Set();

  // The miss is the access the program made; the fault-in reads, and so
  // holds, the file the links on it name by that file's own name.
  function _recordResidencyMiss(absPath) {
    const k = _strip(absPath);
    _recordMiss(k);
    _faultIn(_nsLandingKey(k) ?? k);
  }

  function _residencySatisfied(absPath) {
    if (_residencyMisses.size === 0) return;
    const k = _strip(absPath);
    _residencyMisses.delete(k);
    // A descriptor opened through a link misses under the file it names.
    const held = _nsActive() ? _nsHeldKey(k) : null;
    if (held !== null) _residencyMisses.delete(held);
  }

  /**
   * Fault the page in.
   *
   * The access that missed cannot be served — no continuation exists to
   * suspend — but the bytes can be resident before the next one. A program
   * that retries, a later phase that reaches the same file, a second module
   * reading the same data: all of those are refused a second time for a
   * reason that was already repairable after the first.
   *
   * One round trip per path, ever: the ledger above is the dedupe, so a read
   * loop over a non-resident file costs one fetch rather than one per turn.
   *
   * Nothing awaits the fill, but it rides the same RPC accounting every other
   * read does, so the drain settles it before teardown. That is the behaviour
   * to want: an isolate torn down mid-fetch leaves the repair undone, and the
   * cost of not doing so is one read the program was going to need anyway.
   */
  function _faultIn(k) {
    if (!_supervisor() || !_faultOnce("content", k)) return;
    // Swallowed here rather than at the settle: a repair nobody asked for
    // must not surface as an unhandled rejection, and a failed one is simply
    // a path that stays unanswered and stays in the ledger.
    try { _repairs.push(_observeThenFill(k).catch(() => {})); }
    catch { /* the fill is speculative */ }
  }

  /**
   * Ask what the authority has, then fetch it if there is anything to fetch.
   *
   * The stat is not an extra round trip on balance: where the path is absent —
   * which is most refusals, since module resolvers and config lookups probe
   * far more paths than exist — it replaces a content read that could only
   * have failed, and it is the one observation that settles whether the run
   * was denied anything.
   */
  async function _observeThenFill(k) {
    const supervisor = _supervisor();
    const absPath = "/" + k;
    if (typeof supervisor.stat === "function") {
      let meta;
      // A thrown stat is the authority failing to answer, not an answer:
      // nothing is learned, and the miss stands.
      // Queued on the path: the program's own later mutations of it must not overtake the stat.
      const observe = () => __nimbusUseRpcResult(supervisor.stat(absPath), (r) => r);
      try { meta = await (_hasVfsMutationQueue() ? __nimbusQueueVfsMutation(absPath, observe, false) : observe()); }
      catch { return; }
      if (meta === null || meta === undefined) { _observedAbsent.add(k); return; }
      if (meta.type === "directory") return;
    }
    await _liveReadFile(absPath, undefined);
  }

  /**
   * Repairs in flight, and the wait the exit report owes them.
   *
   * A refusal and the fetch that answers it are one event seen from two
   * sides, so a program that ends between them has not been denied anything
   * yet — it simply has not waited. Deciding the run was dishonest at that
   * moment reports a failure the very next turn would have retracted, which
   * for a short command is most of them. So the ledger is read only after
   * every outstanding repair has landed and every proven absence has been
   * retired. Published on globalThis because the runner that reports is
   * outside this closure, the same way the resumption barriers are.
   */
  const _repairs = [];
  globalThis.__nimbusVfsResidencySettle = async () => {
    // One boundary listing can move the boundary a level deeper rather than
    // settle the question outright, and which directory to ask for next is
    // only knowable once the previous answer has landed. So drain, settle,
    // and go round again while the settle is still asking for listings. It
    // terminates: every round enumerates a directory that was unknown, each
    // directory is fetched at most once (_faultOnce), and the paths in the
    // ledger have finitely many components.
    for (;;) {
      while (_repairs.length > 0) {
        await Promise.allSettled(_repairs.splice(0));
      }
      _settleProvenAbsences();
      if (_repairs.length === 0) return;
    }
  };










  // What the authority says of a path after this process's own async request
  // (a stat, read or accepted write) is what the sync view answers for it
  // from then on, as it would after the delta that reports it
  // (facet-resident-store's __nsNoteLiveStat).
  //
  // The lstat rides the read batch (_queueBatchRequest) rather than a call
  // of its own: a resumption refetches every path it owes at once
  // (_acquireAndRefetch), and a learn per path made that one lstat call per
  // path — 1,601 in flight from one facet after a program wrote 1,600 files,
  // some of which stayed pending and never reached the session
  // (preview/new/lucide-barrel-cache-widens, measured 2026-09-28). Batched,
  // the learns cost a round trip per batch, as the reads before them do.
  /** `written`: the revision of the own write the stat is asked after (__nsNoteLiveStat). */
  async function _learnLive(absPath, supervisor, written) {
    if (!supervisor || typeof supervisor.fsReadBatch !== "function") return;
    const ticket = _beginFill(_strip(absPath));
    try {
      let stat;
      try { stat = await _queueBatchRequest(supervisor, { path: absPath, lstat: true }, 0); } catch { return; }
      _noteLearnedStat(absPath, stat ?? null, ticket, written);
    } finally {
      _endFill(ticket);
    }
  }

  /**
   * Keep a stat the authority answered while `ticket` (_beginFill) was
   * open, unless a barrier reported the path, meanwhile, above what the stat
   * is known to cover: the cursor the ticket was dated at, or the own write
   * it was read after (`written`). A deletion among those reports leaves
   * no row the stat could be judged against, and keeping the stat would
   * bring back a name nothing will report gone again. False when the stat
   * was not kept, so the caller can ask for a fresh one (_learnLive): a
   * ticket that cannot date its read at all (_acquiredRead, _spoilFills)
   * says nothing of whether the path changed.
   */
  function _noteLearnedStat(absPath, stat, ticket, written) {
    if (ticket.reported > (written === undefined ? ticket.rev : Math.max(written, ticket.rev))) return false;
    __nsNoteLiveStat(_strip(absPath), stat, written);
    return true;
  }

  /**
   * Retire the misses a repair turned into honest absence. A miss is a wrong
   * answer only when the path was THERE and the process was denied it: one on
   * a name the namespace does not have (or the authority did not have when it
   * was asked) was the program's not-found branch, taken for the right
   * reason. Failing the run over those would fail every module resolver,
   * which probes dozens of paths that do not exist by design.
   */
  function _settleProvenAbsences() {
    if (_residencyMisses.size === 0) return;
    for (const k of [..._residencyMisses]) {
      if (_observedAbsent.has(k) || (_nsActive() && _statLadder("/" + k) === undefined)) _residencyMisses.delete(k);
    }
  }

  // libuv's words for each code: Node's message is "ENOENT: no such file or
  // directory, open 'x'", and "rename 'a' -> 'b'" for a call naming two paths.
  const _errnoDescription = {"E2BIG":"argument list too long","EPERM":"operation not permitted","ENOENT":"no such file or directory","EIO":"i/o error","ENXIO":"no such device or address","EAGAIN":"resource temporarily unavailable","EACCES":"permission denied","EBUSY":"resource busy or locked","EEXIST":"file already exists","EXDEV":"cross-device link not permitted","ENOTDIR":"not a directory","EISDIR":"illegal operation on a directory","EINVAL":"invalid argument","ENOSPC":"no space left on device","EROFS":"read-only file system","ELOOP":"too many symbolic links encountered","ENAMETOOLONG":"name too long","ENOTEMPTY":"directory not empty","ENOTSUP":"operation not supported on socket","ESTALE":"stale file handle","EBADF":"bad file descriptor","EFBIG":"file too large","ENODATA":"no data available","ENOSYS":"function not implemented","EMFILE":"too many open files","ENFILE":"file table overflow","ENOMEM":"not enough memory","ETXTBSY":"text file is busy","EMLINK":"too many links","ENODEV":"no such device","ESPIPE":"invalid seek","EPIPE":"broken pipe","EINTR":"interrupted system call","ERANGE":"result too large","EOVERFLOW":"value too large for defined data type","ETIMEDOUT":"connection timed out","ECANCELED":"operation canceled","EFAULT":"bad address in system call argument"};
  function _fsErr(code, syscall, p, dest) {
    const described = Object.prototype.hasOwnProperty.call(_errnoDescription, code) ? _errnoDescription[code] + ", " : "";
    const second = dest === undefined ? "" : " -> '" + dest + "'";
    const err = new Error(code + ": " + described + syscall + " '" + p + "'" + second);
    err.code = code;
    const errno = Number(__constantsMod[code]);
    err.errno = Number.isInteger(errno) ? -errno : -1;
    err.syscall = syscall;
    err.path = String(p);
    if (dest !== undefined) err.dest = String(dest);
    return err;
  }

  /**
   * Turn a failed supervisor call into a filesystem error the caller can
   * branch on. Every exit from here carries a code, a syscall, a path and an
   * errno, because that is the shape everything written against node:fs
   * expects — `err.code === 'ENOENT'` is how programs make decisions.
   *
   * The code arrives as the error's own property. Both ends of the RPC run
   * with workerd's `enhanced_error_serialization`, which carries an error's
   * own properties across (the host refuses to compose without it), so the
   * code the authority set (_fsErr here, fsError in the runtime-fs bridge,
   * vfsError and VfsError in the VFS) is the code seen here.
   *
   * What this does fix: a failure with no errno spelling at all — the object
   * was reset, the RPC disconnected, a quota was hit — used to be returned
   * UNCHANGED, carrying no code. A program branching on err.code then matched
   * no arm at all, so an I/O failure presented as a hang rather than an
   * error. EIO is the honest answer: the operation failed, and no more
   * specific reason is known. The authority's own words stay in the message
   * so classifying the failure does not cost the reason for it.
   */
  function _mapSupervisorError(error, syscall, p, dest) {
    const message = error && typeof error.message === "string" ? error.message : String(error);
    const declared = error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined;
    const known = declared !== undefined && Number.isInteger(Number(__constantsMod[declared]));
    const mapped = _fsErr(known ? declared : "EIO", syscall, p, dest);
    if (!known && message) mapped.message += " — " + message;
    return mapped;
  }

  /** `dest`: the second path of a call that names two (rename), as Node reports it. */
  async function _fsRpc(promise, syscall, p, use, dest) {
    try { return await __nimbusUseRpcResult(promise, use); }
    catch (error) { throw _mapSupervisorError(error, syscall, p, dest); }
  }

  // Every supervisor READ round trip the facet issues. The runner reports it
  // in the exec-diag envelope, so a change to how reads are issued (batched,
  // coalesced, pipelined) is measurable instead of asserted. Reads are the
  // only fs RPC a program can issue thousands of in one lifetime — a whole
  // file costs one per READ_STREAM_CHUNK_BYTES — so this counts reads rather
  // than every fs call.
  if (typeof globalThis.__nimbusFsRpcReads !== "number") globalThis.__nimbusFsRpcReads = 0;
  function _fsReadRpc(promise, syscall, p, use) {
    globalThis.__nimbusFsRpcReads++;
    return _fsRpc(promise, syscall, p, use);
  }

  const _localTimes = globalThis.__nimbusVfsTimes || (globalThis.__nimbusVfsTimes = Object.create(null));
  const _localModes = globalThis.__nimbusVfsModes || (globalThis.__nimbusVfsModes = Object.create(null));
  // When this process last changed each path's content: the mtime its own
  // writes carry until the namespace describes them. Reading the clock at
  // each stat instead gave a file a new mtime on every stat, which a
  // watcher polling mtimeMs reads as an edit.
  const _ownWriteTimes = globalThis.__nimbusVfsWriteTimes || (globalThis.__nimbusVfsWriteTimes = Object.create(null));
  // Modes set locally that the authority has not received yet. Delivered once:
  // re-sending on every flush made each read of the path a chmod, which bumped
  // its revision and evicted the process's own cell (create-astro EAGAIN).
  const _pendingModes = globalThis.__nimbusVfsPendingModes || (globalThis.__nimbusVfsPendingModes = new Set());

  function _coerceMode(value, syscall, p) {
    const n = typeof value === "string" ? parseInt(value, 8) : Number(value);
    if (!Number.isInteger(n) || n < 0) throw _fsErr("EINVAL", syscall, p);
    return n & 0o7777;
  }

  function _coerceTimeMs(value, syscall, p) {
    if (value instanceof Date) {
      const ms = value.getTime();
      if (Number.isFinite(ms)) return Math.trunc(ms);
      throw _fsErr("EINVAL", syscall, p);
    }
    const n = Number(value);
    if (!Number.isFinite(n)) throw _fsErr("EINVAL", syscall, p);
    return Math.trunc(n * 1000);
  }

  function _recordLocalTimes(absPath, atime, mtime, syscall, p) {
    const k = _strip(absPath);
    const time = {
      atimeMs: _coerceTimeMs(atime, syscall, p),
      mtimeMs: _coerceTimeMs(mtime, syscall, p),
    };
    // The sync view answers these times ahead of the namespace's (_statObject)
    // until the utimes is reported back, as a write's own bytes are.
    _localTimes[k] = time;
    return time;
  }

  // `own`: the path is this process's own (the namespace's overlay of its
  // effects), so a first stat fixes its time once. Any other path's times
  // come from its metadata (_statObject), and recording one per stat grew a
  // map entry for every file a program ever stats.
  function _localStatObject(k, isDir, isSymlink, size, mode, uid, gid, own = false) {
    const time = _localTimes[k];
    const mtimeMs = Number.isFinite(time?.mtimeMs) ? time.mtimeMs
      : Number.isFinite(_ownWriteTimes[k]) ? _ownWriteTimes[k]
      : own ? (_ownWriteTimes[k] = Date.now()) : Date.now();
    const atimeMs = Number.isFinite(time?.atimeMs) ? time.atimeMs : mtimeMs;
    const mtime = new Date(mtimeMs);
    const atime = new Date(atimeMs);
    const localMode = _localModes[k];
    const typeMode = isDir ? 0o040000 : isSymlink ? 0o120000 : 0o100000;
    const storedMode = Number(mode);
    const fullMode = Number.isInteger(storedMode)
      ? ((storedMode & 0o170000) === 0 ? typeMode | storedMode : storedMode)
      : typeMode | (isDir ? 0o755 : 0o644);
    return {
      isFile: () => !isDir && !isSymlink,
      isDirectory: () => isDir,
      isSymbolicLink: () => isSymlink,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      size,
      atime,
      mtime,
      ctime: mtime,
      birthtime: mtime,
      atimeMs, mtimeMs, ctimeMs: mtimeMs, birthtimeMs: mtimeMs,
      mode: localMode === undefined ? fullMode : typeMode | localMode,
      uid: Number(uid),
      gid: Number(gid),
    };
  }

  function _supervisor() {
    try { return typeof __supervisor !== "undefined" ? __supervisor : null; }
    catch { return null; }
  }

  function _writtenCell(absPath) {
    const k = _strip(absPath);
    if (__vfsWrites && k in __vfsWrites) return __vfsWrites[k];
    if (__vfsBundle && k in __vfsBundle) return __vfsBundle[k];
    return undefined;
  }

  function _markVfsStale() {
    globalThis.__nimbusVfsMayBeStale = true;
  }

  // ══ Cache coherence: ACQUIRE + read-through fill ═════════════════════
  //
  // The supervisor's SQLite VFS is the only authority. Everything in this
  // facet — the resident store, __vfsBundle, __vfsDirs — is a
  // cache of it, and __vfsWrites is this process's own not-yet-flushed
  // mutations.
  //
  // INVARIANT: a cell may be served synchronously only if no write to its
  // path has been committed by the supervisor AND DELIVERED to this facet
  // since the cell was fetched. Delivery happens in _acquireBarrier.
  //
  // THE HARD CASE. A node sync read has no synchronous channel to the
  // authority — Atomics.wait is disabled, SharedArrayBuffer cannot cross a
  // Worker-Loader boundary, and a pure-JS stack cannot JSPI-suspend. So a
  // sync read cannot itself fetch; it can only serve what is already local.
  // Coherence therefore has to be established at the RESUMPTION boundary,
  // before user code runs, not inside the read.
  //
  // Three resumptions reached a facet with no supervisor in the path (all
  // measured live): a facet-local timer, a direct outbound fetch, and an
  // unsolicited inbound WebSocket frame. Each is barriered by manufacturing
  // the missing supervisor round trip at the boundary the shim owns:
  //   - timer:  setTimeout/setInterval callbacks run behind an awaited
  //             _acquireAndRefetch (see _installResumptionBarriers).
  //   - fetch:  the dispatcher flushes W ahead of egress and ACQUIREs when
  //             the response lands — after it, never concurrently with the
  //             request, because the response is what encodes the write.
  //   - socket: the supervisor terminates the socket and relays frames, so
  //             a frame arrives as a supervisor reply the same barrier
  //             rides on (see the relayed WebSocket below).
  //
  // The supervisor's own deliveries are resumptions too. Each takes
  // __nimbusInboundBarrier before the program sees it, and each carries the
  // barrier's answer, computed by the supervisor after the thing delivered
  // was queued (protocol §3's piggybacked inv), so the barrier applies it
  // instead of asking and the delivery costs no round trip of its own:
  //   - request: a request routed to one of the process's ports, in the
  //             dispatch every resident's server shares (__nimbusServeHttp).
  //             The supervisor starts it, so it holds no cursor of this
  //             process's and answers "nothing since now", which stands in
  //             only when no write preceded the request since this process
  //             last caught up (protocol §9.2); otherwise the barrier asks.
  //   - stdin:  a stdin packet — input, its end, a signal, a resize — for an
  //             attached process (__makeProcessStdin's pump).
  //   - child:  a spawned child's output and its exit (_runReadLoop,
  //             _runWaitLoop).
  // Stdin and child output are long polls, so they send this process's
  // ACQUIRE arguments (_acquireArgs) and are answered from exactly those.
  //
  // Keep this list empty. An entry here is a documented hole in the owner's
  // invariant, not a TODO: it means some process can be woken by something
  // this system does not mediate, and its next synchronous read can serve
  // bytes the authority has already replaced.
  //
  // Correctness is unconditional and costs one supervisor round trip per
  // resumption — a setTimeout(0) poll-and-read loop pays one RTT per
  // iteration. That cost is removable only by a proactive revision push
  // whose delivery ordering is a workerd property, never by weakening the
  // barrier.
  const _UNBARRIERED_RESUMPTIONS = [];

  const _cursor = globalThis.__nimbusVfsCursor
    || (globalThis.__nimbusVfsCursor = { epoch: null, rev: 0 });

  // Whether any of this is working is a measurement, not an opinion: a fill
  // rate and an invalidation count. Same shape and the same reporting path
  // as __nimbusFsRpcReads, which the runner already folds into the exec-diag
  // envelope — there is no reason to invent a second surface for it.
  const _stats = globalThis.__nimbusVfsCoherence
    || (globalThis.__nimbusVfsCoherence = {
      fills: 0, filledBytes: 0, invalidations: 0, poisons: 0, pushes: 0,
      reconciles: 0, selfWrites: 0, misses: 0,
      // ACQUIREs that got no answer (see _acquireBarrier), and the last reason.
      barrierFailures: 0, lastBarrierFailure: "",
      // Barriers that held their resumption on an own write's acknowledgement
      // (_awaitReportedOwnWrites).
      ownWriteWaits: 0,
      // The namespace's failure state (a relist failed): synchronous calls
      // refused with its cause (_nsRequire), and barriers that repaired it.
      namespaceRefusals: 0, namespaceRepairs: 0,
      // Repairs a delta from the store's durable floor answered, with no listing.
      floorRepairs: 0,
    });

  /**
   * Drop a path from the sync CONTENT views, leaving the existence views
   * alone.
   *
   * Deliberate asymmetry. An invalidation says "what you hold is no longer
   * known-good"; it does not say whether the path was modified or removed,
   * and the facet cannot tell them apart from the path alone. Dropping the
   * name as well would make existsSync answer false for a file that was
   * merely rewritten — a fabricated ENOENT, which is worse than the honest
   * refusal, because it sends the caller down an error path built for a
   * different condition. Keeping the name means the next sync read reports
   * EAGAIN ("exists, not resident") and the async read that follows returns
   * either the new bytes or a truthful ENOENT.
   *
   * __vfsWrites is never dropped: this process's own unflushed writes are
   * strictly newer than anything the supervisor can report, and discarding
   * them would break read-your-writes.
   *
   * The name the asymmetry preserves has to BE somewhere, though. A file this
   * process created has no manifest entry and no spawn-time stat record, so
   * its cell was the only witness that it existed at all, and evicting the
   * cell retracted the file — measured live, a sync read after a barrier
   * answered ENOENT for a file the program had written itself moments before.
   * _announceSyncPath, at the moment the cell is created, is what makes the
   * intent above true rather than merely stated.
   */
  function _evictResident(k) {
    let evicted = false;
    delete __vfsBundleRevisions[k];
    if (__vfsBundle && k in __vfsBundle) { delete __vfsBundle[k]; evicted = true; }
    return evicted;
  }

  // Cells an own-mutation lease evicted with no barrier in hand.
  //
  // A barrier hands _acquireAndRefetch every path it dropped, which is what
  // keeps a sync read inside a timer callback reading the peer's new bytes
  // instead of EAGAIN. A lease's end drops a cell on its own account — the
  // barrier that would have reported it was suppressed by the lease itself
  // — so the same debt is recorded here and settled by the next untrusted
  // resumption.
  const _owedRefetch = new Set();

  // An own-mutation lease can end in an eviction (a peer wrote inside the
  // window), and so can a flush whose revision a barrier's report outran.
  // The ledger owning those decisions is spliced AHEAD of this closure, so it
  // is handed the one eviction path rather than keeping a second copy of it:
  // content view, stat view, the invalidation count and the refetch debt
  // move together here or not at all.
  function _evictOwed(k) {
    if (!_evictResident(k)) return;
    _stats.invalidations++;
    _owedRefetch.add(k);
  }
  globalThis.__nimbusEvictResidentCell = _evictOwed;

  /**
   * Live reads in flight, per path: each one's fill ticket, which carries
   * the highest revision a barrier reported for the path while that read was
   * outstanding.
   *
   * A barrier that reports a path nobody holds has nothing to evict and
   * CONSUMES the report: the cursor moves past it and no later delta names it
   * again. A read of that path already in flight may have been served before
   * the mutation the report describes, and its bytes would then be installed
   * behind the only message that could have evicted them. So the report is
   * kept on the read until it lands, and the read installs only if nothing
   * newer than its cursor was reported under it (_installResident).
   *
   * One ticket per read, not one per path: a read that begins after a report
   * or a poison is judged only by what is reported after it began. Sharing the
   * earlier read's record condemned the read issued to replace it.
   */
  const _fillReports = new Map();

  /**
   * Begin a live read of `k`: the cursor it is issued under — every mutation
   * at or below it is already in the bytes it returns — and what has been
   * reported against it since, nothing yet. Called after the read's barrier
   * and before its RPC.
   */
  function _beginFill(k) {
    const fill = { k, rev: _cursor.rev, reported: -1 };
    let live = _fillReports.get(k);
    if (!live) {
      live = new Set();
      _fillReports.set(k, live);
    }
    live.add(fill);
    return fill;
  }

  function _endFill(fill) {
    const live = _fillReports.get(fill.k);
    if (!live) return;
    live.delete(fill);
    if (live.size === 0) _fillReports.delete(fill.k);
  }

  /** A barrier reported `k` at `rev`: remember it on every read of it in flight. */
  function _noteFillReport(k, rev) {
    const live = _fillReports.get(k);
    if (live) for (const fill of live) if (rev > fill.reported) fill.reported = rev;
  }

  /**
   * Note one delta entry on everything in flight that it covers: its path,
   * or, for a subtree-scoped or structural entry, every path at or under it.
   * The ledger does the same for this facet's own writes and mutations.
   */
  function _noteReport(entry) {
    if (!entry.subtree && !entry.structural) {
      __nimbusNoteVfsReport(entry.path, entry.rev);
      _noteFillReport(entry.path, entry.rev);
      return;
    }
    __nimbusNoteVfsReportUnder(entry.path, entry.rev);
    const under = entry.path + "/";
    for (const k of [..._fillReports.keys()]) {
      if (k === entry.path || k.startsWith(under)) _noteFillReport(k, entry.rev);
    }
  }

  /**
   * The resident cells a delta entry covers: its path, or, for a
   * subtree-scoped or structural entry, every cell at or under it. Such an
   * entry stands for changes it does not name (a directory that went, one
   * whose mode, owner or group changed, or something beneath it this facet
   * may not see), so each cell there is judged as a named one would be.
   */
  function _coveredCells(entry) {
    if (!entry.subtree && !entry.structural) return [entry.path];
    const under = entry.path + "/";
    const cells = new Set();
    for (const table of [__vfsBundle, __vfsBundleRevisions]) {
      if (!table) continue;
      for (const k of Object.keys(table)) if (k === entry.path || k.startsWith(under)) cells.add(k);
    }
    return [...cells];
  }

  /** The cursor moved without a delta (a poison), so no read in flight can be dated. */
  function _spoilFills() {
    for (const live of _fillReports.values()) for (const fill of live) fill.reported = Infinity;
  }

  /**
   * Install bytes the supervisor just served as the resident cell for a
   * path, at the cursor they were served under.
   *
   * This is a correctness obligation before it is an optimization. An async
   * read that returns v2 while leaving the resident cell at v1 makes the
   * NEXT synchronous read go backwards in time relative to a value the
   * program has already seen, which no amount of invalidation discipline
   * catches — the supervisor never learns what the facet's own read
   * returned, so it has nothing to invalidate. The bytes are already paid
   * for; caching them costs one map insert.
   *
   * `fill` (_beginFill) dates them, and it is also the reason an install can
   * be declined: a barrier that reported the path above the read's cursor
   * while the read was in flight may describe a mutation the bytes predate,
   * and that report is gone once consumed. Declining costs the next sync
   * read a miss; installing would cost a stale byte nothing ever evicts.
   *
   * The parent's manifest entry gains the name too, so the existence view
   * cannot go on denying a file whose bytes this process is holding.
   */
  function _installResident(absPath, bytes, fill, reached) {
    if (!__vfsBundle) return;
    // Bytes read through a symlink are held under the file the read reached,
    // which a later write to it is reported under; kept under the link's own
    // name, nothing would ever replace them. `reached` names it, as the
    // authority resolved it (_rpcFsReadBatch). Without one (a session
    // deployed before it, a read in several chunks through a link: null),
    // only a name with no link on it is known to be the file read: this
    // view's own resolution can be older than the read's.
    const asked = _strip(absPath);
    const k = typeof reached === "string" ? _strip(reached)
      : reached === undefined && _nsLandingKey(asked) === asked ? asked : null;
    if (k === null || k === "") return;
    if (fill.reported > fill.rev) return;
    // Never over a cell this facet owns.
    //
    // A pending write is strictly newer than anything the authority can
    // report, and __vfsBundle is what sync reads consult first, so installing
    // over it would serve the program bytes older than its own write.
    if (__vfsWrites && k in __vfsWrites) return;
    // The store dates the row at the read's cursor, so the next delta that
    // names the path above it evicts it. It declines, itself, to replace own
    // bytes or a row dated later than this read can vouch for.
    if (!__residentFill(k, bytes, fill.rev)) return;
    _stats.fills++;
    _stats.filledBytes += _byteLen(bytes);
  }

  /**
   * Repair a poisoned resident store, once, however many barriers hit the
   * poison at the same instant.
   *
   * A poison is a failure of the DELTA CHANNEL, not of the rows. The
   * invalidation log is bounded at 256 KiB and write churn trims it past a
   * live cursor as a matter of course, so this runs REPEATEDLY during an npm
   * install — and dropping the store here meant re-materialising the whole
   * filesystem (~16,357 files / 96 MB at pi scale) inside the barrier, every
   * time, which is what took an agent turn past the DO CPU limit. fsList does
   * not touch the log and reports absolute per-path revisions, so the rows are
   * reconciled against those instead: every row kept is proven current by
   * revision, and only what actually moved is refetched.
   *
   * Single-flight because concurrent async fs operations each take their own
   * barrier and would each see the same poison: without this, one overflow
   * costs one enumeration per operation in flight. Joining is sound rather
   * than merely cheap — the repair publishes the cursor read BEFORE its walk,
   * so a joiner whose poison was answered later is left with a cursor at or
   * behind its own, and the mutations in between are still owed to it by the
   * next delta.
   */
  let _residentRepair = null;
  function _repairPoisonedStore(supervisor, result) {
    if (!_residentRepair) {
      _residentRepair = _runResidentRepair(supervisor, result)
        .finally(() => { _residentRepair = null; });
    }
    return _residentRepair;
  }

  /**
   * Set while the store holds only what a repair could NOT vouch for: rows it
   * had to drop rather than prove current. Nothing but another repair brings
   * those back — a delta names what changed, not what this facet lost — so
   * every barrier repairs until one vouches, however the ACQUIRE is answered.
   */
  let _storeRepairOwed = false;

  /**
   * The repair's first try: the delta from the store's durable floor
   * (__residentCursor), asked as every barrier asks it. True when it applied
   * (the repair is done); false when a listing is needed after all.
   */
  async function _repairFromFloor(supervisor, result) {
    if (!supervisor || typeof supervisor.fsAcquire !== "function" || !_nsActive()) return false;
    if (result !== null && result.poison === true) return false;
    const floor = __residentCursor();
    if (floor === null || (result !== null && result.epoch !== floor.epoch)) return false;
    let delta;
    try {
      delta = await __nimbusUseRpcResult(supervisor.fsAcquire(floor.epoch, floor.rev, { namespace: true }), (r) => r);
    } catch { return false; }
    if (!delta || delta.poison === true || typeof delta.rev !== "number" || delta.epoch !== floor.epoch) return false;
    if (Array.isArray(delta.paths)) for (const entry of delta.paths) _noteReport(entry);
    await __residentRoomForPushed(delta);
    const applied = __residentAdmit(delta);
    for (const dir of applied.relist) await __nsRelist(supervisor, dir);
    if (!_nsActive()) return false;
    _cursor.epoch = applied.cursor.epoch;
    _cursor.rev = applied.cursor.rev;
    _stats.invalidations += applied.dropped.length;
    // What it should hold and lost (dropped by this delta, or by the barrier
    // that could not vouch for its rows), refetched by the namespace's stats.
    const refilled = await __residentRefillFromNamespace(supervisor, applied.dropped);
    _stats.fills += refilled.filled;
    _stats.filledBytes += refilled.bytes;
    _stats.floorRepairs++;
    _storeRepairOwed = false;
    return true;
  }

  /**
   * `result` is the ACQUIRE answer that asked for the repair: a poison, a
   * delta arriving while a repair is owed, or null for a barrier that got no
   * answer at all.
   */
  async function _runResidentRepair(supervisor, result) {
    // Within one epoch, with the change log intact and the namespace
    // answering, the store's rows are dated through its own durable cursor, so
    // the delta from there names everything that moved since. Only an epoch
    // change, a poison (the log truncated past the cursor), or a namespace
    // that stopped answering needs the listing.
    if (await _repairFromFloor(supervisor, result)) return;
    const ownAtStart = __residentOwnPaths();
    let repaired;
    try { repaired = await __residentSynchronizeFromSupervisor(supervisor); }
    catch { repaired = null; }
    if (!repaired || !repaired.cursor) {
      // The pass could not vouch for a single row — a supervisor replaced
      // mid-enumeration, an enumeration that came back short, an authority it
      // could not reach. A row that cannot be dated must not be served, so the
      // cold cache is taken after all, and the pass runs once more to
      // repopulate what it just dropped. An answer with a cursor is admitted as
      // it would have been; a barrier with no answer drops every dated row and
      // keeps the cursor it had, which the next delta is still owed from.
      if (result) {
        __residentAdmit(result);
        _cursor.epoch = result.epoch;
        _cursor.rev = result.rev;
      } else {
        __residentDropDated();
      }
      try { repaired = await __residentSynchronizeFromSupervisor(supervisor); }
      catch { repaired = null; }
    } else if (repaired.reconciled) {
      _stats.reconciles++;
    }
    _settleSkippedReports(ownAtStart, repaired);
    _storeRepairOwed = !(repaired && repaired.cursor);
    if (_storeRepairOwed) return;
    _cursor.epoch = repaired.cursor.epoch;
    _cursor.rev = repaired.cursor.rev;
    _stats.invalidations += repaired.dropped;
    _stats.fills += repaired.filled;
    _stats.filledBytes += repaired.bytes;
  }

  /**
   * Deliver the reports a repair moved the cursor over.
   *
   * A repair moves the cursor without a delta, so what a delta would have
   * reported reaches nothing on its own. A dated row the pass kept is proven
   * current by its listed revision and needs nothing more. A row of this
   * facet's own bytes is kept whatever the listing says — and its report is
   * exactly what the write or mutation that owns it needs, to judge its own
   * acknowledgement against. The pass hands those back (`own`), and they are
   * noted here as a delta's would have been; one acknowledged since the pass
   * looked was dated by a receipt that could not see the report, so it is
   * judged here directly.
   *
   * With nothing datable — across incarnations, against a short listing, or
   * a pass that failed outright — every own row, and every row that was own
   * when the repair began, is judged as though a peer wrote it last: an
   * eviction and a refetch, never a stale byte.
   */
  function _settleSkippedReports(ownAtStart, repaired) {
    const reports = new Map();
    if (repaired && repaired.cursor && repaired.reconciled && Array.isArray(repaired.own)) {
      for (const entry of repaired.own) reports.set(entry.path, entry.rev);
    } else {
      for (const k of ownAtStart) reports.set(k, Infinity);
      if (repaired && Array.isArray(repaired.own)) for (const entry of repaired.own) reports.set(entry.path, Infinity);
      for (const k of Object.keys(__vfsOwnLeases)) reports.set(k, Infinity);
      for (const k of Object.keys(__vfsWrites)) reports.set(k, Infinity);
    }
    for (const [k, rev] of reports) {
      __nimbusNoteVfsReport(k, rev);
      const provenance = __residentProvenance(k);
      if (provenance !== undefined && provenance !== -1 && provenance < rev) _evictOwed(k);
    }
  }

  /**
   * ACQUIRE. Apply every invalidation the supervisor has for this facet,
   * then re-stamp the cursor.
   *
   * Awaited before the async fs operation that carries it returns, so user
   * code never resumes holding a cell the supervisor has already told us
   * to drop.
   *
   * A poison result means the delta cannot repair the view — a different
   * supervisor incarnation, or a cursor older than the retained log. Where the
   * resident set lives in the facet's SQLite its rows carry their own
   * revisions, so a poison is repaired by reconciling them against fsList's
   * absolute per-path revisions rather than by dropping them. On the heap —
   * where a cell carries no date to verify against — the whole resident
   * content view still goes. That costs a cold cache; the alternative is a
   * stale byte.
   *
   * A path the facet itself wrote is skipped, and only at the revision its
   * own flush produced. The invalidation log records what changed, not who
   * changed it, so a facet that writes N files is handed all N of them back
   * on its next barrier and drops the bytes it is holding — measurably, 40
   * writes cost 41 invalidations and 40 refetches of content that never
   * left. Comparing revisions rather than names keeps the peer case intact:
   * a peer writing the same path afterwards reports a HIGHER revision than
   * our stamp, so that invalidation still lands.
   *
   * An ACQUIRE that gets no answer is a poison too, never an empty delta. It
   * has learned nothing about what changed, and the resumption behind it is
   * about to serve every row it holds. The call is a pure read, so a dropped
   * one is already retried where the supervisor makes it (SupervisorRPC,
   * fabric's idempotent), and what arrives here failed those retries, came
   * from a host that could not serve it, or answered without a cursor. The
   * rows are repaired against the listing exactly as for a poison; with no
   * cursor to adopt, the one held is kept and still owed every change since.
   * The barrier itself never throws: the operation or callback behind it
   * runs either way, against rows that were vouched for or a colder cache.
   *
   * A repair is single-flight, and while one runs no delta may be admitted
   * at all: the repair has already dropped the rows it could not vouch for,
   * so a report of one of them finds nothing to evict and is consumed, and
   * the repair then installs it at its listing's revision and publishes the
   * listing's cursor over the one the delta advanced. So any barrier answered
   * while a repair runs joins it, whether its own answer needed a repair or
   * was an ordinary delta, and the listing may predate that answer — the rows
   * it vouches for are another barrier's answer, not this one's — so a joiner
   * waits for it and then asks again: a delta from the repaired cursor names
   * everything since. Only the barrier that started a repair resumes on it
   * alone.
   *
   * `delivered` is an answer the supervisor delivered with the resumption
   * this barrier is taken for; it stands in for the first ACQUIRE when it can
   * (_deliveredAnswer). Everything after is the same for an answer delivered
   * and one asked for, so a repair, a join or a poison follows exactly the
   * path it always has.
   *
   * Last, the barrier waits out every own write or mutation that a report —
   * this answer's or an earlier one's — is outstanding against, until its
   * acknowledgement says which came first (__nimbusReportedOwnAcknowledgements).
   * Until then the resumption could run on own bytes the authority applied
   * before a peer overwrote them. Nothing is waited on unless such a report
   * exists.
   */
  async function _acquireBarrier(supervisor, delivered) {
    if (!supervisor || typeof supervisor.fsAcquire !== "function") return [];
    const fromDelivery = _deliveredAnswer(delivered);
    // The overlay of this facet's own structural effects retires what settled
    // before the answer was asked for: a delivered answer was asked for when
    // its arguments were built, a fetched one now.
    const begin = fromDelivery ? _argsBegin(delivered.args) : ++_barrierBegins;
    let result = fromDelivery || await _acquire(supervisor);
    // When the resident set lives in the facet's own SQLite, the STORE applies
    // the delta. That is not an optimisation, it is where provenance has to
    // live: a facet's SQLite outlives its module scope, so a new incarnation
    // opens onto rows a previous one wrote while every heap-side stamp that
    // described them is gone. Rows carry their own revision, __vfsBundleRevisions
    // cannot follow them there, and two provenance stores would be one too many.
    {
      // A namespace that stopped answering (a relist failed) is a failure
      // state, not a mode: every barrier the process reaches repairs it, once,
      // until a listing restores it.
      let namespaceAsked = false;
      for (let joins = 0; ; joins++) {
        const joining = _residentRepair !== null;
        const namespaceOwed = !namespaceAsked && !_nsActive();
        // A sealed heap view can release acknowledged overlays before its
        // listing; otherwise the old overlay and replacement rows would
        // consume the same scarce allowance while preventing each other's
        // repair. Nothing synchronous may consult the sealed view here.
        if (namespaceOwed && __residentInHeap) _nsRetire(begin);
        const needsRepair = result === null || result.poison === true || _storeRepairOwed || namespaceOwed;
        if (!joining && !needsRepair) break;
        if (namespaceOwed) { namespaceAsked = true; _stats.namespaceRepairs++; }
        if (needsRepair) {
          if (result !== null && result.poison === true) _stats.poisons++;
          _spoilFills();
        }
        await (joining ? _residentRepair : _repairPoisonedStore(supervisor, result));
        // A repair's listing is walked page by page at successive revisions,
        // so even the barrier that started it asks once more: the delta from
        // the listing's cursor leaves the namespace exact. Unanswered, it
        // resumes on the repair's rows as they are, which the listing vouched
        // for; the namespace then waits for the next barrier.
        if (!joining) {
          if (_storeRepairOwed) return [];
          result = await _acquire(supervisor);
          if (result === null || result.poison === true) { _nsRetire(begin); return []; }
          continue;
        }
        if (joins + 1 >= _REPAIR_JOINS_MAX) {
          // Every repair this barrier waited on was someone else's. Rather
          // than resume on rows none of them vouched for as of its own
          // answer, it drops them and leaves the repair owed: a colder cache,
          // never a stale byte. Any repair still to finish lists after this.
          __residentDropDated();
          _storeRepairOwed = true;
          __nimbusNoteUnnamedReports();
          await _awaitReportedOwnWrites();
          return [];
        }
        result = await _acquire(supervisor);
      }
      // The store keeps a row of this facet's own bytes over any report, so
      // the report is noted first: the write or mutation that owns the row
      // judges it against its own revision when that arrives, as it does for
      // a heap cell. A read in flight gets the same note.
      if (Array.isArray(result.paths)) {
        for (const entry of result.paths) _noteReport(entry);
      }
      // N18: room for what it pushes, before it is held.
      await __residentRoomForPushed(result);
      const applied = __residentAdmit(result);
      _cursor.epoch = applied.cursor.epoch;
      _cursor.rev = applied.cursor.rev;
      // A directory that became searchable has descendants no delta names.
      for (const dir of applied.relist) await __nsRelist(supervisor, dir);
      _nsRetire(begin);
      _stats.invalidations += applied.dropped.length;
      _stats.selfWrites += applied.kept;
      _stats.pushes += applied.pushed || 0;
      await _awaitReportedOwnWrites();
      return applied.dropped;
    }
  }

  /**
   * Hold the resumption behind a barrier on every own write or mutation a
   * report is outstanding against, until its acknowledgement says which came
   * first (__nimbusReportedOwnAcknowledgements). Counted, because the wait is
   * also paid when the report was the write itself coming back, which the
   * facet cannot tell apart until the acknowledgement lands.
   */
  async function _awaitReportedOwnWrites() {
    const acks = __nimbusReportedOwnAcknowledgements();
    if (acks === null) return;
    _stats.ownWriteWaits++;
    await acks;
  }

  /**
   * Repairs someone else started that one barrier waits on, in a row, before
   * it stops asking again and drops what it cannot vouch for. A bound on the
   * barrier's own liveness, not a tuning knob: each join waits a whole repair,
   * so the fourth means repairs keep being started under it.
   */
  const _REPAIR_JOINS_MAX = 4;

  /**
   * What this facet asks its ACQUIRE with: its cursor. Built in one place, so
   * what a delivery is answered from (a long poll sends these,
   * `__nimbusVfsAcquireArgs`) is exactly what fsAcquire would be asked.
   */
  function _acquireArgs() {
    // Every build is the start of an answer the overlay may retire against.
    const begin = ++_barrierBegins;
    const key = _cursor.epoch + "@" + _cursor.rev;
    if (!_argsBegins.has(key)) _argsBegins.set(key, begin);
    const options = _residentStorePresent() && typeof __residentAcquireOptions === "function"
      ? __residentAcquireOptions() : undefined;
    return options
      ? { epoch: _cursor.epoch, cursor: _cursor.rev, options }
      : { epoch: _cursor.epoch, cursor: _cursor.rev };
  }
  /**
   * The earliest begin of any arguments built at a cursor: a delivered answer
   * may answer any of them, and retiring against the earliest is the one
   * that is never too late. Cursors left behind are forgotten.
   */
  const _argsBegins = new Map();
  function _argsBegin(args) {
    const key = args.epoch + "@" + args.cursor;
    const begin = _argsBegins.get(key) ?? 0;
    for (const k of [..._argsBegins.keys()]) {
      const [epoch, rev] = [k.slice(0, k.lastIndexOf("@")), Number(k.slice(k.lastIndexOf("@") + 1))];
      if (epoch !== _cursor.epoch || rev < _cursor.rev) _argsBegins.delete(k);
    }
    return begin;
  }

  /**
   * One ACQUIRE: the authority's answer, or null when there is none — the
   * call failed past the supervisor's own retries, the host could not serve
   * it, or the answer carried no cursor. A null is counted where the
   * coherence stats are read, and is never an empty delta (_acquireBarrier).
   */
  async function _acquire(supervisor) {
    // Through the RPC helper like every other supervisor call, because it IS
    // one: the barrier is the first thing an async read issues, and while it
    // was uncounted __nimbusPendingOps read zero for a whole round trip. A
    // one-shot facet's event loop, which exits when no handle is live, then
    // ended the program mid-read — measured as an fs.promises.readFile whose
    // .then never ran, no error, no output, intermittently, and never when a
    // pending timer happened to hold the program open.
    try {
      const args = _acquireArgs();
      const result = await __nimbusUseRpcResult(
        args.options ? supervisor.fsAcquire(args.epoch, args.cursor, args.options) : supervisor.fsAcquire(args.epoch, args.cursor),
        (r) => r,
      );
      if (!result || typeof result.rev !== "number" || typeof result.epoch !== "string") {
        throw new Error("fsAcquire answered without a cursor");
      }
      return _currentAnswer(result);
    } catch (error) {
      _stats.barrierFailures++;
      _stats.lastBarrierFailure = (error && error.message) || String(error);
      return null;
    }
  }

  /**
   * An answer as it stands against this facet's cursor now.
   *
   * Answers can be admitted in another order than they were given: an
   * answer a long poll delivers was asked for before the barrier that
   * overtook it. Everything at or below the cursor is admitted already, by
   * whichever answer took the cursor past it — an answer is complete from
   * the cursor it was asked from, which is never ahead of the cursor now, and
   * names each path at its newest revision in its range. So only the entries
   * above the cursor are news, and the cursor never moves back. An answer in
   * another epoch, or a poison, is left as it is.
   */
  function _currentAnswer(result) {
    if (result.poison === true || result.epoch !== _cursor.epoch) return result;
    if (result.rev <= _cursor.rev) return { ...result, rev: _cursor.rev, paths: [] };
    const paths = result.paths.filter((entry) => entry.rev > _cursor.rev);
    return paths.length === result.paths.length ? result : { ...result, paths };
  }

  /**
   * The answer a delivery carried (session/rpc.ts _acquireOnDelivery), as it
   * stands against the cursor now, or null when it cannot stand in for
   * asking. It can when it answers from a cursor this facet has reached, in
   * this epoch: everything at or below that cursor is admitted, and the
   * answer names everything after it up to the moment of delivery. The
   * barrier asks, as it always has, when there is no answer or it is a
   * poison, in another epoch, or from a cursor this facet has not reached — a
   * routed request is answered from the supervisor's own cursor, "nothing
   * since now", which stands in only for a facet that is already there.
   */
  function _deliveredAnswer(delivered) {
    if (!delivered || typeof delivered !== "object") return null;
    const { args, answer } = delivered;
    if (!args || !answer || answer.poison === true || !Array.isArray(answer.paths)) return null;
    if (typeof answer.rev !== "number" || answer.epoch !== _cursor.epoch || args.epoch !== _cursor.epoch) return null;
    if (!(args.cursor <= _cursor.rev)) return null;
    return _currentAnswer(answer);
  }

  /**
   * ACQUIRE, then repopulate the working set the invalidation just dropped.
   *
   * The barrier used at every UNTRUSTED resumption — a timer firing, a
   * relayed socket frame — where user code is about to run synchronously
   * with no supervisor message to have carried an invalidation. Manufacture
   * that message: apply the delta, then live-read every path that was
   * resident and is now stale so a synchronous read inside the callback
   * sees exactly what an async read issued at this instant would.
   *
   * Eviction alone is not enough here. An async fs op evicts and then reads
   * its own path live, so a dropped cell repairs itself; a timer callback
   * has no such follow-up, so a dropped-but-not-refetched cell would raise
   * EAGAIN on the next sync read — the unhandleable error §7 warns about.
   * Under the owner's no-price-ceiling mandate we pay the refetch.
   *
   * This closes staleness of RESIDENT cells across an untrusted resumption.
   * A first synchronous touch of a NON-resident path is the separate
   * residency floor and is unaffected — it still raises EAGAIN, correctly.
   *
   * Two resumptions can barrier at once — a child's output and its exit
   * arrive together — and both deltas name the same changed path. The first
   * to land evicts it and starts the refetch; the second finds no row and
   * would release its callback while that refetch is still in flight, onto
   * a miss. So a barrier also waits for every refetch still in flight.
   * It does not read those paths again. A refetch in flight installs its
   * bytes unless a barrier has since reported the path above the cursor it
   * was issued under, or a poison spoiled it (_installResident). Only then
   * does a later barrier read the path itself, and only if nothing holds it
   * by now. Re-reading every in-flight path at every resumption cost a dev
   * server 50 reads per request while a peer's refetch of 50 files ran: 500
   * reads over ten resumptions, and under steady load the set never drained.
   */
  async function _acquireAndRefetch(supervisor, delivered) {
    const stale = await _acquireBarrier(supervisor, delivered);
    // Plus what an own-mutation lease dropped since the last resumption:
    // the same debt this function exists to settle, owed by an eviction
    // that had no barrier to report it (see _owedRefetch).
    if (_owedRefetch.size > 0) {
      for (const k of _owedRefetch) if (stale.indexOf(k) === -1) stale.push(k);
      _owedRefetch.clear();
    }
    // Taken before this barrier's own refetches join the map.
    const inFlight = [..._refetching];
    const reads = stale.map(_refetch);
    for (const [k, refetch] of inFlight) {
      if (stale.indexOf(k) !== -1) continue;
      if (!(refetch.fill.reported > refetch.fill.rev)) reads.push(refetch.done);
      else if (!(__vfsBundle && k in __vfsBundle)) reads.push(_refetch(k));
    }
    if (reads.length > 0) await Promise.all(reads);
  }

  /**
   * Refetches in flight, per path: the newest read of it, and the fill
   * ticket that read installs under — the cursor it was issued at, and the
   * reports noted against it since.
   */
  const _refetching = new Map();

  /**
   * Read `k` live and install it, behind the barrier just taken. Settles
   * either way: a refetch that fails leaves the path missing, which the next
   * read of it answers.
   *
   * `read` settles once this read has landed and its install was made or
   * declined. `done`, which the resumptions wait on, may wait once more. An
   * install is declined when a barrier reported the path above this read's
   * cursor, or a poison spoiled it, and settling there would release every
   * waiter onto the miss it left while something else is already filling
   * the path: the newer refetch a barrier issued to replace this one, or the
   * repair that poison started. So `done` waits on what is in flight at the
   * moment this read settles, that refetch's own read and install and that
   * repair, and then settles whether or not the path is held. It never
   * follows a refetch issued after that. A peer that rewrites the path
   * faster than one read round trip outdates every refetch with the next
   * resumption's report, and following them held every resumption, including
   * those that never read the path, until the writer stopped (1528 ms against
   * 33 ms). A path left unheld is read live by its next read.
   */
  function _refetch(k) {
    const fill = _beginFill(k);
    const refetch = { fill, read: null, done: null };
    refetch.read = _liveReadFile("/" + k, undefined, fill).then(() => {}, () => {}).then(() => {
      _endFill(fill);
      if (_refetching.get(k) === refetch) _refetching.delete(k);
    });
    refetch.done = refetch.read.then(() => {
      if (__vfsBundle && k in __vfsBundle) return undefined;
      const newer = _refetching.get(k);
      return Promise.all([newer && newer.read, _residentRepair]);
    });
    _refetching.set(k, refetch);
    return refetch.done;
  }

  /**
   * ACQUIRE at an untrusted resumption boundary, with the supervisor
   * resolved at call time.
   *
   * Late resolution is load-bearing, not defensive. The opencode runner
   * evaluates this module with `__supervisor` still null and assigns it in
   * its fetch handler; binding the supervisor when the wrappers are
   * installed would silently leave every resident-TUI timer unbarriered.
   *
   * Published on globalThis because the other resumptions — an outbound
   * fetch response, a relayed socket frame, and everything the supervisor
   * delivers (`__nimbusInboundBarrier`, with the answer it delivered) — are
   * handed to the program by code outside this closure.
   */
  async function _resumptionAcquire(delivered) {
    const supervisor = _supervisor();
    if (!supervisor || typeof supervisor.fsAcquire !== "function") return;
    await _acquireAndRefetch(supervisor, delivered);
  }

  /**
   * RELEASE: this facet's parked writes reach the authority before an
   * effect of them can be observed from outside the facet.
   *
   * Sited at every boundary where the facet's own action becomes externally
   * visible — an outbound request, a frame sent on a relayed socket. Without
   * it a peer can observe the effect of a write ("the build finished") and
   * then read the pre-write bytes, which breaks causal consistency rather
   * than merely linearizability.
   */
  async function _resumptionRelease() {
    await __nimbusFlushVfsWriteBack(_supervisor());
  }

  // Every untrusted resumption — a facet-local timer, an outbound fetch
  // response, a relayed socket frame — runs user code with no supervisor
  // message behind it, so it cannot have carried an invalidation. The shim
  // owns these entry points, so it manufactures the missing barrier: the
  // user callback is preceded by a completed ACQUIRE-and-refetch. After it,
  // a synchronous read in the callback is as fresh as an async read at the
  // same instant — the owner's invariant, met for the sync path.
  //
  // Correctness is unconditional and costs one supervisor round trip per
  // resumption. That cost is real (a setTimeout(0) poll-and-read loop pays
  // one RTT per iteration) and is the number to hand the owner; it is
  // removable only by a proactive revision push whose delivery ordering is
  // an unrun workerd probe, never by weakening the barrier.
  function _installResumptionBarriers() {
    if (globalThis.__nimbusResumptionBarriersInstalled) return;
    globalThis.__nimbusResumptionBarriersInstalled = true;
    globalThis.__nimbusVfsAcquireBarrier = _resumptionAcquire;
    globalThis.__nimbusVfsAcquireArgs = _acquireArgs;
    globalThis.__nimbusVfsReleaseBarrier = _resumptionRelease;
    const _setTimeout = globalThis.setTimeout;
    const _setInterval = globalThis.setInterval;
    // The barrier moves the user callback BEHIND an awaited round trip, and
    // the timer bookkeeping counts a timer as done the moment its closure
    // starts. So between the ACQUIRE and the callback the facet looks idle,
    // and a one-shot facet could tear itself down in that window — the work
    // the timer was scheduled for simply never ran, silently. Counting the
    // deferred chain as an in-flight operation is what holds the facet open
    // across it; __nimbusPendingOps is the counter the drain consults for
    // exactly this, since an awaited chain is invisible to promise tracking.
    // Only the ACQUIRE is counted, never the callback that follows it. A
    // callback is free to be a long-lived thing — an SSE writer that returns
    // when the client disconnects — and counting it as an in-flight operation
    // would make a resident facet's drain wait for it, which buffers an open
    // response body. The window that needs holding is exactly the round trip.
    // What the callback throws is an uncaught exception, as a timer's is in
    // Node, not the rejection of the chain it runs on.
    const _barriered = (cb, args) => {
      __nimbusTrackOp(_resumptionAcquire()).then(() => {
        try {
          cb(...args);
        } catch (error) {
          __nimbusUncaughtException(error);
        }
      });
    };
    if (typeof _setTimeout === "function") {
      globalThis.setTimeout = function setTimeout(cb, ms, ...args) {
        if (typeof cb !== "function") return _setTimeout(cb, ms);
        return _setTimeout(() => { _barriered(cb, args); }, ms);
      };
    }
    if (typeof _setInterval === "function") {
      globalThis.setInterval = function setInterval(cb, ms, ...args) {
        if (typeof cb !== "function") return _setInterval(cb, ms);
        return _setInterval(() => { _barriered(cb, args); }, ms);
      };
    }
  }

  // Directories mkdirSync created that the authority has not been told about.
  // A sync syscall cannot make an RPC, so mkdirSync can only record the
  // directory in the sync view (__vfsDirs) — and the write-back then flushed
  // the FILE without ever announcing the directories above it. writeFile
  // creates missing parents implicitly and so papered over the gap; fsAppend
  // and fsTruncate do not, which is how an appendFileSync log inside a fresh
  // mkdir tree failed ENOENT on its own parent and never reached authority.
  const _announcedDirs = new Set();

  // Announce every directory on `absPath` the authority may not know about.
  // supervisor.mkdir is recursive, so the deepest unannounced one creates all
  // of them in a single round trip; a path whose directories are already live
  // (the common case) costs none at all.
  //
  // This is also the one seam every asynchronous fs entry point crosses on
  // its way to the authority — directly, or through
  // _flushLocalPathToSupervisor — so it is where a live call waits for the
  // structural mutations the program issued synchronously before it:
  // mkdirSync, rmdirSync, unlinkSync, renameSync queue their authority RPC
  // (below) rather than land it, and an open/stat/readdir that overtook that
  // queue would be answered for a tree the program has already changed.
  async function _announceLocalDirs(absPath, supervisor) {
    await _awaitStructuralOrder(absPath);
    if (!__vfsDirs || typeof supervisor.mkdir !== "function") return;
    const pending = [];
    let key = "";
    for (const segment of _strip(absPath).split("/")) {
      if (!segment) continue;
      key = key ? key + "/" + segment : segment;
      if (key in __vfsDirs && !_announcedDirs.has(key)) pending.push(key);
    }
    if (pending.length === 0) return;
    const deepest = "/" + pending[pending.length - 1];
    await _fsRpc(supervisor.mkdir(deepest), "mkdir", deepest, () => undefined);
    for (const dir of pending) _announcedDirs.add(dir);
    _markVfsStale();
  }

  // The write ledger is spliced ahead of the shims in every runner
  // (facets/manager.ts, opencode-facet-runner.ts). A harness that evaluates
  // the shims alone has no mutation queue and therefore nothing to wait for;
  // an absent ledger must not be an error on a read path that never needed
  // one before.
  function _hasVfsMutationQueue() {
    return typeof __nimbusQueueVfsMutation === "function";
  }
  function _awaitStructuralOrder(absPath) {
    return _hasVfsMutationQueue() ? __nimbusAwaitAncestorMutations(absPath) : Promise.resolve();
  }

  /**
   * Carry a synchronous structural mutation to the authority.
   *
   * mkdirSync, rmdirSync, unlinkSync and renameSync used to edit the local
   * tables and stop: a sync syscall cannot make an RPC, and unlike a sync
   * write they parked nothing the write-back could later flush. Measured
   * live: node-tar's `mkdirSync(dir)` then `fs.promises.open(dir/file,
   * "w")` — once per extracted entry — was answered ENOENT by an authority
   * that had never heard of `dir`; that is create-astro's template copy.
   *
   * The sync effect stays exactly as it was. What is added is the same RPC
   * the asynchronous form of the call issues, queued through the write
   * ledger so it registers with the exit drain, is ordered behind pending
   * mutations of its ancestors (the ledger does that for every queued
   * mutation), and — for the two that act on a subtree — behind pending
   * mutations beneath it. The async forms are that same queued call, awaited.
   *
   * `null` when there is no authority to tell: standalone and unit contexts
   * keep today's local-only behaviour. Without a ledger the RPC is issued
   * directly, which is what the async forms did before they were queued.
   */
  // `method` names the supervisor RPC when it differs from the syscall the
  // caller reports (lchown rides `chown`, rm rides `fsRemove`).
  function _queueStructuralMutation(absPath, syscall, displayPath, rpc, after, method, dest) {
    const settle = _nsTakeFresh();
    const supervisor = _supervisor();
    if (!supervisor || typeof supervisor[method || syscall] !== "function") { settle(); return null; }
    const queued = _hasVfsMutationQueue();
    const before = queued && after ? after() : null;
    const run = async () => {
      if (before) await before;
      // Only chown answers with a receipt. The rest (mkdir, unlink, rmdir,
      // rename, rm) have already dropped the path's cell and stamp in their
      // synchronous half, so no lease is taken at all; where one is — the
      // stamp unlink leaves behind — an absent receipt retires it, which is
      // what an unstamped cell already costs.
      await _ownMutation(
        absPath,
        () => _fsRpc(rpc(supervisor), syscall, displayPath, (result) => result, dest),
      );
      _markVfsStale();
    };
    const out = queued ? __nimbusQueueVfsMutation(absPath, run) : run();
    // Settled either way: a failed mutation leaves the authority as it was,
    // which the next barrier's table shows.
    Promise.resolve(out).then(settle, settle);
    return out;
  }

  /**
   * Run one of this facet's own partial mutations under a lease.
   *
   * See __nimbusBeginOwnMutation: the barrier KEEPS the cell while the RPC
   * is in flight — a barrier issued after this mutation can be answered
   * ahead of it, and an eviction there loses bytes no later stamp can
   * recover — and the receipt decides at the end. `apply` lands the local
   * effect while the lease still holds the cell, so the stamp the end
   * settles describes a cell that already carries the mutation.
   *
   * The ledger takes the lease on whichever holds the stamp: a heap stamp,
   * or the resident store's row. Without it a store row the mutation
   * overlaid would be left as own bytes nobody ever dates, which the barrier
   * keeps against every later write by anyone.
   *
   * From lease to receipt it is an acknowledgement in flight
   * (__nimbusOwnAcknowledgement): a barrier that reports the path waits for
   * it, rather than resume on bytes the receipt may yet show a peer outran.
   */
  function _ownMutation(absPath, rpc, apply) {
    const key = _strip(absPath);
    return __nimbusOwnAcknowledgement(key, async () => {
      const held = __nimbusBeginOwnMutation(key);
      let receipt;
      let landed = false;
      try { receipt = await rpc(); landed = true; }
      finally {
        // The local effect follows the mutation landing, not the receipt: the
        // receipt only settles the stamp, and a supervisor that answers
        // without one still applied the bytes. The end runs even if applying
        // throws: a lease left open pins its cell at Infinity, which is the one
        // state in this protocol that can serve a stale byte forever.
        try { if (landed && apply) apply(receipt); }
        finally { __nimbusEndOwnMutation(key, held, receipt); }
      }
      return receipt;
    });
  }

  // A sync caller has no frame to receive the outcome. The ledger already
  // marks a queued result handled and retains what the exit drain must
  // report; this only keeps a ledger-less embedding from raising an
  // unhandled rejection for a verdict nobody could catch.
  function _detachStructuralMutation(mutation) {
    if (mutation) mutation.then(undefined, () => undefined);
  }

  // A rename lives at two names. Its mutation is queued under the source;
  // this parks a fence under the destination so that anything queued for the
  // destination, or an ancestor wait that passes through it, is ordered
  // behind the move as well. The fence never fails on its own account.
  function _fenceVfsMutation(absPath, mutation) {
    if (!mutation || !_hasVfsMutationQueue()) return;
    __nimbusQueueVfsMutation(absPath, () => mutation.then(() => undefined, () => undefined), false);
  }

  // Queue the parked write for `absPath`, if any, on the path's mutation
  // tail. Registration is synchronous: a caller that queues its own mutation
  // on the same tail right after this call is ordered behind the flush.
  function _flushParkedWrite(absPath, supervisor) {
    const k = _strip(absPath);
    if (!__vfsWrites || !(k in __vfsWrites) || typeof supervisor.writeFile !== "function") {
      return Promise.resolve(undefined);
    }
    return __nimbusFlushVfsWrite(
      absPath,
      (content, snapshot) => _fsRpc(
        __nimbusPersistVfsWrite(supervisor, absPath, content, snapshot),
        "write", absPath,
        (result) => result,
      ),
      true,
      true,
    );
  }

  /**
   * Send what this process holds for `absPath` ahead of a request about
   * it. `follow`: the request follows symlinks, so what is parked under the
   * file they name (_nsLandingKey: its bytes, its mode) goes first too; a
   * request about the link itself (lstat, lchown, lutimes) leaves that be.
   */
  async function _flushLocalPathToSupervisor(absPath, supervisor, follow = true) {
    await _flushHeld(absPath, supervisor);
    if (!follow) return;
    const k = _strip(absPath);
    const landing = _nsLandingKey(k);
    if (landing !== null && landing !== k) await _flushHeld("/" + landing, supervisor);
  }

  async function _flushHeld(absPath, supervisor) {
    const k = _strip(absPath);
    await _announceLocalDirs(absPath, supervisor);
    if (__vfsWrites && k in __vfsWrites && typeof supervisor.writeFile === "function") {
      await _flushParkedWrite(absPath, supervisor);
      _markVfsStale();
    }
    // A pending sync chmod rides along with the next flush of the same path.
    if (_pendingModes.has(k) && typeof supervisor.chmod === "function") {
      _pendingModes.delete(k);
      try {
        await _ownMutation(
          absPath,
          () => _fsRpc(supervisor.chmod(absPath, _localModes[k]), "chmod", absPath, (result) => result),
        );
      } catch (error) {
        _pendingModes.add(k);
        throw error;
      }
      _markVfsStale();
    }
  }

  // Resize the local sync-view cell (bundle + pending write) to `size`
  // bytes, zero-extending when growing. No-op when there is no cell.
  function _truncateLocalCell(absPath, size) {
    const k = _strip(absPath);
    const cell = _writtenCell(absPath);
    if (cell === undefined) return;
    _ownWriteTimes[k] = Date.now();
    const buf = _asBytes(cell);
    let next;
    if (size <= buf.byteLength) {
      next = buf.slice(0, size);
    } else {
      next = new Uint8Array(size);
      next.set(buf, 0);
    }
    if (__vfsWrites && k in __vfsWrites) __vfsWrites[k] = next;
    if (__vfsBundle && k in __vfsBundle) __vfsBundle[k] = next;
  }

  // Positional write into a local cell: return `base` with `bytes` placed at
  // `pos`. The single implementation behind every fd-style write (async
  // FileHandle.write, sync writeSync, and the post-RPC local overlay).
  //
  // A descriptor write loop appends at the current end, so that case grows the
  // cell IN PLACE inside a geometrically reserved buffer — rebuilding the whole
  // cell per call made a write loop quadratic and OOMed the facet on a 26 MiB
  // file. A write that lands on bytes already in the cell still copies, so a
  // view handed out earlier is never mutated underneath its holder.
  //
  // The result is an exactly-sized VIEW over a buffer that may carry reserve.
  // Everything that reads a cell goes through its byteLength — readFileSync
  // copies, statSync sizes it, the supervisor write RPC takes a Uint8Array —
  // with one exception: structured clone carries the whole BACKING BUFFER
  // across that RPC, so the reserve is part of the write payload — and that
  // payload is capped. Measured on a deployed worker: a 26 MiB cell in a
  // doubled 32 MiB buffer silently lost its flush, and normalising it to an
  // exact copy first cost a third copy of the file and killed the write
  // outright. So the reserve doubles while it is cheap, then grows in fixed
  // steps, and stops entirely rather than push a cell past the RPC ceiling —
  // a file that would fit exactly must never be made not to fit.
  const _CELL_RESERVE_CAP = 2 * 1024 * 1024;
  const _CELL_PAYLOAD_CAP = 29360128;
  function _spliceCell(base, pos, bytes) {
    const size = Math.max(base.byteLength, pos + bytes.byteLength);
    const capacity = base.buffer.byteLength - base.byteOffset;
    if (pos >= base.byteLength && size <= capacity) {
      const grown = new Uint8Array(base.buffer, base.byteOffset, size);
      grown.fill(0, base.byteLength, pos);
      grown.set(bytes, pos);
      return grown;
    }
    if (size <= capacity) {
      const next = new Uint8Array(new ArrayBuffer(capacity), 0, size);
      next.set(base, 0);
      next.set(bytes, pos);
      return next;
    }
    const wanted = Math.min(Math.max(size, capacity * 2), size + _CELL_RESERVE_CAP);
    const next = new Uint8Array(new ArrayBuffer(wanted < _CELL_PAYLOAD_CAP ? wanted : size), 0, size);
    next.set(base, 0);
    next.set(bytes, pos);
    return next;
  }

  // Overlay `bytes` at `pos` into the local sync-view cell so sync reads
  // stay coherent after a live ranged write. No-op when there is no cell.
  function _overlayLocalCell(absPath, pos, bytes) {
    const k = _strip(absPath);
    const cell = _writtenCell(absPath);
    if (cell === undefined) return;
    _ownWriteTimes[k] = Date.now();
    const next = _spliceCell(_asBytes(cell), pos, bytes);
    if (__vfsWrites && k in __vfsWrites) __vfsWrites[k] = next;
    if (__vfsBundle && k in __vfsBundle) __vfsBundle[k] = next;
  }

  function _statObject(meta, key) {
    const type = meta?.type || (meta?.isDir || meta?.isDirectory ? "directory" : "file");
    const isDir = type === "directory";
    const isSymlink = type === "symlink";
    const size = Number(meta?.size || 0);
    const mtime = new Date(Number(meta?.mtime ?? Date.now()));
    const atime = new Date(Number(meta?.atime ?? meta?.mtime ?? Date.now()));
    const mode = Number(meta?.mode ?? (isDir ? 0o755 : 0o644));
    const stat = _localStatObject(key, isDir, isSymlink, size, mode, meta?.uid, meta?.gid);
    // This process's own utimes, until it is reported back, ahead of the
    // namespace's (_recordLocalTimes).
    const own = key === undefined ? undefined : _localTimes[key];
    stat.atime = own && Number.isFinite(own.atimeMs) ? new Date(own.atimeMs) : atime;
    stat.mtime = own && Number.isFinite(own.mtimeMs) ? new Date(own.mtimeMs) : mtime;
    stat.ctime = new Date(Number(meta?.ctime ?? meta?.mtime ?? Date.now()));
    stat.birthtime = stat.ctime;
    stat.atimeMs = stat.atime.getTime();
    stat.mtimeMs = stat.mtime.getTime();
    stat.ctimeMs = stat.ctime.getTime();
    stat.birthtimeMs = stat.birthtime.getTime();
    if (meta?.ino !== undefined) stat.ino = Number(meta.ino);
    return stat;
  }

  // Each exact dirent type's S_IFMT bits and Node predicate (core's vfs/dirent-type.ts).
  const _direntTypes = {"file":{"format":32768,"node":"isFile"},"directory":{"format":16384,"node":"isDirectory"},"symlink":{"format":40960,"node":"isSymbolicLink"},"character":{"format":8192,"node":"isCharacterDevice"},"block":{"format":24576,"node":"isBlockDevice"},"fifo":{"format":4096,"node":"isFIFO"},"socket":{"format":49152,"node":"isSocket"}};
  /** The dirent type a mode's format bits name, or `fallback` where they name none. */
  function _direntTypeOfMode(mode, fallback) {
    const format = Number(mode) & 0o170000;
    for (const type in _direntTypes) if (_direntTypes[type].format === format) return type;
    return fallback;
  }
  /** The dirent type an lstat says, for an entry the listing could not type ('unknown'). */
  function _direntTypeOfStats(st) {
    return _direntTypeOfMode(st.mode, st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : "file");
  }

  // The one Dirent shape: readdir({ withFileTypes }) sync and async, and
  // every Dir.read(), for an entry whose type is known (an 'unknown' one is
  // lstat'ed first). `parentPath` is Node's field; `path` its deprecated
  // alias that older callers still read.
  class __Dirent {
    constructor(name, type, parentPath) {
      this.name = name;
      this.parentPath = parentPath === undefined ? "" : String(parentPath);
      this.path = this.parentPath;
      this._holds = _direntTypes[type === "dir" ? "directory" : type]?.node;
    }
    isFile() { return this._holds === "isFile"; }
    isDirectory() { return this._holds === "isDirectory"; }
    isSymbolicLink() { return this._holds === "isSymbolicLink"; }
    isBlockDevice() { return this._holds === "isBlockDevice"; }
    isCharacterDevice() { return this._holds === "isCharacterDevice"; }
    isFIFO() { return this._holds === "isFIFO"; }
    isSocket() { return this._holds === "isSocket"; }
  }
  function _direntObject(name, type, parentPath) { return new __Dirent(name, type, parentPath); }

  // Largest single ranged read issued against the supervisor. Every live
  // read path (read streams, whole-file async reads) is expressed as a
  // sequence of reads this size, so neither side ever allocates a whole
  // multi-MB file for one RPC frame.
  const READ_STREAM_CHUNK_BYTES = 65536;

  // Ranged reads issued in the same microtask turn travel as ONE batch, and
  // so do lstats (_learnLive): one request kind each, one round trip.
  //
  // A round trip costs an order of magnitude more than the read behind it,
  // so a program awaiting reads one at a time pays for round trips and
  // nothing else. Nothing here changes what a read sees: every request is
  // the same live ranged read or lstat, executed in order, in the caller's
  // turn. The gather window is one microtask, so it can only capture
  // requests the program had already issued concurrently — a sequential
  // loop batches nothing because it has issued nothing else to batch.
  const READ_BATCH_PATH_LIMIT = 1024;
  const READ_BATCH_REQUEST_BYTES = 4194304;
  let _openReadBatch = null;

  function _queueRangeRead(supervisor, absPath, pos, want) {
    return _queueBatchRequest(supervisor, { path: absPath, offset: pos, length: want }, want);
  }

  // `request` in the open batch, `bytes` of file content counted against the
  // batch's bound. Settles with the entry's bytes for a range, its stat for
  // an lstat.
  function _queueBatchRequest(supervisor, request, bytes) {
    let batch = _openReadBatch;
    if (batch && (
      batch.requests.length >= READ_BATCH_PATH_LIMIT
      || batch.bytes + bytes > READ_BATCH_REQUEST_BYTES
    )) {
      _openReadBatch = null;
      _flushReadBatch(batch);
      batch = null;
    }
    if (!batch) {
      batch = { supervisor, requests: [], settlers: [], bytes: 0 };
      _openReadBatch = batch;
      queueMicrotask(() => {
        // A batch a bound closed was flushed then; sending it here too would
        // read every entry of it twice.
        if (_openReadBatch !== batch) return;
        _openReadBatch = null;
        _flushReadBatch(batch);
      });
    }
    batch.bytes += bytes;
    batch.requests.push(request);
    const settler = Promise.withResolvers();
    batch.settlers.push(settler);
    return settler.promise;
  }

  async function _flushReadBatch(batch) {
    // A read round trip is one that carries a range; a batch of learns
    // (lstat requests) is metadata, which the read count leaves out.
    if (batch.requests.some((request) => request.lstat !== true)) globalThis.__nimbusFsRpcReads++;
    try {
      const entries = await __nimbusUseRpcResult(
        batch.supervisor.fsReadBatch(batch.requests), (r) => r,
      );
      for (let i = 0; i < batch.settlers.length; i++) {
        const entry = entries[i];
        if (entry && entry.error) {
          batch.settlers[i].reject(entry.error);
        } else if (batch.requests[i].lstat === true) {
          batch.settlers[i].resolve(entry ? entry.stat : null);
        } else {
          batch.settlers[i].resolve(entry ? entry.bytes : null);
        }
      }
    } catch (error) {
      for (const settler of batch.settlers) settler.reject(error);
    }
  }

  /**
   * Read `want` bytes at `pos`. Async reads always consult the live VFS.
   * A pending sync write is flushed first, so the supervisor remains the
   * authority without losing this facet's newer local bytes.
   * Returns null at EOF, throws ENOENT when the path does not exist.
   */
  async function _readRangeAt(absPath, displayPath, pos, want) {
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.fsReadBatch === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      let bytes;
      try { bytes = await _queueRangeRead(supervisor, absPath, pos, want); }
      catch (error) { throw _mapSupervisorError(error, "read", displayPath); }
      if (bytes === null || bytes === undefined) throw _fsErr("ENOENT", "open", displayPath);
      return bytes.byteLength === 0 ? null : bytes;
    }
    if (supervisor && typeof supervisor.fsReadRange === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      const bytes = await _fsReadRpc(supervisor.fsReadRange(absPath, pos, want), "read", displayPath, (r) => r);
      if (bytes === null || bytes === undefined) throw _fsErr("ENOENT", "open", displayPath);
      return bytes.byteLength === 0 ? null : bytes;
    }
    const cell = _writtenCell(absPath);
    if (cell !== undefined) {
      const denial = _denialCode(cell);
      if (denial) throw _fsErr(denial, "read", displayPath);
      const bytes = _asBytes(cell);
      if (pos >= bytes.byteLength) return null;
      return bytes.slice(pos, Math.min(bytes.byteLength, pos + want));
    }
    throw _fsErr("ENOENT", "open", displayPath);
  }

  // Every chunk of `absPath` from `from` to EOF, issued in ONE turn so the
  // read batch carries them together. A stat bounds the walk; a chunk that
  // comes back short or missing still ends the file, exactly as taking them
  // one at a time did, so a file that shrank under the reader is read short
  // rather than read wrong.
  async function _readChunksFrom(absPath, displayPath, supervisor, from) {
    const meta = await _fsRpc(supervisor.stat(absPath), "stat", displayPath, (result) => result);
    const end = meta ? Number(meta.size) || 0 : 0;
    const offsets = [];
    for (let off = from; off < end; off += READ_STREAM_CHUNK_BYTES) offsets.push(off);
    const chunks = await Promise.all(offsets.map((off) => _readRangeAt(
      absPath, displayPath, off, Math.min(READ_STREAM_CHUNK_BYTES, end - off),
    )));
    const parts = [];
    for (const chunk of chunks) {
      if (chunk === null) break;
      parts.push(chunk);
      if (chunk.byteLength < READ_STREAM_CHUNK_BYTES) break;
    }
    return parts;
  }

  async function _liveReadFile(p, opts, refetch) {
    const absPath = _resolve(p);
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    const supervisor = _supervisor();
    if (!supervisor) throw _fsErr("ENOENT", "open", p);
    // A refetch (_refetch) has already acquired against a fresh cursor and
    // holds the fill ticket issued under it, so re-acquiring here would be a
    // redundant round trip that always returns "still R". Every other caller
    // acquires, and its fill ticket is its own.
    // The barrier, the first chunk and the authority's stat of the file, in
    // one round trip where the supervisor takes them together: three before.
    // Its fill is begun before the call, so a barrier applied while the call
    // is out reports against it, and dated when the answer comes back
    // (_acquiredRead).
    let fill = refetch || null;
    let reachedFill = null;
    let first = null;
    if (!refetch && _servesFsAcquired(supervisor) && typeof supervisor.fsReadRange === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      fill = _beginFill(_strip(absPath));
      try {
        const entries = await _acquiredRead(
          supervisor, "fsReadBatch",
          [[{ path: absPath, offset: 0, length: READ_STREAM_CHUNK_BYTES }, { path: absPath, lstat: true }]],
          (promise) => _fsReadRpc(promise, "read", p, (result) => result), "read", p, fill,
        );
        const [read, learned] = Array.isArray(entries) ? entries : [];
        if (!read || read.error) throw _mapSupervisorError(read ? read.error : null, "read", p);
        if (read.bytes === null || read.bytes === undefined) throw _fsErr("ENOENT", "open", p);
        first = {
          chunk: read.bytes.byteLength === 0 ? null : read.bytes,
          stat: learned && !learned.error ? learned.stat ?? null : undefined,
          path: typeof read.path === "string" ? read.path : undefined,
        };
        // Reached through a link: the barriers report the file by its own
        // name, so that is the name whose reports date the fill from here.
        // Anything applied since the read's own barrier may already have
        // reported it unheard, so a cursor that moved spoils it.
        if (first.path !== undefined && _strip(first.path) !== _strip(absPath)) {
          reachedFill = _beginFill(_strip(first.path));
          reachedFill.rev = fill.rev;
          if (fill.reported > fill.rev || _cursor.rev !== fill.rev) reachedFill.reported = Infinity;
        }
      } catch (error) {
        _endFill(fill);
        if (reachedFill) _endFill(reachedFill);
        throw error;
      }
    } else if (!refetch) {
      await _acquireBarrier(supervisor);
    }
    fill ??= _beginFill(_strip(absPath));
    try {
      if (typeof supervisor.fsReadRange === "function") {
        // Chunked: the caller wants the whole file, but nothing upstream has
        // to hold it all at once to produce it.
        //
        // A short chunk is the only signal the file ended, so this walk could
        // only ever have one chunk in flight — 65 sequential round trips for a
        // 4 MiB file, each costing far more than the read behind it. The FIRST
        // chunk still costs exactly one trip and settles it for every file
        // that fits in one. When it comes back full there is demonstrably
        // more, and a stat says how much, so the remainder is issued together
        // and the read batch carries it in a single trip.
        const parts = [];
        let total = 0;
        for (;;) {
          const chunk = first !== null && total === 0 ? first.chunk : await _readRangeAt(absPath, p, total, READ_STREAM_CHUNK_BYTES);
          if (chunk === null) break;
          parts.push(chunk);
          total += chunk.byteLength;
          if (chunk.byteLength < READ_STREAM_CHUNK_BYTES) break;
          if (typeof supervisor.stat !== "function") continue;
          for (const rest of await _readChunksFrom(absPath, p, supervisor, total)) {
            parts.push(rest);
            total += rest.byteLength;
          }
          break;
        }
        const bytes = parts.length === 1 ? parts[0] : _concatBytes(parts, total);
        // The file the first chunk reached. A later chunk read through a link
        // may reach another, so a read through one in several chunks names none.
        const asked = _strip(absPath);
        const reached = first === null || first.path === undefined ? undefined
          : _strip(first.path) === asked || total <= READ_STREAM_CHUNK_BYTES ? first.path : null;
        _installResident(absPath, bytes, reachedFill ?? fill, reached);
        // The read resolved a link differently from this view, which a peer
        // changed after the read's barrier: catch the view up, so a sync read
        // through the link is not older than what this one returned.
        if (typeof reached === "string" && _nsLandingKey(asked) !== _strip(reached)) await _acquireBarrier(supervisor);
        const kept = first !== null && first.stat !== undefined && total <= READ_STREAM_CHUNK_BYTES && _noteLearnedStat(absPath, first.stat, fill);
        if (!kept) await _learnLive(absPath, supervisor);
        return encoding ? _asString(bytes) : __BufferMod.from(bytes);
      }

      if (typeof supervisor.readFile === "function") {
        await _flushLocalPathToSupervisor(absPath, supervisor);
        const text = await _fsReadRpc(supervisor.readFile(absPath), "open", p, (result) => result);
        if (text !== null && text !== undefined) {
          _installResident(absPath, text, fill);
          await _learnLive(absPath, supervisor);
          return encoding ? _asString(text) : __BufferMod.from(text);
        }
      }
    } finally {
      if (!refetch) _endFill(fill);
      if (reachedFill) _endFill(reachedFill);
    }

    throw _fsErr("ENOENT", "open", p);
  }



  /** Paths whose write-back this process issued and the authority accepted. */
  const _acceptedHere = new Set();
  globalThis.__nimbusVfsWriteLanded = (key) => {
    const k = String(key).replace(/^\/+/, "");
    _acceptedHere.add(k);
  };

  // The authority refused a parked write (vfs-write-ledger): the record may
  // be that write's, so it is forgotten and the next access asks the authority.
  globalThis.__nimbusVfsWriteRefused = (key) => {
    const k = String(key).replace(/^\/+/, "");
    _createdHere.delete(k);
    _acceptedHere.delete(k);
  };

  function _concatBytes(parts, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of parts) { out.set(part, off); off += part.byteLength; }
    return out;
  }

  async function _readFileAsync(p, opts) {
    if (p === 0 || __NIMBUS_STDIN_PATHS.has(p)) return readFileSync(p, opts);
    const supervisor = _supervisor();
    if (supervisor && (
      typeof supervisor.fsReadRange === "function" ||
      typeof supervisor.readFile === "function"
    )) {
      const out = await _liveReadFile(p, opts);
      _residencySatisfied(_resolve(p));
      return out;
    }
    return readFileSync(p, opts);
  }

  /**
   * The ops a session deployed before them does not serve, and whether this
   * one does: a refusal that says so switches the process to the calls those
   * ops replaced, from then on. An RPC stub answers `typeof "function"` for
   * any method, so only the refusal can tell.
   */
  const _served = { fsAcquired: true, writeFileStat: true };
  /** The refusal of `op` by an entrypoint without the method, a host without the op, or one that refuses its envelope. */
  function _unserved(error, op) {
    const message = error && typeof error.message === "string" ? error.message : "";
    return message.includes('does not implement the method "' + op + '"')
      || message.includes("'" + op + "' is not served by this host")
      || message.includes("'" + op + "' is not a read")
      || message.includes("'deliverOnce' names no mutation it can deliver once");
  }

  /**
   * The barrier and the read an async call makes after it, in one round
   * trip (session/rpc.ts _rpcFsAcquired): the authority answers the barrier
   * before it reads, and the barrier is applied before the value is used,
   * as when they were two calls. A refused read is answered as data, so the
   * barrier is applied before it throws. `rpc` wraps the call as the read's
   * own call was wrapped (_fsRpc or _fsReadRpc, with its syscall).
   *
   * `fill`, when the read is to fill the sync view, was begun before the
   * call. Its bytes were served after the barrier's answer was computed, so
   * they are dated at that answer's revision, but only when applying it
   * left the cursor exactly there: a cursor moved further by anything else
   * (a repair already in flight, a barrier asked separately) has passed
   * changes this fill was never told of, and it installs nothing.
   *
   * A session that does not serve fsAcquired (one deployed before it) is
   * asked for the barrier and the read separately, from then on.
   */
  function _servesFsAcquired(supervisor) {
    return _served.fsAcquired && typeof supervisor.fsAcquired === "function";
  }
  async function _acquiredRead(supervisor, op, args, rpc, syscall, p, fill) {
    const acquire = _acquireArgs();
    let answer;
    try {
      answer = await __nimbusUseRpcResult(supervisor.fsAcquired(acquire, op, args), (result) => result);
    } catch (error) {
      if (!_unserved(error, "fsAcquired")) throw _mapSupervisorError(error, syscall, p);
      _served.fsAcquired = false;
      await _acquireBarrier(supervisor);
      if (fill) fill.reported = Infinity;
      return rpc(supervisor[op](...args));
    }
    const acquired = answer ? answer.acquired : undefined;
    await _acquireBarrier(supervisor, acquired);
    if (fill) {
      const dated = acquired && acquired.answer;
      if (dated && dated.poison !== true && typeof dated.rev === "number"
          && dated.epoch === _cursor.epoch && dated.rev === _cursor.rev) {
        if (dated.rev > fill.rev) fill.rev = dated.rev;
      } else {
        fill.reported = Infinity;
      }
    }
    if (answer && answer.failure) throw _mapSupervisorError(answer.failure, syscall, p);
    return answer ? answer.value : null;
  }

  async function _statAsync(p) { return _statAsyncAs("stat", p); }
  async function _lstatAsync(p) { return _statAsyncAs("lstat", p); }
  async function _statAsyncAs(syscall, p) {
    const absPath = _resolve(p);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor[syscall] === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor, syscall === "stat");
      const rpc = (promise) => _fsRpc(promise, syscall, p, (result) => result);
      let meta;
      if (_servesFsAcquired(supervisor)) {
        meta = await _acquiredRead(supervisor, syscall, [absPath], rpc, syscall, p);
      } else {
        await _acquireBarrier(supervisor);
        meta = await rpc(syscall === "stat" ? supervisor.stat(absPath) : supervisor.lstat(absPath));
      }
      if (meta) return _statObject(meta);
      throw _fsErr("ENOENT", syscall, p);
    }
    return syscall === "stat" ? statSync(p) : lstatSync(p);
  }

  async function _readdirAsync(p, opts) {
    const absPath = _resolve(p);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.readdir === "function") {
      const key = _strip(absPath);
      const prefix = key ? key + "/" : "";
      await _acquireBarrier(supervisor);
      await _flushLocalPathToSupervisor(absPath, supervisor);
      for (const localPath of Object.keys(__vfsWrites || {})) {
        if (localPath !== key && localPath.startsWith(prefix)) {
          await _flushLocalPathToSupervisor("/" + localPath, supervisor);
        }
      }
      for (const localPath of Object.keys(__vfsDirs || {})) {
        if (localPath !== key && localPath.startsWith(prefix)) {
          await _flushLocalPathToSupervisor("/" + localPath, supervisor);
        }
      }
      const entries = await _fsRpc(supervisor.readdir(absPath), "scandir", p, (result) => result);
      if (Array.isArray(entries)) {
        // Every local mutation under this directory was just flushed, so the
        // live listing is strictly newer than the spawn-time snapshot. Record
        // its shape: the sync existence view must not go on contradicting a
        // directory this very process has enumerated. Names only — size, mode
        // and ownership are not observable here and are never invented.
        // The listed directory and its child directories get the authority's
        // own stat: a later synchronous stat or listing of them needs a record
        // saying what they are, and a record says who owns them, which a
        // listing does not. So it is asked for, never assumed (one lstat per
        // child directory, concurrently).
        if (opts?.withFileTypes) {
          const base = absPath === "/" ? "" : absPath;
          const types = await Promise.all(entries.map(async (entry) =>
            entry.type === "unknown" ? _direntTypeOfStats(await _lstatAsync(base + "/" + entry.name)) : entry.type));
          return entries
            .map((entry, i) => _direntObject(entry.name, types[i], absPath))
            .sort((a, b) => a.name.localeCompare(b.name));
        }
        return entries.map((entry) => entry.name).sort();
      }
      throw _fsErr("ENOENT", "scandir", p);
    }
    return readdirSync(p, opts);
  }

  async function _existsAsync(p) {
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.exists === "function") {
      const absPath = _resolve(p);
      await _flushLocalPathToSupervisor(absPath, supervisor);
      return !!(await __nimbusUseRpcResult(supervisor.exists(absPath), (r) => r));
    }
    return existsSync(p);
  }

  async function _readlinkAsync(p) {
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.readlink === "function") {
      const absPath = _resolve(p);
      await _awaitStructuralOrder(absPath);
      const target = await _fsRpc(supervisor.readlink(absPath), "readlink", p, (result) => result);
      if (target !== null && target !== undefined) return target;
    }
    throw _fsErr("EINVAL", "readlink", p);
  }

  async function _symlinkAsync(target, path) {
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.symlink === "function") {
      const absPath = _resolve(path);
      await _awaitStructuralOrder(absPath);
      // Node names the target, then the link: "symlink 'target' -> 'link'".
      await _fsRpc(supervisor.symlink(String(target), absPath), "symlink", String(target), () => undefined, path);
      _markVfsStale();
      return;
    }
    throw _fsErr("ENOSYS", "symlink", String(target), path);
  }

  async function _writeFileAsync(p, data, opts) {
    const absPath = _resolveFollow(p, "open");
    const supervisor = _supervisor();
    // A target this view cannot judge (on a mount, where the launch did not
    // list it) is the authority's to answer for, as the async rename's
    // destination is: parked and written back like any other write, and
    // refused (and the parked bytes dropped) if the authority refuses it.
    _parkWholeWrite(p, data, supervisor && typeof supervisor.writeFile === "function");
    if (supervisor && typeof supervisor.writeFile === "function") {
      await _announceLocalDirs(absPath, supervisor);
      // The revision comes back so the ledger can stamp the cell: an async
      // whole write is the facet's own as much as a parked sync one is.
      // The authority's stat comes back with the write where it can, and is
      // what the sync view keeps for the path. The ticket hears what the
      // barriers report of the path while the write is out.
      let learned;
      let written;
      let kept = false;
      const ticket = _beginFill(_strip(absPath));
      try {
        await __nimbusFlushVfsWrite(absPath, async (content) => {
          if (_served.writeFileStat && typeof supervisor.writeFileStat === "function") {
            try {
              const answer = await __nimbusUseRpcResult(supervisor.writeFileStat(absPath, content), (result) => result);
              learned = answer.stat;
              written = answer.revision;
              return answer.revision;
            } catch (error) {
              if (!_unserved(error, "writeFileStat")) throw _mapSupervisorError(error, "write", p);
              _served.writeFileStat = false;
            }
          }
          written = await _fsRpc(supervisor.writeFile(absPath, content), "write", p, (result) => result);
          return written;
        });
        _markVfsStale();
        if (typeof written !== "number") written = undefined;
        if (learned !== undefined) kept = _noteLearnedStat(absPath, learned, ticket, written);
      } finally {
        _endFill(ticket);
      }
      if (!kept) await _learnLive(absPath, supervisor, written);
    }
  }

  async function _appendFileAsync(p, data, opts) {
    const absPath = _resolveFollow(p, "open");
    appendFileSync(p, data, opts);
    const supervisor = _supervisor();
    if (!supervisor || typeof supervisor.writeFile !== "function") return;
    await _announceLocalDirs(absPath, supervisor);
    await __nimbusFlushVfsWrite(
      absPath,
      (content, snapshot) => _fsRpc(
        __nimbusPersistVfsWrite(supervisor, absPath, content, snapshot),
        "write", p,
        (result) => result,
      ),
    );
    _markVfsStale();
    await _learnLive(absPath, supervisor);
  }

  // The async structural calls ARE the sync ones, awaited: the same local
  // effect and the same queued authority RPC, so the two forms cannot
  // disagree about order, and a program mixing them sees one sequence.
  async function _mkdirAsync(p, opts) { await _mkdirQueued(p, opts); }
  async function _unlinkAsync(p) { await _unlinkQueued(p); }
  async function _rmdirAsync(p) { await _rmdirQueued(p); }
  async function _renameAsync(oldP, newP) { await _renameQueued(oldP, newP, true); }

  async function _truncateAsync(p, len) {
    const absPath = _resolveFollow(p, "open");
    const size = Math.max(0, Math.trunc(Number(len) || 0));
    const supervisor = _supervisor();
    const localCell = _bundleLookup(absPath);
    if (supervisor && typeof supervisor.fsTruncate === "function") {
      await _announceLocalDirs(absPath, supervisor);
      const k = _strip(absPath);
      if (__vfsWrites && k in __vfsWrites) {
        const append = __nimbusCapturePendingVfsAppend(k);
        if (append) {
          const flush = __nimbusFlushVfsWrite(
            absPath,
            (content, snapshot) =>
              __nimbusPersistVfsWrite(supervisor, absPath, content, snapshot),
          );
          // Persisting the append drops the resident cell (the ledger
          // refetches it on the next live read), so there is no cell to
          // trim or stamp behind this truncate.
          await __nimbusQueueVfsMutation(absPath, async () => {
            await flush;
            await _fsRpc(
              supervisor.fsTruncate(absPath, size),
              "truncate", p,
              () => undefined,
            );
          });
          _markVfsStale();
          return;
        }
        // Unflushed sync writes: trim locally, then flush the pending
        // cell whole (it was going to flush whole anyway).
        if (localCell === undefined) throw _fsErr("ENOENT", "truncate", p);
        _truncateLocalCell(absPath, size);
        await _flushLocalPathToSupervisor(absPath, supervisor);
        return;
      }
      // Live file is the source of truth — supervisor trims only the
      // boundary chunk; ENOENT propagates when it does not exist.
      const generation = __vfsWriteGenerations[k];
      await __nimbusQueueVfsMutation(absPath, () => _ownMutation(
        absPath,
        () => _fsRpc(supervisor.fsTruncate(absPath, size), "truncate", p, (result) => result),
        () => {
          if (__vfsWriteGenerations[k] === generation && localCell !== undefined) {
            _truncateLocalCell(absPath, size);
          }
        },
      ));
      _markVfsStale();
      return;
    }
    if (localCell === undefined) throw _fsErr("ENOENT", "truncate", p);
    _truncateLocalCell(absPath, size);
  }

  function utimesSync(p, atime, mtime) {
    if (!existsSync(p)) throw _absentErr(_resolve(p), "utimes", p, "fs.promises.utimes");
    const absPath = _resolveFollow(p, "utimes");
    _recordLocalTimes(absPath, atime, mtime, "utimes", p);
  }

  function lutimesSync(p, atime, mtime) {
    if (!existsSync(p)) throw _absentErr(_resolve(p), "lutimes", p, "fs.promises.lutimes", false);
    const absPath = _resolve(p);
    _recordLocalTimes(absPath, atime, mtime, "lutimes", p);
  }

  async function _utimesAsync(p, atime, mtime, opts, syscallOverride) {
    const followSymlinks = !(opts && opts.followSymlinks === false);
    const syscall = syscallOverride || (followSymlinks ? "utimes" : "lutimes");
    const absPath = followSymlinks ? _resolveFollow(p, syscall) : _resolve(p);
    const supervisor = _supervisor();
    let localExists = false;
    try { localExists = existsSync(p); } catch {}
    if (!localExists && (!supervisor || typeof supervisor.utimes !== "function")) {
      throw _fsErr("ENOENT", syscall, p);
    }
    const time = _recordLocalTimes(absPath, atime, mtime, syscall, p);
    if (supervisor && typeof supervisor.utimes === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor, followSymlinks);
      // Ordered behind the path's pending mutations: an fd write queued a
      // moment ago (modern-tar writes, then futimes, then closes) would
      // otherwise land AFTER the timestamp and reset it to "now".
      const leased = () => _ownMutation(absPath, () => _fsRpc(
        supervisor.utimes(absPath, time.atimeMs, time.mtimeMs),
        syscall, p,
        (result) => result,
      ));
      if (_hasVfsMutationQueue()) await __nimbusQueueVfsMutation(absPath, leased);
      else await leased();
      _markVfsStale();
      return;
    }
    if (!supervisor && !existsSync(p)) throw _fsErr("ENOENT", syscall, p);
  }

  /**
   * chmod(2): only the owner or root changes a mode (EPERM). The local
   * overlay is what statSync reports and what the local permission checks
   * read, so a mode set here without that check made a root-owned file
   * writable in the process's own view.
   */
  function _ensureModeOwner(absPath, syscall, p) {
    if (Number(cred.uid) === 0) return;
    const stat = _statLadder(absPath);
    if (stat === undefined) throw _absentErr(absPath, syscall, p, "fs.promises.chmod");
    if (Number(stat.uid) !== Number(cred.uid)) throw _fsErr("EPERM", syscall, p);
  }

  function chmodSync(p, mode) {
    if (!existsSync(p)) throw _absentErr(_resolve(p), "chmod", p, "fs.promises.chmod");
    const absPath = _resolveFollow(p, "chmod");
    _ensureModeOwner(absPath, "chmod", p);
    // Local-visible immediately (statSync overlay); the live write-through
    // rides the next flush of the same path — same fidelity as utimesSync.
    const k = _strip(absPath);
    _localModes[k] = _coerceMode(mode, "chmod", p);
    _pendingModes.add(k);
  }

  async function _chmodAsync(p, mode) {
    const absPath = _resolveFollow(p, "chmod");
    const supervisor = _supervisor();
    let localExists = false;
    try { localExists = existsSync(p); } catch {}
    if (!localExists && (!supervisor || typeof supervisor.chmod !== "function")) {
      throw _fsErr("ENOENT", "chmod", p);
    }
    const m = _coerceMode(mode, "chmod", p);
    if (localExists) _ensureModeOwner(absPath, "chmod", p);
    _localModes[_strip(absPath)] = m;
    _pendingModes.add(_strip(absPath));
    if (supervisor && typeof supervisor.chmod === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      _markVfsStale();
      return;
    }
    if (!supervisor && !existsSync(p)) throw _fsErr("ENOENT", "chmod", p);
  }

  function _coerceId(value, syscall, p) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 0) throw _fsErr("EINVAL", syscall, p);
    return id;
  }

  async function _chownAsync(p, uid, gid, opts, syscallOverride) {
    const followSymlinks = !(opts && opts.followSymlinks === false);
    const syscall = syscallOverride || (followSymlinks ? "chown" : "lchown");
    const absPath = _resolve(p);
    const supervisor = _supervisor();
    if (!supervisor || typeof supervisor.chown !== "function") {
      if (!existsSync(p)) throw _fsErr("ENOENT", syscall, p);
      throw _fsErr("ENOSYS", syscall, p);
    }
    const nextUid = _coerceId(uid, syscall, p);
    const nextGid = _coerceId(gid, syscall, p);
    await _flushLocalPathToSupervisor(absPath, supervisor, followSymlinks);
    await _ownMutation(
      absPath,
      () => _fsRpc(supervisor.chown(absPath, nextUid, nextGid, opts), syscall, p, (result) => result),
      () => {
        const meta = _metadata(absPath);
        if (meta) { meta.uid = nextUid; meta.gid = nextGid; }
      },
    );
    _markVfsStale();
  }

  // Sync ownership change: the stat record is updated locally at once and
  // the authority RPC is queued behind the path's pending flush, the same
  // parked model mkdirSync/unlinkSync use. Without an authority there is no
  // owner table to change, so the answer is the same ENOSYS as the async form.
  function _chownQueued(p, uid, gid, opts, syscall) {
    const followSymlinks = !(opts && opts.followSymlinks === false);
    const absPath = _resolve(p);
    const supervisor = _supervisor();
    if (!supervisor || typeof supervisor.chown !== "function") {
      if (!existsSync(p)) throw _fsErr("ENOENT", syscall, p);
      throw _fsErr("ENOSYS", syscall, p);
    }
    const nextUid = _coerceId(uid, syscall, p);
    const nextGid = _coerceId(gid, syscall, p);
    // chown(2): root changes anything; the owner may only set the group to
    // one of its own groups, and never the owner. Checked before the local
    // row changes: that row is what the local permission checks read.
    if (Number(cred.uid) !== 0) {
      const stat = _statLadder(absPath);
      if (stat === undefined) throw _absentErr(absPath, syscall, p, "fs.promises.chown", followSymlinks);
      const groups = [Number(cred.gid), ...cred.groups.map(Number)];
      if (Number(stat.uid) !== Number(cred.uid) || nextUid !== Number(stat.uid)
        || (nextGid !== Number(stat.gid) && !groups.includes(nextGid))) {
        throw _fsErr("EPERM", syscall, p);
      }
    }
    const meta = _metadata(absPath);
    if (meta) { meta.uid = nextUid; meta.gid = nextGid; }
    // The parked write must be registered on the tail BEFORE the chown is
    // (a flush awaited from inside the queued step would queue behind it
    // and wait on itself), so it is the synchronous-registering flush.
    return _queueStructuralMutation(
      absPath, syscall, p,
      (s) => s.chown(absPath, nextUid, nextGid, followSymlinks ? undefined : { followSymlinks: false }),
      () => _flushParkedWrite(absPath, supervisor),
      "chown",
    );
  }
  function chownSync(p, uid, gid) { _detachStructuralMutation(_chownQueued(p, uid, gid, undefined, "chown")); }
  function lchownSync(p, uid, gid) { _detachStructuralMutation(_chownQueued(p, uid, gid, { followSymlinks: false }, "lchown")); }
  function lchmodSync(p, mode) { chmodSync(p, mode); }

  /**
   * Whether this process may WANT (r=4, w=2, x=1) a path whose stat is
   * META, by POSIX's owner/group/other rule. Only a stat that states the
   * owner, group and mode can be judged; one that does not is not judged in
   * the process's favour: absent fields used to default to mode 0644 and
   * owner 1000, which made any undescribed file the reader's own.
   */
  function _modeAllows(meta, want) {
    if (want === 0) return true;
    const mode = Number(meta?.mode);
    const uid = Number(meta?.uid);
    const gid = Number(meta?.gid);
    if (!Number.isInteger(mode) || !Number.isInteger(uid) || !Number.isInteger(gid)) return false;
    const bits = mode & 0o777;
    const currentUid = Number(cred.uid);
    if (currentUid === 0) return (want & 1) === 0 || (bits & 0o111) !== 0;
    const groups = cred.groups.map(Number);
    const shift = currentUid === uid ? 6 : (Number(cred.gid) === gid || groups.includes(gid)) ? 3 : 0;
    return (((bits >> shift) & 7) & want) === want;
  }

  /** `p` and `dest`: what a refusal names, the call's own paths, whichever of them `absPath` is. */
  function _ensureAncestorsTraversable(absPath, syscall, p, dest) {
    const parts = _strip(absPath).split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index++) {
      const ancestorMeta = _metadata("/" + parts.slice(0, index).join("/"));
      if (ancestorMeta && !_modeAllows(ancestorMeta, 1)) throw _fsErr("EACCES", syscall, p, dest);
    }
  }

  /** `live`: the caller asks the authority next, so a path the namespace cannot judge is left to it. */
  function _ensureWritable(absPath, syscall, p, live, dest) {
    _ensureAncestorsTraversable(absPath, syscall, p, dest);
    const cell = _bundleLookup(absPath);
    const denial = _denialCode(cell);
    if (denial) throw _fsErr(denial, syscall, p, dest);
    // Judged on what the authority says of the path (or of a file this
    // process made), never on the bytes held under its name.
    const stat = _statLadder(absPath);
    if (stat !== undefined) {
      if (!_modeAllows(stat, 2)) throw _fsErr("EACCES", syscall, p, dest);
      return;
    }
    // Not known to be absent: on a mount, in a directory the launch did not list.
    const mount = _nsUnlisted(absPath, true, false);
    if (mount !== null) {
      if (live) return;
      throw _nsUnlistedErr(mount, syscall, p, "fs.promises." + (syscall === "open" ? "writeFile" : syscall), dest);
    }
    // Nothing there: a create, judged by the parent the namespace describes.

    const parent = __pathMod.dirname(absPath);
    const parentStat = _statLadder(parent);
    if (parentStat !== undefined) {
      if (!parentStat.isDirectory()) throw _fsErr("ENOTDIR", syscall, p, dest);
      if (!_modeAllows(parentStat, 3)) throw _fsErr("EACCES", syscall, p, dest);
      return;
    }

    throw _fsErr("ENOENT", syscall, p, dest);
  }

  function accessSync(p, mode) {
    const absPath = _resolve(p);
    _nsRequire("access", p, "fs.promises.access");
    const cell = _bundleLookup(absPath);
    const meta = _metadata(absPath);
    if (cell === undefined && meta === undefined && !existsSync(p)) throw _absentErr(absPath, "access", p, "fs.promises.access");
    const requested = mode === undefined ? 0 : Number(mode);
    if (!Number.isInteger(requested) || requested < 0 || (requested & ~7) !== 0) {
      throw _fsErr("EINVAL", "access", p);
    }
    _ensureAncestorsTraversable(absPath, "access", p);
    const denial = _denialCode(cell);
    if ((requested & 4) !== 0 && denial) throw _fsErr(denial, "access", p);
    if (requested === 0) return;
    const stat = _statLadder(absPath);
    if (stat === undefined) throw _absentErr(absPath, "access", p, "fs.promises.access");
    if (!_modeAllows(stat, requested)) throw _fsErr("EACCES", "access", p);
  }

  async function _accessAsync(p, mode) {
    const requested = mode === undefined ? 0 : Number(mode);
    const supervisor = _supervisor();
    if (supervisor && typeof supervisor.access === "function") {
      const absPath = _resolve(p);
      await _flushLocalPathToSupervisor(absPath, supervisor);
      await _fsRpc(supervisor.access(absPath, requested), "access", p, () => undefined);
      return;
    }
    accessSync(p, requested);
  }

  // ── readFileSync ──
  // Returns a Buffer when no encoding requested, a string otherwise.
  // The cell shape (string vs Uint8Array) drives conversion:
  //   - text encoding requested + string cell → return string as-is
  //   - text encoding requested + bytes cell → UTF-8 decode bytes
  //   - no encoding + string cell → wrap _enc.encode(...) as Buffer
  //   - no encoding + bytes cell → wrap bytes as Buffer (no copy)
  function readFileSync(p, opts) {
    // fd 0 and the paths that name it read the launch's stdin from the
    // position synchronous reads share (__nimbusSyncStdinState): all of it
    // once its writer has finished. A pipe still open has more to come, which
    // Node blocks for: the run stops until its writer ends it, and runs again
    // (__nimbusStopForStdin). A `< file` larger than the read ahead is
    // served from its start only.
    if (p === 0 || __NIMBUS_STDIN_PATHS.has(p)) {
      if (!__nimbusStdinEnded()) {
        throw __nimbusSyncStdinError("readFileSync", __nimbusStdinFileSource() !== null ? "" : __nimbusStopForStdin("end", "read"));
      }
      const state = __nimbusSyncStdinState();
      const all = state.source.bytes;
      __nimbusReplay?.readAll(all.byteLength - state.pos);
      const bytes = __BufferMod.from(all.subarray(state.pos));
      state.pos = all.byteLength;
      __nimbusStdinFollower?.consumed();
      const encoding = typeof opts === "string" ? opts : opts?.encoding;
      return encoding ? bytes.toString(encoding) : bytes;
    }
    const absPath = _resolve(p);
    _ensureAncestorsTraversable(absPath, "open", p);
    const content = _bundleLookup(absPath);
    if (content === undefined) {
      throw _notResidentError(absPath, p, "open", "fs.promises.readFile");
    }
    const denial = _denialCode(content);
    if (denial) throw _fsErr(denial, "open", p);
    _residencySatisfied(absPath);
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    if (encoding) {
      // text encoding requested — produce a string regardless of cell shape.
      return _asString(content);
    }
    // No encoding requested — produce a Buffer-shaped Uint8Array.
    const bytes = __BufferMod.from(content);
    // A wasm image the launch compiled through the module map is tagged on
    // the way out, so the WebAssembly seam below can answer the package's own
    // new WebAssembly.Module(readFileSync(...)) with the compiled module —
    // request-time compilation from bytes is refused by the runtime.
    const precompiled = __nimbusPrecompiledWasm.get(_strip(absPath));
    if (precompiled !== undefined) bytes[__nimbusWasmModuleTag] = precompiled;
    return bytes;
  }

  // ── writeFileSync ──
  // Uint8Array is preserved as bytes (no UTF-8 round-trip → no
  // EF-BF-BD mangling on bytes ≥ 0x80). String is preserved as string
  // (the hot path for source code / package.json / user JS).
  // Anything else is stringified (Node's behaviour for e.g. numbers).
  function writeFileSync(p, data, opts) {
    _parkWholeWrite(p, data, false);
  }

  /**
   * A whole-file write's local effect: the bytes parked for write-back.
   * `live`: the async form, whose write-back the authority answers for a
   * target this view cannot judge (_ensureWritable).
   */
  function _parkWholeWrite(p, data, live) {
    const absPath = _resolveFollow(p, "open");
    _ensureWritable(absPath, "open", p, live);
    const k = _strip(absPath);
    let cell;
    if (data instanceof Uint8Array) cell = data;
    else if (typeof data === "string") cell = data;
    else cell = String(data);
    _parkWrite(k, cell);
  }

  // ── appendFileSync ──
  // Concat semantics: if EITHER existing or new data is bytes, the
  // combined cell is bytes (lossless for both). When both are strings,
  // stay string (avoids re-encoding ASCII through TextEncoder).
  function appendFileSync(p, data, opts) {
    const absPath = _resolveFollow(p, "open");
    _ensureWritable(absPath, "open", p);
    const k = _strip(absPath);
    const previousAppend = __nimbusCapturePendingVfsAppend(k);
    const hadPendingWrite = Object.prototype.hasOwnProperty.call(__vfsWrites, k);
    const existing = _bundleLookup(absPath);
    const existingDefined = existing !== undefined;
    const dataIsBytes = data instanceof Uint8Array;
    const existingIsBytes = existingDefined && _isBytes(existing);

    let cell;
    if (!existingDefined) {
      // No prior content — same shape as a writeFileSync.
      if (dataIsBytes) cell = data;
      else if (typeof data === "string") cell = data;
      else cell = String(data);
    } else if (dataIsBytes || existingIsBytes) {
      // Promote both to bytes and concat.
      const a = _asBytes(existing);
      const b = _asBytes(dataIsBytes ? data : (typeof data === "string" ? data : String(data)));
      const out = new Uint8Array(a.byteLength + b.byteLength);
      out.set(a, 0);
      out.set(b, a.byteLength);
      cell = out;
    } else {
      // Both strings — string concat.
      cell = existing + (typeof data === "string" ? data : String(data));
    }
    _parkWrite(k, cell);
    // Bundle content is only a sync-view cache and may be stale. It can supply
    // the local display fragment, but only a pending full write owns its prefix.
    if (!hadPendingWrite || previousAppend) {
      const appended = _asBytes(
        dataIsBytes ? data : (typeof data === "string" ? data : String(data)),
      );
      __nimbusRecordVfsAppend(k, appended, _asBytes(cell), previousAppend);
    }
  }

  // ── existsSync ──
  function existsSync(p) {
    const absPath = _resolve(p);
    _nsRequire("access", p, "fs.promises.access");
    _residencySatisfied(absPath);
    return _statLadder(absPath) !== undefined;
  }


  // ── statSync ──
  function statSync(p, opts) {
    const absPath = _resolve(p);
    _ensureAncestorsTraversable(absPath, "stat", p);
    return _statResolved(absPath, p, opts);
  }

  // The stat ladder for a path whose ancestors the caller has already
  // checked. Reading it back out of statSync lets the sync read path
  // classify a miss without redoing the resolve and ancestor walk it just
  // performed — that path runs on every module-resolution probe.
  function _statResolved(absPath, p, opts) {
    _nsRequire("stat", p, "fs.promises.stat");
    const stat = _statLadder(absPath);
    if (stat === undefined) {
      // Not known to be absent: on a mount, in a directory the launch did not list.
      const mount = _nsUnlisted(absPath, true, false);
      if (mount !== null) throw _nsUnlistedErr(mount, "stat", p, "fs.promises.stat");
    }
    // An answer settles the path, including the honest "not there": the
    // namespace names every path this credential can see.
    _residencySatisfied(absPath);
    if (stat !== undefined) return stat;
    // Node's statSync honors { throwIfNoEntry: false } by returning undefined
    // for a missing path instead of throwing.
    if (opts && opts.throwIfNoEntry === false) return undefined;
    throw _fsErr("ENOENT", "stat", p);
  }

  /**
   * The stat ladder itself: everything the sync view can say about a path, or
   * undefined when it has nothing to say. It never decides what "nothing"
   * MEANS — absence and ignorance are different answers and only one of them
   * is a condition a program can act on, so the callers classify.
   */
  function _statLadder(absPath, noFollow) {
    const k = _strip(absPath);
    _nsRequire("stat", absPath, "fs.promises.stat");
    const meta = _nsMeta(k, !noFollow);
    if (meta === "absent" || meta === "ELOOP") return undefined;
    // A followed stat describes the file the links name, and this process's
    // own mode and times for it are kept under that name.
    const key = noFollow ? k : (_nsLandingKey(k) ?? k);
    return meta.own
      ? _localStatObject(key, meta.type === "directory", false, meta.size, meta.mode & 0o7777, meta.uid, meta.gid, true)
      : _statObject(meta, key);
  }

  // ── lstatSync (alias for statSync in our VFS — no symlinks) ──
  function lstatSync(p, opts) {
    const absPath = _resolve(p);
    _nsRequire("lstat", p, "fs.promises.lstat");
    _ensureAncestorsTraversable(absPath, "lstat", p);
    const stat = _statLadder(absPath, true);
    if (stat !== undefined) return stat;
    const mount = _nsUnlisted(absPath, false, false);
    if (mount !== null) throw _nsUnlistedErr(mount, "lstat", p, "fs.promises.lstat");
    if (opts && opts.throwIfNoEntry === false) return undefined;
    throw _fsErr("ENOENT", "lstat", p);
  }

  // ── readdirSync ──
  // The namespace's listing of the directory, with this process's own
  // structural effects over it (_nsList).
  function readdirSync(p, opts) {
    const absPath = _resolve(p);
    _nsRequire("scandir", p, "fs.promises.readdir");
    _ensureAncestorsTraversable(absPath, "scandir", p);
    const metadata = _metadata(absPath);
    if (metadata && !_modeAllows(metadata, 4)) throw _fsErr("EACCES", "scandir", p);
    const k = _strip(absPath);
    const st = _statLadder(absPath);
    if (st === undefined) throw _absentErr(absPath, "scandir", p, "fs.promises.readdir");
    if (!st.isDirectory()) throw _fsErr("ENOTDIR", "scandir", p);
    // A directory on a mount the launch did not list: its entries are not known.
    if (!_nsOwnView(k)?.dir) {
      const mount = _nsUnlisted(absPath, true, true);
      if (mount !== null) throw _nsUnlistedErr(mount, "scandir", p, "fs.promises.readdir");
    }
    _residencySatisfied(absPath);
    const listed = _nsList(k);
    const sorted = [...listed.keys()].sort();
    if (!opts?.withFileTypes) return sorted;
    return sorted.map((n) => _direntObject(n, listed.get(n), absPath));
  }

  // ── mkdirSync ──
  // The sync effect, then the authority mutation queued behind it (see
  // _queueStructuralMutation). One RPC whatever the depth: the async form
  // sends the path alone and the authority's mkdir creates the ancestors.
  function _mkdirQueued(p, opts) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    const created = [];
    if (opts?.recursive) {
      const parts = k.split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) { cur = cur ? cur + "/" + part : part; _noteCreation(cur); __vfsDirs[cur] = true; created.push(cur); }
    } else {
      _noteCreation(k);
      __vfsDirs[k] = true;
      created.push(k);
    }
    for (const dir of created) {
      const was = _nsMeta(dir, true);
      if (was === "absent") _nsOwnSet(dir, "dir", { hide: true });
    }
    const queued = _queueStructuralMutation(absPath, "mkdir", p, (supervisor) => supervisor.mkdir(absPath));
    // Told, not merely known locally: _announceLocalDirs must not issue a
    // second mkdir for a directory whose own RPC is already in the queue.
    if (queued) for (const dir of created) _announcedDirs.add(dir);
    return queued;
  }
  function mkdirSync(p, opts) { _detachStructuralMutation(_mkdirQueued(p, opts)); }

  // ── unlinkSync ──
  /**
   * unlink(2)/rmdir(2)/rename(2) of an existing name: the parent must be
   * writable and searchable, and in a sticky directory (/tmp, 1777) only the
   * file's owner, the directory's owner or root may remove it. Checked before
   * the local view changes, so a refusal leaves the process's view intact. A
   * name whose owner this view does not know is refused as a miss.
   */
  function _ensureRemovable(absPath, syscall, p, dest) {
    _ensureAncestorsTraversable(absPath, syscall, p, dest);
    const k = _strip(absPath);
    const parent = _statLadder(__pathMod.dirname(absPath));
    if (parent === undefined) return;
    if (!_modeAllows(parent, 3)) throw _fsErr("EACCES", syscall, p, dest);
    if ((Number(parent.mode) & 0o1000) === 0 || Number(cred.uid) === 0 || Number(parent.uid) === Number(cred.uid)) return;
    if (_createdHere.has(k)) return;
    const target = _statLadder(absPath, true);
    if (target === undefined) return;
    if (Number(target.uid) !== Number(cred.uid)) throw _fsErr("EPERM", syscall, p, dest);
  }

  function _unlinkQueued(p) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    _ensureRemovable(absPath, "unlink", p);
    if (__vfsBundle) delete __vfsBundle[k];
    if (__vfsWrites) delete __vfsWrites[k];
    _forgetSyncPath(k);
    return _queueStructuralMutation(absPath, "unlink", p, (supervisor) => supervisor.unlink(absPath));
  }
  function unlinkSync(p) { _detachStructuralMutation(_unlinkQueued(p)); }

  // ── rmdirSync ──
  function _rmdirQueued(p) {
    const absPath = _resolve(p);
    const k = _strip(absPath);
    _ensureRemovable(absPath, "rmdir", p);
    if (__vfsDirs) delete __vfsDirs[k];
    _forgetSyncPath(k);
    return _queueStructuralMutation(
      absPath, "rmdir", p,
      (supervisor) => supervisor.rmdir(absPath),
      () => __nimbusAwaitSubtreeMutations(absPath),
    );
  }
  function rmdirSync(p) { _detachStructuralMutation(_rmdirQueued(p)); }

  // ── renameSync ──
  /** `live`: the async form, which the authority answers for a destination the namespace cannot judge. */
  function _renameQueued(oldP, newP, live) {
    const oldAbs = _resolve(oldP);
    const newAbs = _resolve(newP);
    // The name leaves its directory and lands in another (replacing what is
    // there): both are removals by POSIX's rule.
    // Each refusal names the call's two paths, whichever side it judged.
    _ensureRemovable(oldAbs, "rename", oldP, newP);
    const target = _statLadder(newAbs, true);
    if (target !== undefined) _ensureRemovable(newAbs, "rename", oldP, newP);
    else _ensureWritable(newAbs, "rename", oldP, live, newP);
    const oldK = _strip(oldAbs);
    const newK = _strip(newAbs);
    const source = _statLadder(oldAbs, true);
    // A name renamed to itself is left as it is, as rename(2) leaves it, once
    // it is known to exist; a name this view does not list is the authority's
    // to answer for.
    if (oldK === newK) {
      if (source !== undefined) return null;
      if (_nsUnlisted(oldAbs, false, false) === null) throw _fsErr("ENOENT", "rename", oldP, newP);
      return _queueStructuralMutation(oldAbs, "rename", oldP, (supervisor) => supervisor.rename(oldAbs, newAbs), undefined, undefined, newP);
    }
    // What rename(2) refuses before it moves anything, refused here before
    // the local tables move: the sync view applies a rename at once and the
    // authority only later, so a move it refuses would otherwise have been
    // shown, and its descendants' writes sent, under the wrong names.
    // A refusal only the authority can judge (a destination this view does
    // not list) still arrives from it.
    if (source !== undefined && source.isDirectory()) {
      if (newK.startsWith(oldK + "/")) throw _fsErr("EINVAL", "rename", oldP, newP);
      if (target !== undefined && !target.isDirectory()) throw _fsErr("ENOTDIR", "rename", oldP, newP);
      if (target !== undefined && _nsList(newK).size > 0) throw _fsErr("ENOTEMPTY", "rename", oldP, newP);
    } else if (source !== undefined && target !== undefined && target.isDirectory()) {
      throw _fsErr("EISDIR", "rename", oldP, newP);
    }
    // The table still holds the old name until the rename is reported, so the
    // new name reads through to it and the old one reads as gone. rename(2)
    // moves a symlink itself, so a moved link keeps its own entry for lstat.
    const nsFrom = _nsRealKey(oldK);
    const nsEntry = _nsEntryKey(oldK);
    const movedLink = nsEntry !== null && Number(__nsRowAt(__residentRequire(), nsEntry).kind) === __NS_LINK ? nsEntry : undefined;
    // What this process created travels with the name; what it did not stays
    // the authority's, whatever the move does to the local tables.
    const oldPrefix = oldK + "/";
    const createdMoved = [..._createdHere]
      .filter((key) => key === oldK || key.startsWith(oldPrefix))
      .map((key) => newK + key.slice(oldK.length));
    const content = __vfsBundle?.[oldK] ?? __vfsWrites?.[oldK];
    if (content !== undefined) {
      _parkWrite(newK, content);
      if (__vfsBundle) delete __vfsBundle[oldK];
      delete __vfsBundleRevisions[oldK];
      delete __vfsWrites[oldK];
      _forgetSyncPath(oldK);
    } else if (__vfsDirs && oldK in __vfsDirs) {
      // A directory this process made travels under its new name, so the
      // sync view stops listing the old one and _announceLocalDirs cannot
      // re-create it at the authority behind the rename.
      const prefix = oldK + "/";
      for (const dk of Object.keys(__vfsDirs)) {
        if (dk !== oldK && !dk.startsWith(prefix)) continue;
        const moved = newK + dk.slice(oldK.length);
        __vfsDirs[moved] = true;
        delete __vfsDirs[dk];
        if (_announcedDirs.has(dk)) _announcedDirs.add(moved);
      }
      _forgetSyncTree(oldK);
    }
    // Writes parked beneath a moved directory are written back under the
    // names they were written under, registered now so the move's wait for
    // its subtree orders them ahead of it: the authority then moves them with
    // the directory, or leaves them where they were if it refuses the move.
    // Left parked under the old names, they reached the authority behind the
    // move and were refused ENOENT (Vite's optimizer writes deps_temp_<hash>/
    // and renames it to deps/). Sent under the new names, they would be
    // written into the destination even when the move was refused, and an
    // append's cell (only the appended bytes) would replace the file it
    // extends.
    //
    // The sync view shows a whole file under its new name at once: the cell
    // moves there, and its write-back is that old-name write followed by the
    // move, never a write of its own. An append's cell cannot stand for the
    // file, and its new name reads from the authority once the move lands.
    // With no authority the process's own tables are the filesystem, and the
    // cells move with the name.
    const supervisor = _supervisor();
    const movedWrites = [];
    for (const k of Object.keys(__vfsWrites)) {
      if (!k.startsWith(oldPrefix)) continue;
      const moved = newK + k.slice(oldK.length);
      const content = __vfsWrites[k];
      const writtenAt = _ownWriteTimes[k];
      const append = !!supervisor && __nimbusCapturePendingVfsAppend(k) !== null;
      const landed = supervisor ? _flushParkedWrite("/" + k, supervisor) : null;
      if (__vfsBundle) delete __vfsBundle[k];
      delete __vfsWrites[k];
      _forgetSyncPath(k);
      if (append) {
        _detachStructuralMutation(landed);
        continue;
      }
      _parkWrite(moved, content);
      if (writtenAt !== undefined) _ownWriteTimes[moved] = writtenAt;
      if (landed) movedWrites.push([moved, landed, __vfsWriteGenerations[moved]]);
    }
    _forgetCreation(oldK);
    _forgetCreation(newK);
    for (const key of createdMoved) _createdHere.add(key);
    for (const [ok, entry] of [..._nsOwn]) {
      if ((ok === oldK || ok.startsWith(oldPrefix)) && entry.state === "dir") {
        _nsOwnSet(newK + ok.slice(oldK.length), "dir", { hide: entry.hide });
      }
    }
    if ((nsFrom !== null || movedLink !== undefined) && !_nsOwn.has(newK)) _nsOwnSet(newK, "alias", { from: nsFrom ?? undefined, link: movedLink });
    _nsOwnSet(oldK, "absentTree");
    const queued = _queueStructuralMutation(
      oldAbs, "rename", oldP,
      (supervisor) => supervisor.rename(oldAbs, newAbs),
      // The queue orders the move behind the source's ancestors; the move
      // also needs the destination's ancestors to exist and every pending
      // mutation beneath the source to have landed under the old name.
      () => Promise.all([__nimbusAwaitAncestorMutations(newAbs), __nimbusAwaitSubtreeMutations(oldAbs)]),
      undefined,
      newP,
    );
    _fenceVfsMutation(newAbs, queued);
    // A move the authority refuses was the program's error to see, and the
    // cell then stands for nothing at the new name: its bytes leave the sync
    // view there (unless a later write replaced them) and it retires without
    // a write. A failed write under the old name is the cell's own failure.
    for (const [moved, landed, generation] of movedWrites) {
      const refused = () => {
        // By the parked generation, not the bytes: a resident store holds a
        // copy of them, and a later write to the name is its own.
        if (__vfsWriteGenerations[moved] === generation) {
          if (__vfsBundle) delete __vfsBundle[moved];
          globalThis.__nimbusVfsWriteRefused("/" + moved);
        }
        return undefined;
      };
      _detachStructuralMutation(__nimbusFlushVfsWrite(
        "/" + moved,
        () => landed.then((revision) => queued.then(() => revision, refused)),
        false,
      ));
    }
    return queued;
  }
  function renameSync(oldP, newP) { _detachStructuralMutation(_renameQueued(oldP, newP)); }

  // ── copyFileSync ──
  // Bytes, not utf8: a utf8 round trip replaces every byte ≥ 0x80 with
  // U+FFFD, which is how a copied .png or .woff2 arrived corrupted.
  function copyFileSync(src, dest, mode) {
    if ((Number(mode) & __fsConstants.COPYFILE_EXCL) !== 0 && existsSync(dest)) {
      throw _fsErr("EEXIST", "copyfile", src, dest);
    }
    try { writeFileSync(dest, readFileSync(src)); }
    catch (error) { throw _asCallError(error, "copyfile", src, dest); }
  }

  /**
   * A failure of one part of a call Node makes as one syscall (copyFile is
   * a read then a write here), as that call's: its code, the call's syscall
   * and both its paths. What the part said beyond Node's own words is kept.
   */
  function _asCallError(error, syscall, p, dest) {
    const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined;
    if (code === undefined || !Number.isInteger(Number(__constantsMod[code]))) return error;
    const mapped = _fsErr(code, syscall, p, dest);
    if (error.message !== _fsErr(code, error.syscall, error.path, error.dest).message) mapped.message += " — " + error.message;
    return mapped;
  }

  // ── rmSync / rm ──
  // The local tables are edited at once (the same retraction unlinkSync and
  // rmdirSync perform, over the whole subtree when recursive) and ONE
  // authority RPC — fsRemove, which the bridge serves as unlink or a bounded
  // recursive removal — is queued behind every pending mutation beneath the
  // path. ENOENT under `force` is the authority's to swallow; locally an
  // unknown path may still exist live, so it is asked rather than answered.
  function _rmQueued(p, opts, sync) {
    const o = opts || {};
    const absPath = _resolve(p);
    const k = _strip(absPath);
    let st;
    try { st = statSync(p, { throwIfNoEntry: false }); }
    catch (error) {
      // A mounted path the launch did not list: the async form asks the authority.
      if (sync || error?.code !== "EAGAIN") throw error;
    }
    const supervisor = _supervisor();
    const canRemove = !!supervisor && typeof supervisor.fsRemove === "function";
    if (st === undefined) {
      if (!canRemove) {
        if (o.force) return null;
        throw _fsErr("ENOENT", "rm", p);
      }
      // A path the sync view cannot map may still exist live (born after
      // boot). The async form asks the authority, whose ENOENT is the real
      // one; the sync form has no frame to receive that answer, so it gives
      // statSync's own provisional not-found unless `force` makes the
      // verdict irrelevant.
      if (sync && !o.force) throw _fsErr("ENOENT", "rm", p);
    }
    if (st !== undefined && st.isDirectory() && !o.recursive) {
      throw _fsErr("ERR_FS_EISDIR", "rm", p);
    }
    const prefix = k + "/";
    // A parked write is content the authority may never have seen: the
    // caller's file demonstrably existed here, so the removal succeeds, and
    // the authority is told "if present" rather than made to fail on a file
    // that was only ever local.
    let parked = false;
    if (__vfsBundle) {
      if (k in __vfsBundle) delete __vfsBundle[k];
      if (o.recursive) for (const bk of __residentUnder(prefix)) delete __vfsBundle[bk];
    }
    delete __vfsBundleRevisions[k];
    if (__vfsWrites) {
      for (const wk of Object.keys(__vfsWrites)) {
        if (wk === k || (o.recursive && wk.startsWith(prefix))) { delete __vfsWrites[wk]; parked = true; }
      }
    }
    if (__vfsDirs) {
      for (const dk of Object.keys(__vfsDirs)) {
        if (dk === k || (o.recursive && dk.startsWith(prefix))) delete __vfsDirs[dk];
      }
    }
    if (o.recursive) _forgetSyncTree(k); else _forgetSyncPath(k);
    if (!canRemove) {
      // No fsRemove: a plain file still has the unlink RPC.
      if (st !== undefined && !st.isDirectory()) {
        return _queueStructuralMutation(absPath, "rm", p, (s) => s.unlink(absPath), undefined, "unlink");
      }
      return null;
    }
    return _queueStructuralMutation(
      absPath, "rm", p,
      (s) => s.fsRemove(absPath, { recursive: !!o.recursive, force: !!o.force || parked }),
      () => __nimbusAwaitSubtreeMutations(absPath),
      "fsRemove",
    );
  }
  function rmSync(p, opts) { _detachStructuralMutation(_rmQueued(p, opts, true)); }
  async function _rmAsync(p, opts) { await _rmQueued(p, opts, false); }

  // ── cpSync ──
  // A walk of the resident view; every file copy is a parked sync write that
  // the existing write-back drains, and every directory a queued mkdir.
  function cpSync(src, dest, opts) {
    const o = opts || {};
    const st = statSync(src, { throwIfNoEntry: false });
    if (st === undefined) throw _fsErr("ENOENT", "cp", src);
    if (typeof o.filter === "function" && !o.filter(String(src), String(dest))) return;
    if (!st.isDirectory()) {
      const destSt = statSync(dest, { throwIfNoEntry: false });
      if (destSt !== undefined) {
        if (destSt.isDirectory()) throw _fsErr("EISDIR", "cp", dest);
        if (o.errorOnExist) throw _fsErr("ERR_FS_CP_EEXIST", "cp", dest);
        if (o.force === false) return;
      }
      copyFileSync(src, dest);
      return;
    }
    if (!o.recursive) throw _fsErr("ERR_FS_EISDIR", "cp", src);
    mkdirSync(dest, { recursive: true });
    for (const ent of readdirSync(src, { withFileTypes: true })) {
      cpSync(__pathMod.join(String(src), ent.name), __pathMod.join(String(dest), ent.name), o);
    }
  }

  // ── mkdtemp ──
  // Node appends six characters from [a-zA-Z0-9]; a collision with a name
  // the sync view already knows is retried rather than reused.
  const _MKDTEMP_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  function _mkdtempName(prefix) {
    for (let attempt = 0; attempt < 64; attempt++) {
      let suffix = "";
      for (let i = 0; i < 6; i++) suffix += _MKDTEMP_ALPHABET[Math.floor(Math.random() * _MKDTEMP_ALPHABET.length)];
      const name = String(prefix) + suffix;
      if (!existsSync(name)) return name;
    }
    throw _fsErr("EEXIST", "mkdtemp", String(prefix) + "XXXXXX");
  }
  function mkdtempSync(prefix) {
    const name = _mkdtempName(prefix);
    mkdirSync(name);
    return name;
  }
  async function _mkdtempAsync(prefix) {
    const name = _mkdtempName(prefix);
    await _mkdirAsync(name);
    return name;
  }

  // ── truncateSync ──
  // The resident-view rule of ftruncateSync applied to a path: trim the
  // resident cell and park it, refuse EAGAIN when the bytes are not here.
  function truncateSync(p, len) {
    const absPath = _resolveFollow(p, "open");
    const st = statSync(p, { throwIfNoEntry: false });
    if (st === undefined) throw _fsErr("ENOENT", "truncate", p);
    if (st.isDirectory()) throw _fsErr("EISDIR", "truncate", p);
    const size = Math.max(0, Math.trunc(Number(len) || 0));
    _ensureWritable(absPath, "truncate", p);
    const base = _residentWriteBase(absPath, p, "truncate");
    const next = new Uint8Array(size);
    next.set(base.subarray(0, Math.min(size, base.byteLength)), 0);
    _parkWrite(_strip(absPath), next);
    _markVfsStale();
  }

  // ── link / linkSync ──
  // The VFS has no hard links and a copy would lie about sharing an inode,
  // so both forms answer ENOSYS like fs.promises.link always has.
  function linkSync(existingPath, newPath) { throw _fsErr("ENOSYS", "link", existingPath, newPath); }

  // ── realpathSync (X.5-T per X5Z5-plan §4.3 + X526b-retro §3.1) ──
  // Sync realpath stays local and identity-resolves. Async symlink
  // operations use the live supervisor bridge below.
  // .native static is required by TypeScript's getNodeSystem at
  function realpathSync(p, opts) {
    const absPath = _resolve(String(p));
    _nsRequire("realpath", p, "fs.promises.realpath");
    const k = _strip(absPath);
    const meta = _nsMeta(k, true);
    if (meta === "ELOOP") throw _fsErr("ELOOP", "realpath", p);
    if (meta === "absent") throw _absentErr(absPath, "realpath", p, "fs.promises.realpath");
    const real = _nsHeldKey(k);
    return real === null || real === k ? absPath : "/" + real;
  }
  realpathSync.native = realpathSync;

  // ── Async variants (thin wrappers returning via callback) ──
  function readFile(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _readFileAsync(p, opts).then((r) => { if (cb) cb(null, r); }).catch((e) => { if (cb) cb(e); });
  }
  function writeFile(p, d, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _writeFileAsync(p, d, opts).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); });
  }
  function appendFile(p, d, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _appendFileAsync(p, d, opts).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); });
  }
  function stat(p, cb) { _statAsync(p).then((s) => cb(null, s)).catch((e) => cb(e)); }
  function lstat(p, cb) { _lstatAsync(p).then((s) => cb(null, s)).catch((e) => cb(e)); }
  function readdir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _readdirAsync(p, opts).then((d) => cb(null, d)).catch((e) => cb(e));
  }
  function exists(p, cb) { _existsAsync(p).then((ok) => cb(ok)).catch(() => cb(false)); }
  function mkdir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _mkdirAsync(p, opts).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); });
  }
  function unlink(p, cb) { _unlinkAsync(p).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  // The callback form proper-lockfile (via graceful-fs) releases its lock directory with.
  function rmdir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _rmdirAsync(p).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); });
  }
  function rename(oldP, newP, cb) { _renameAsync(oldP, newP).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function utimes(p, atime, mtime, cb) { _utimesAsync(p, atime, mtime).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function lutimes(p, atime, mtime, cb) { _utimesAsync(p, atime, mtime, { followSymlinks: false }).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function chmod(p, mode, cb) { _chmodAsync(p, mode).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function chown(p, uid, gid, cb) { _chownAsync(p, uid, gid).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function lchown(p, uid, gid, cb) { _chownAsync(p, uid, gid, { followSymlinks: false }).then(() => { if (cb) cb(null); }).catch((e) => { if (cb) cb(e); }); }
  function access(p, mode, cb) {
    if (typeof mode === "function") { cb = mode; mode = undefined; }
    _accessAsync(p, mode).then(() => cb(null)).catch((e) => cb(e));
  }

  // ── open-flag parsing for fs.promises.open ──
  function _parseOpenFlags(flags) {
    if (typeof flags === "number") {
      const { O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_DIRECTORY } = __fsConstants;
      return {
        read: (flags & O_WRONLY) === 0,
        write: (flags & (O_WRONLY | O_RDWR)) !== 0,
        append: (flags & O_APPEND) !== 0,
        create: (flags & O_CREAT) !== 0,
        truncate: (flags & O_TRUNC) !== 0,
        exclusive: (flags & O_EXCL) !== 0,
        directory: (flags & O_DIRECTORY) !== 0,
      };
    }
    const s = String(flags === undefined || flags === null ? "r" : flags);
    const plus = s.indexOf("+") !== -1;
    const exclusive = s.indexOf("x") !== -1;
    const base = s.charAt(0);
    if (base === "w") return { read: plus, write: true, append: false, create: true, truncate: true, exclusive, directory: false };
    if (base === "a") return { read: plus, write: true, append: true, create: true, truncate: false, exclusive, directory: false };
    return { read: true, write: plus, append: false, create: false, truncate: false, exclusive, directory: false };
  }

  // ── FileHandle — returned from fs.promises.open ──
  // Stateless-live design: the handle owns path/flags/position FACET-side
  // and issues ranged supervisor RPCs (fsReadRange/fsWriteRange/fsTruncate),
  // so there is no server-side fd state to lose across supervisor
  // hibernation and partial reads/writes never move whole files. Unflushed
  // sync writes (__vfsWrites) take read precedence; the local sync view is
  // overlaid on writes so readFileSync stays coherent.
  // The prior content a sync positional write or truncate lays its bytes
  // over. Shared by the descriptor forms and truncateSync.
  function _residentWriteBase(absPath, p, syscall) {
    const cell = _writtenCell(absPath);
    if (cell !== undefined) {
      const denial = _denialCode(cell);
      if (denial) throw _fsErr(denial, syscall, p);
      _residencySatisfied(absPath);
      return _asBytes(cell);
    }
    const asyncForm = "the async fs." + syscall + "/fs.promises form";
    const st = statSync(p, { throwIfNoEntry: false });
    // Non-resident and non-empty: writing onto a zero-filled base would
    // silently destroy the bytes we cannot see. Refuse instead.
    if (st !== undefined && st.size !== 0) throw _notResidentError(absPath, p, syscall, asyncForm);
    // Absent or empty: an empty base is the true prior content (the namespace
    // names every path this credential can see).
    return new Uint8Array(0);
  }

  async function _fsyncAsync(absPath, p) {
    const supervisor = _supervisor();
    if (supervisor) {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      await _awaitStructuralOrder(absPath);
    }
    _markVfsStale();
  }

  let __nextFileHandleFd = 3;
  const __fileHandles = new Map();
  class __FileHandle {
    constructor(path, flagInfo, size) {
      this._path = path;
      this._abs = _resolveFollow(path, "open");
      this._flags = flagInfo;
      this._position = 0;
      this._size = size;
      this._closed = false;
      this.fd = __nextFileHandleFd++;
      __fileHandles.set(this.fd, this);
    }
    _assertOpen(syscall) {
      if (this._closed) throw _fsErr("EBADF", syscall, this._path);
    }
    async read(buffer, offset, length, position) {
      this._assertOpen("read");
      if (!this._flags.read) throw _fsErr("EBADF", "read", this._path);
      if (buffer && !(buffer instanceof Uint8Array)) {
        // options-object form: read({ buffer, offset, length, position })
        const o = buffer;
        buffer = o.buffer; offset = o.offset; length = o.length; position = o.position;
      }
      if (!buffer) buffer = __BufferMod.alloc(16384);
      const off = offset || 0;
      const want = (length === undefined || length === null) ? buffer.length - off : Math.max(0, Number(length));
      const pos = (position === undefined || position === null) ? this._position : Math.max(0, Number(position));
      const slice = await _readRangeAt(this._abs, this._path, pos, want) || new Uint8Array(0);
      buffer.set(slice, off);
      if (position === undefined || position === null) this._position = pos + slice.length;
      return { bytesRead: slice.length, buffer };
    }
    async write(buffer, offset, length, position) {
      this._assertOpen("write");
      if (!this._flags.write) throw _fsErr("EBADF", "write", this._path);
      let bytes;
      let pos;
      if (typeof buffer === "string") {
        // write(string[, position[, encoding]])
        bytes = _enc.encode(buffer);
        pos = (offset === undefined || offset === null) ? null : Math.max(0, Number(offset));
      } else {
        const o = offset || 0;
        const l = (length === undefined || length === null) ? buffer.length - o : Number(length);
        bytes = buffer.subarray(o, o + l);
        pos = (position === undefined || position === null) ? null : Math.max(0, Number(position));
      }
      const at = this._flags.append ? this._size : (pos === null ? this._position : pos);
      if (bytes.byteLength === 0) {
        return { bytesWritten: 0, buffer };
      }
      let writeAt = at;
      const supervisor = _supervisor();
      if (supervisor && typeof supervisor.fsWriteRange === "function") {
        const pendingSnapshot = __nimbusCaptureVfsWrite(this._abs);
        const overlayGeneration = pendingSnapshot
          ? pendingSnapshot.generation + 1
          : __vfsWriteGenerations[_strip(this._abs)];
        const flush = __nimbusFlushVfsWrite(
          this._abs,
          (content, snapshot) =>
            __nimbusPersistVfsWrite(supervisor, this._abs, content, snapshot),
        );
        await __nimbusQueueVfsMutation(this._abs, async () => {
          await flush;
          if (this._flags.append && typeof supervisor.stat === "function") {
            const meta = await _fsRpc(
              supervisor.stat(this._abs),
              "stat", this._path,
              (result) => result,
            );
            if (meta && meta.type === "file") writeAt = Number(meta.size) || 0;
          }
          await _ownMutation(
            this._abs,
            () => _fsRpc(
              supervisor.fsWriteRange(this._abs, writeAt, bytes),
              "write", this._path,
              (result) => result,
            ),
            () => {
              const key = _strip(this._abs);
              if (!Object.prototype.hasOwnProperty.call(__vfsWrites, key) &&
                  __vfsWriteGenerations[key] === overlayGeneration) {
                _overlayLocalCell(this._abs, writeAt, bytes);
              }
            },
          );
        });
        _markVfsStale();
      } else {
        const cell = _writtenCell(this._abs);
        this._commit(_spliceCell(cell === undefined ? new Uint8Array(0) : _asBytes(cell), at, bytes));
      }
      this._size = Math.max(this._size, writeAt + bytes.byteLength);
      if (pos === null || this._flags.append) this._position = writeAt + bytes.byteLength;
      return { bytesWritten: bytes.byteLength, buffer };
    }
    async readFile(opts) { return _readFileAsync(this._path, opts); }
    async writeFile(data, opts) {
      await _writeFileAsync(this._path, data, opts);
      this._size = _byteLen(typeof data === "string" || data instanceof Uint8Array ? data : String(data));
    }
    async appendFile(data, opts) {
      await _appendFileAsync(this._path, data, opts);
      this._size += _byteLen(typeof data === "string" || data instanceof Uint8Array ? data : String(data));
    }
    async stat() { return _statAsync(this._path); }
    async truncate(len) {
      this._assertOpen("ftruncate");
      if (!this._flags.write) throw _fsErr("EBADF", "ftruncate", this._path);
      const size = Math.max(0, Math.trunc(Number(len) || 0));
      await _truncateAsync(this._path, size);
      this._size = size;
    }
    // ── Synchronous descriptor I/O ──
    // A node facet has NO synchronous I/O primitive (no JSPI suspension, as
    // the WASI runtimes have), so sync fd ops are served from exactly the
    // resident view readFileSync/writeFileSync use — __vfsWrites overlaid on
    // __vfsBundle. Content that is not resident cannot be fetched without
    // blocking, so those calls raise EAGAIN rather than invent bytes.
    // Writes buffer into __vfsWrites and are drained by the existing
    // write-back path (_flushLocalPathToSupervisor), identical to
    // writeFileSync; closeSync/fsyncSync therefore cannot block on
    // durability and only mark the VFS stale.
    _residentBytes(syscall) {
      const cell = _writtenCell(this._abs);
      if (cell === undefined) return undefined;
      const denial = _denialCode(cell);
      if (denial) throw _fsErr(denial, syscall, this._path);
      _residencySatisfied(this._abs);
      return _asBytes(cell);
    }
    _notResident(syscall) {
      return _notResidentError(
        this._abs, this._path, syscall, "the async fs." + syscall + "/fs.promises form",
      );
    }
    _readBase(syscall) {
      const bytes = this._residentBytes(syscall);
      if (bytes === undefined) throw this._notResident(syscall);
      return bytes;
    }
    _writeBase(syscall) { return _residentWriteBase(this._abs, this._path, syscall); }
    _commit(next) {
      _parkWrite(_strip(this._abs), next);
      _markVfsStale();
      this._size = next.byteLength;
    }
    _readSync(buffer, offset, length, position) {
      this._assertOpen("read");
      if (!this._flags.read) throw _fsErr("EBADF", "read", this._path);
      const off = offset === undefined || offset === null ? 0 : Number(offset);
      const want = length === undefined || length === null
        ? buffer.length - off
        : Math.max(0, Number(length));
      const useCurrent = _isCurrentPos(position);
      const pos = useCurrent ? this._position : Number(position);
      const buf = this._readBase("read");
      const from = Math.min(pos, buf.byteLength);
      const slice = buf.subarray(from, Math.min(buf.byteLength, from + want));
      buffer.set(slice, off);
      if (useCurrent) this._position = pos + slice.byteLength;
      return slice.byteLength;
    }
    _writeSync(data, a, b, c) {
      this._assertOpen("write");
      if (!this._flags.write) throw _fsErr("EBADF", "write", this._path);
      const norm = _normWriteArgs(data, a, b, c);
      const bytes = norm.bytes;
      const pos = _isCurrentPos(norm.pos) ? null : Number(norm.pos);
      _ensureWritable(this._abs, "write", this._path);
      const base = this._writeBase("write");
      const at = this._flags.append
        ? base.byteLength
        : (pos === null ? this._position : pos);
      this._commit(_spliceCell(base, at, bytes));
      if (pos === null || this._flags.append) this._position = at + bytes.byteLength;
      return bytes.byteLength;
    }
    _truncateSync(len) {
      this._assertOpen("ftruncate");
      if (!this._flags.write) throw _fsErr("EBADF", "ftruncate", this._path);
      const size = Math.max(0, Math.trunc(Number(len) || 0));
      _ensureWritable(this._abs, "ftruncate", this._path);
      const base = this._writeBase("ftruncate");
      const next = new Uint8Array(size);
      next.set(base.subarray(0, Math.min(size, base.byteLength)), 0);
      this._commit(next);
      if (this._position > size) this._position = size;
    }
    async chmod(mode) { this._assertOpen("fchmod"); await _chmodAsync(this._path, mode); }
    async chown(uid, gid) { this._assertOpen("fchown"); await _chownAsync(this._path, uid, gid, undefined, "fchown"); }
    async utimes(atime, mtime) { this._assertOpen("futimes"); await _utimesAsync(this._path, atime, mtime, undefined, "futimes"); }
    // Durability here means: every byte parked for this path has reached
    // the authority and every mutation queued for it has landed. The bridge
    // itself is synchronously durable, so no further RPC is owed.
    async sync() { this._assertOpen("fsync"); await _fsyncAsync(this._abs, this._path); }
    async datasync() { this._assertOpen("fdatasync"); await _fsyncAsync(this._abs, this._path); }
    // Scatter/gather over the ranged read/write: one sequential pass per
    // buffer, stopping at the first short read, positions advanced by hand
    // when an explicit one was given so the file position stays untouched.
    async readv(buffers, position) {
      this._assertOpen("read");
      let bytesRead = 0;
      let pos = _isCurrentPos(position) ? null : Number(position);
      for (const buffer of buffers) {
        const r = await this.read(buffer, 0, buffer.byteLength, pos);
        bytesRead += r.bytesRead;
        if (pos !== null) pos += r.bytesRead;
        if (r.bytesRead < buffer.byteLength) break;
      }
      return { bytesRead, buffers };
    }
    async writev(buffers, position) {
      this._assertOpen("write");
      let bytesWritten = 0;
      let pos = _isCurrentPos(position) ? null : Number(position);
      for (const buffer of buffers) {
        const r = await this.write(buffer, 0, buffer.byteLength, pos);
        bytesWritten += r.bytesWritten;
        if (pos !== null) pos += r.bytesWritten;
      }
      return { bytesWritten, buffers };
    }
    async close() { this._assertOpen("close"); this._closed = true; __fileHandles.delete(this.fd); }
    [Symbol.asyncDispose]() { return this.close(); }
  }

  async function _openAsync(path, flags, mode) {
    const fl = _parseOpenFlags(flags);
    const absPath = _resolveFollow(path, "open");
    const supervisor = _supervisor();
    let liveMeta = null;
    if (supervisor && typeof supervisor.stat === "function") {
      await _flushLocalPathToSupervisor(absPath, supervisor);
      liveMeta = await _fsRpc(supervisor.stat(absPath), "stat", path, (result) => result);
    }
    if (liveMeta && liveMeta.type === "directory") throw _fsErr("EISDIR", "open", path);
    let localStat = null;
    if (!liveMeta) {
      try { localStat = statSync(path); } catch {}
      if (localStat && localStat.isDirectory()) throw _fsErr("EISDIR", "open", path);
    }
    const exists = !!liveMeta || !!localStat;
    if (exists && fl.directory) throw _fsErr("ENOTDIR", "open", path);
    if (!exists && !fl.create) throw _fsErr("ENOENT", "open", path);
    if (exists && fl.create && fl.exclusive) throw _fsErr("EEXIST", "open", path);
    let size = liveMeta ? (Number(liveMeta.size) || 0) : (localStat ? localStat.size : 0);
    // The authority answered, so what it said is what the sync view keeps:
    // its stat when something is there, and when nothing is, the file this
    // open creates is the process's own.
    if (!liveMeta && supervisor && !localStat) _createdHere.add(_strip(absPath));
    if (!exists) {
      await _writeFileAsync(path, new Uint8Array(0));
      if (mode !== undefined && mode !== null) {
        await _chmodAsync(path, Number(mode) & ~__processUmask);
      }
      size = 0;
    } else if (fl.truncate) {
      await _truncateAsync(path, 0);
      size = 0;
    }
    return new __FileHandle(path, fl, size);
  }

  function openSync(path, flags, mode) {
    const fl = _parseOpenFlags(flags);
    const absPath = _resolveFollow(path, "open");
    _ensureAncestorsTraversable(absPath, "open", path);
    const st = statSync(path, { throwIfNoEntry: false });
    if (st && st.isDirectory()) throw _fsErr("EISDIR", "open", path);
    const exists = st !== undefined;
    if (exists && fl.directory) throw _fsErr("ENOTDIR", "open", path);
    if (!exists && !fl.create) throw _fsErr("ENOENT", "open", path);
    // O_EXCL does not follow a final symlink: a dangling link is there.
    if (fl.create && fl.exclusive && (exists || lstatSync(path, { throwIfNoEntry: false }) !== undefined)) throw _fsErr("EEXIST", "open", path);
    if (fl.write || !exists) _ensureWritable(absPath, "open", path);
    if (!exists) _noteCreation(_strip(absPath));
    let size = exists ? st.size : 0;
    // O_TRUNC means "make it empty", so zeroing is the requested semantic,
    // and creating a genuinely absent file is too. O_APPEND must NEVER
    // pre-create: "exists" is only as good as the sync view, so a file
    // created after this facet booted looks absent, and zeroing it at open
    // time would destroy exactly the content the caller asked to preserve.
    if (fl.truncate || (!exists && !fl.append)) {
      // Creating or truncating also makes the file resident, which is what
      // lets the sync read/write path serve it without blocking.
      writeFileSync(path, new Uint8Array(0));
      if (!exists && mode !== undefined && mode !== null) {
        chmodSync(path, Number(mode) & ~__processUmask);
      }
      size = 0;
    }
    return new __FileHandle(path, fl, size).fd;
  }

  // ── fd table ──
  // fds 0/1/2 are the process stdio triple and deliberately live OUTSIDE
  // __fileHandles (which allocates from 3 up), so fs.writeSync(1, ...) —
  // how a lot of bundled CLI output actually reaches the terminal — lands
  // on the real process streams instead of failing EBADF.
  function _fdHandle(fd, syscall) {
    const handle = __fileHandles.get(Number(fd));
    if (!handle || handle._closed) throw _fsErr("EBADF", syscall, fd);
    return handle;
  }
  // Resolve an fd for a callback-style syscall, delivering EBADF via cb.
  function _fdFor(fd, syscall, cb) {
    try { return _fdHandle(fd, syscall); }
    catch (e) { queueMicrotask(() => cb(e)); return null; }
  }
  function _isStdioFd(fd) { const n = Number(fd); return n === 0 || n === 1 || n === 2; }
  // stdio descriptors are character devices, not VFS files.
  function _stdioStat() {
    const now = new Date();
    return {
      isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false,
      isBlockDevice: () => false, isCharacterDevice: () => true,
      isFIFO: () => false, isSocket: () => false,
      size: 0, mode: 0o020620, uid: Number(cred.uid), gid: Number(cred.gid),
      atime: now, mtime: now, ctime: now, birthtime: now,
    };
  }
  // Node treats a null position — and a negative one, which libuv maps to
  // the same thing — as "use and advance the file position".
  function _isCurrentPos(p) {
    return p === undefined || p === null || Number(p) < 0;
  }
  // Normalizes every documented fs.write/writeSync argument shape:
  //   (fd, buffer[, offset[, length[, position]]])
  //   (fd, buffer[, options])   where options = { offset, length, position }
  //   (fd, string[, position[, encoding]])
  function _normWriteArgs(data, a, b, c) {
    if (typeof data === "string") {
      return {
        bytes: _asBytes(__BufferMod.from(data, typeof b === "string" ? b : "utf8")),
        pos: a,
      };
    }
    let off = a, len = b, pos = c;
    if (a !== null && typeof a === "object" && !(a instanceof Uint8Array)) {
      off = a.offset; len = a.length; pos = a.position;
    }
    off = off === undefined || off === null ? 0 : Number(off);
    len = len === undefined || len === null ? data.length - off : Number(len);
    return { bytes: _asBytes(data).subarray(off, off + len), pos };
  }

  function closeSync(fd) {
    if (_isStdioFd(fd)) return;
    const handle = _fdHandle(fd, "close");
    handle._closed = true;
    __fileHandles.delete(handle.fd);
  }

  function readSync(fd, buffer, offsetOrOptions, length, position) {
    let offset = offsetOrOptions;
    if (offsetOrOptions !== null && typeof offsetOrOptions === "object") {
      offset = offsetOrOptions.offset;
      length = offsetOrOptions.length;
      position = offsetOrOptions.position;
    }
    // fd 0 reads the launch's stdin (__nimbusReadStdinInto). stdout and
    // stderr read nothing.
    if (Number(fd) === 0) return __nimbusReadStdinInto(buffer, offset, length, "read");
    if (_isStdioFd(fd)) return 0;
    return _fdHandle(fd, "read")._readSync(buffer, offset, length, position);
  }

  function writeSync(fd, data, a, b, c) {
    const n = Number(fd);
    if (n === 1 || n === 2) {
      const bytes = _normWriteArgs(data, a, b, c).bytes;
      (n === 2 ? __processMod.stderr : __processMod.stdout).write(bytes);
      return bytes.byteLength;
    }
    if (n === 0) throw _fsErr("EBADF", "write", fd);
    return _fdHandle(fd, "write")._writeSync(data, a, b, c);
  }

  function fstatSync(fd, opts) {
    if (_isStdioFd(fd)) return _stdioStat();
    return statSync(_fdHandle(fd, "fstat")._path, opts);
  }

  function ftruncateSync(fd, len) {
    if (_isStdioFd(fd)) throw _fsErr("EINVAL", "ftruncate", fd);
    _fdHandle(fd, "ftruncate")._truncateSync(len);
  }

  // Sync writes buffer into __vfsWrites and are drained by the existing
  // VFS write-back path — a facet cannot block on durability, so these
  // validate the fd and mark the VFS stale rather than pretending to sync.
  function fsyncSync(fd) { if (!_isStdioFd(fd)) _fdHandle(fd, "fsync"); _markVfsStale(); }
  function fdatasyncSync(fd) { if (!_isStdioFd(fd)) _fdHandle(fd, "fdatasync"); _markVfsStale(); }

  // Descriptor metadata, sync: the path forms on the handle's path, so the
  // local overlay (times, modes, ownership) and the parked write-through are
  // exactly what utimesSync/chmodSync/chownSync give.
  function futimesSync(fd, atime, mtime) {
    if (_isStdioFd(fd)) throw _fsErr("EINVAL", "futimes", fd);
    const handle = _fdHandle(fd, "futimes");
    _recordLocalTimes(handle._abs, atime, mtime, "futimes", handle._path);
  }
  function fchmodSync(fd, mode) {
    if (_isStdioFd(fd)) throw _fsErr("EINVAL", "fchmod", fd);
    const handle = _fdHandle(fd, "fchmod");
    const k = _strip(handle._abs);
    _ensureModeOwner(handle._abs, "fchmod", handle._path);
    _localModes[k] = _coerceMode(mode, "fchmod", handle._path);
    _pendingModes.add(k);
  }
  function fchownSync(fd, uid, gid) {
    if (_isStdioFd(fd)) throw _fsErr("EINVAL", "fchown", fd);
    const handle = _fdHandle(fd, "fchown");
    _detachStructuralMutation(_chownQueued(handle._path, uid, gid, undefined, "fchown"));
  }

  // Scatter/gather, sync: readSync/writeSync per buffer; stdio fds keep the
  // stream behaviour those two already give them.
  function readvSync(fd, buffers, position) {
    let bytesRead = 0;
    let pos = _isCurrentPos(position) ? null : Number(position);
    for (const buffer of buffers) {
      const n = readSync(fd, buffer, 0, buffer.byteLength, pos);
      bytesRead += n;
      if (pos !== null) pos += n;
      if (n < buffer.byteLength) break;
    }
    return bytesRead;
  }
  function writevSync(fd, buffers, position) {
    let bytesWritten = 0;
    let pos = _isCurrentPos(position) ? null : Number(position);
    for (const buffer of buffers) {
      const n = writeSync(fd, buffer, 0, buffer.byteLength, pos);
      bytesWritten += n;
      if (pos !== null) pos += n;
    }
    return bytesWritten;
  }

  // ── callback forms (live I/O — these CAN reach the supervisor) ──
  function open(path, flags, mode, cb) {
    if (typeof flags === "function") { cb = flags; flags = undefined; mode = undefined; }
    else if (typeof mode === "function") { cb = mode; mode = undefined; }
    _openAsync(path, flags, mode).then((h) => cb(null, h.fd)).catch((e) => cb(e));
  }
  function close(fd, cb) {
    let err = null;
    try { closeSync(fd); } catch (e) { err = e; }
    // Without a callback there is nowhere to deliver the failure, so raise
    // it here rather than let an EBADF vanish.
    if (typeof cb !== "function") { if (err) throw err; return; }
    queueMicrotask(() => cb(err));
  }
  function read(fd, buffer, offset, length, position, cb) {
    if (typeof buffer === "function") {
      // read(fd, callback)
      cb = buffer; buffer = undefined; offset = undefined; length = undefined; position = undefined;
    } else if (typeof offset === "function") {
      // read(fd, options, callback) — the buffer rides inside options
      cb = offset;
      const o = buffer !== null && typeof buffer === "object" && !(buffer instanceof Uint8Array) ? buffer : {};
      buffer = o.buffer instanceof Uint8Array ? o.buffer : undefined;
      offset = o.offset; length = o.length; position = o.position;
    } else if (typeof length === "function") {
      // read(fd, buffer, options, callback)
      cb = length;
      const o = offset !== null && typeof offset === "object" ? offset : {};
      offset = o.offset; length = o.length; position = o.position;
    } else if (typeof position === "function") {
      // read(fd, buffer, offset, length, callback)
      cb = position; position = undefined;
    }
    if (!(buffer instanceof Uint8Array)) buffer = __BufferMod.alloc(16384);
    if (Number(fd) === 0) {
      let n;
      try { n = __nimbusReadStdinInto(buffer, offset, length, "read"); }
      catch (e) { queueMicrotask(() => cb(e)); return; }
      queueMicrotask(() => cb(null, n, buffer));
      return;
    }
    if (_isStdioFd(fd)) { queueMicrotask(() => cb(null, 0, buffer)); return; }
    const handle = _fdFor(fd, "read", cb);
    if (!handle) return;
    handle.read(buffer, offset, length, position)
      .then((r) => cb(null, r.bytesRead, r.buffer))
      .catch((e) => cb(e));
  }
  function write(fd, data, a, b, c, d) {
    // write(fd, buffer[, offset[, length[, position]]], cb)
    // write(fd, string[, position[, encoding]], cb)
    let cb = d;
    if (typeof a === "function") { cb = a; a = undefined; b = undefined; c = undefined; }
    else if (typeof b === "function") { cb = b; b = undefined; c = undefined; }
    else if (typeof c === "function") { cb = c; c = undefined; }
    let norm;
    try { norm = _normWriteArgs(data, a, b, c); }
    catch (e) { queueMicrotask(() => cb(e)); return; }
    const n = Number(fd);
    if (n === 1 || n === 2) {
      (n === 2 ? __processMod.stderr : __processMod.stdout).write(_dec.decode(norm.bytes));
      queueMicrotask(() => cb(null, norm.bytes.byteLength, data));
      return;
    }
    const handle = _fdFor(fd, "write", cb);
    if (!handle) return;
    // Hand over already-decoded bytes so the async path applies the same
    // encoding rules as writeSync instead of FileHandle.write's UTF-8-only
    // string branch.
    handle.write(norm.bytes, 0, norm.bytes.byteLength, _isCurrentPos(norm.pos) ? null : Number(norm.pos))
      .then((r) => cb(null, r.bytesWritten, data))
      .catch((e) => cb(e));
  }
  function fstat(fd, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    let stats = null;
    let err = null;
    try { stats = fstatSync(fd, opts); } catch (e) { err = e; }
    queueMicrotask(() => cb(err, stats));
  }
  function ftruncate(fd, len, cb) {
    if (typeof len === "function") { cb = len; len = 0; }
    if (_isStdioFd(fd)) { queueMicrotask(() => cb(_fsErr("EINVAL", "ftruncate", fd))); return; }
    const handle = _fdFor(fd, "ftruncate", cb);
    if (!handle) return;
    handle.truncate(len).then(() => cb(null)).catch((e) => cb(e));
  }
  // The async forms CAN wait for durability: the parked bytes are flushed
  // and the path's queued mutations awaited before the callback fires.
  function _fsyncCb(fd, syscall, cb) {
    let handle = null;
    let err = null;
    try { if (!_isStdioFd(fd)) handle = _fdHandle(fd, syscall); } catch (e) { err = e; }
    // Without a callback there is nowhere to deliver the failure, so raise
    // it here rather than let an EBADF vanish.
    if (typeof cb !== "function") { if (err) throw err; _markVfsStale(); return; }
    if (err || !handle) { _markVfsStale(); queueMicrotask(() => cb(err)); return; }
    _fsyncAsync(handle._abs, handle._path).then(() => cb(null)).catch((e) => cb(e));
  }
  function fsync(fd, cb) { _fsyncCb(fd, "fsync", cb); }
  function fdatasync(fd, cb) { _fsyncCb(fd, "fdatasync", cb); }
  function futimes(fd, atime, mtime, cb) {
    if (_isStdioFd(fd)) { queueMicrotask(() => cb(_fsErr("EINVAL", "futimes", fd))); return; }
    const handle = _fdFor(fd, "futimes", cb);
    if (!handle) return;
    handle.utimes(atime, mtime).then(() => cb(null)).catch((e) => cb(e));
  }
  function readv(fd, buffers, position, cb) {
    if (typeof position === "function") { cb = position; position = null; }
    const run = async () => {
      let bytesRead = 0;
      let pos = _isCurrentPos(position) ? null : Number(position);
      for (const buffer of buffers) {
        const n = await new Promise((res, rej) =>
          read(fd, buffer, 0, buffer.byteLength, pos, (e, count) => (e ? rej(e) : res(count))));
        bytesRead += n;
        if (pos !== null) pos += n;
        if (n < buffer.byteLength) break;
      }
      return bytesRead;
    };
    run().then((n) => cb(null, n, buffers)).catch((e) => cb(e));
  }
  function writev(fd, buffers, position, cb) {
    if (typeof position === "function") { cb = position; position = null; }
    const run = async () => {
      let bytesWritten = 0;
      let pos = _isCurrentPos(position) ? null : Number(position);
      for (const buffer of buffers) {
        const n = await new Promise((res, rej) =>
          write(fd, buffer, 0, buffer.byteLength, pos, (e, count) => (e ? rej(e) : res(count))));
        bytesWritten += n;
        if (pos !== null) pos += n;
      }
      return bytesWritten;
    };
    run().then((n) => cb(null, n, buffers)).catch((e) => cb(e));
  }
  function fchmod(fd, mode, cb) {
    const handle = _fdFor(fd, "fchmod", cb);
    if (!handle) return;
    handle.chmod(mode).then(() => cb(null)).catch((e) => cb(e));
  }
  function fchown(fd, uid, gid, cb) {
    const handle = _fdFor(fd, "fchown", cb);
    if (!handle) return;
    handle.chown(uid, gid).then(() => cb(null)).catch((error) => cb(error));
  }

  // ── Dir — fs.opendir / opendirSync / fs.promises.opendir ──
  // The listing is taken whole at open (both readdir forms already return
  // one) and handed out one Dirent per read(); closing a closed Dir is
  // ERR_DIR_CLOSED as in Node.
  class __Dir {
    constructor(path, entries) {
      this.path = path;
      this._entries = entries;
      this._at = 0;
      this._closed = false;
    }
    _assertOpen() {
      if (this._closed) {
        const err = new Error("Directory handle was closed");
        err.code = "ERR_DIR_CLOSED";
        throw err;
      }
    }
    readSync() {
      this._assertOpen();
      return this._at < this._entries.length ? this._entries[this._at++] : null;
    }
    read(cb) {
      const result = new Promise((res, rej) => { try { res(this.readSync()); } catch (e) { rej(e); } });
      if (typeof cb !== "function") return result;
      result.then((entry) => cb(null, entry), (e) => cb(e));
    }
    closeSync() { this._assertOpen(); this._closed = true; }
    close(cb) {
      const result = new Promise((res, rej) => { try { this.closeSync(); res(); } catch (e) { rej(e); } });
      if (typeof cb !== "function") return result;
      result.then(() => cb(null), (e) => cb(e));
    }
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const entry = this.readSync();
          if (entry === null) break;
          yield entry;
        }
      } finally {
        if (!this._closed) this._closed = true;
      }
    }
    [Symbol.asyncDispose]() { return this._closed ? Promise.resolve() : this.close(); }
    [Symbol.dispose]() { if (!this._closed) this.closeSync(); }
  }
  function opendirSync(p, opts) {
    return new __Dir(String(p), readdirSync(p, { withFileTypes: true }));
  }
  async function _opendirAsync(p, opts) {
    return new __Dir(String(p), await _readdirAsync(p, { withFileTypes: true }));
  }
  function opendir(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _opendirAsync(p, opts).then((dir) => cb(null, dir)).catch((e) => cb(e));
  }

  // ── statfs ──
  // Honest constants for the VFS: the block size is the SQLite chunk unit's
  // page size, and blocks is the configured VFS capacity in those blocks.
  // The supervisor surface exposes no usage counter, so bfree/bavail report
  // the whole capacity; the VFS has no inode table, so files/ffree are 0
  // (unknown, not "none"). `type` is 0: this is no kernel filesystem and
  // no magic number would be true of it.
  const _STATFS_BSIZE = 4096;
  const _STATFS_BLOCKS = Math.floor(10737418240 / 4096);
  function _statfsObject(opts) {
    const wrap = opts && opts.bigint ? BigInt : Number;
    return {
      type: wrap(0),
      bsize: wrap(_STATFS_BSIZE),
      blocks: wrap(_STATFS_BLOCKS),
      bfree: wrap(_STATFS_BLOCKS),
      bavail: wrap(_STATFS_BLOCKS),
      files: wrap(0),
      ffree: wrap(0),
    };
  }
  function statfsSync(p, opts) {
    if (statSync(p, { throwIfNoEntry: false }) === undefined) throw _fsErr("ENOENT", "statfs", p);
    return _statfsObject(opts);
  }
  async function _statfsAsync(p, opts) {
    await _statAsync(p);
    return _statfsObject(opts);
  }
  function statfs(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _statfsAsync(p, opts).then((s) => cb(null, s)).catch((e) => cb(e));
  }

  // ── remaining callback forms of the path operations ──
  function rm(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _rmAsync(p, opts).then(() => cb(null)).catch((e) => cb(e));
  }
  function cp(src, dest, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    promises.cp(src, dest, opts).then(() => cb(null)).catch((e) => cb(e));
  }
  function truncate(p, len, cb) {
    if (typeof len === "function") { cb = len; len = 0; }
    _truncateAsync(p, len || 0).then(() => cb(null)).catch((e) => cb(e));
  }
  function copyFile(src, dest, mode, cb) {
    if (typeof mode === "function") { cb = mode; mode = 0; }
    promises.copyFile(src, dest, mode).then(() => cb(null)).catch((e) => cb(e));
  }
  function mkdtemp(prefix, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _mkdtempAsync(prefix).then((name) => cb(null, name)).catch((e) => cb(e));
  }
  function link(existingPath, newPath, cb) { queueMicrotask(() => cb(_fsErr("ENOSYS", "link", existingPath, newPath))); }
  function symlink(target, path, type, cb) {
    if (typeof type === "function") { cb = type; type = undefined; }
    _symlinkAsync(target, path).then(() => cb(null)).catch((e) => cb(e));
  }
  function readlink(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    _readlinkAsync(p).then((target) => cb(null, target)).catch((e) => cb(e));
  }
  function realpath(p, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = undefined; }
    promises.realpath(p, opts).then((r) => cb(null, r)).catch((e) => cb(e));
  }
  realpath.native = realpath;
  function lchmod(p, mode, cb) { chmod(p, mode, cb); }

  // ── promises namespace (W3: full surface, VFS-backed) ──
  // We can't forward to workerd's node:fs/promises because that operates
  // on a real-host filesystem, not our VFS. So every method is shim'd
  // against the same underlying readFileSync/writeFileSync/etc.
  const promises = {
    // pre-W3 surface:
    readFile: (p, o) => new Promise((res, rej) => readFile(p, o, (e, d) => e ? rej(e) : res(d))),
    writeFile: (p, d, o) => new Promise((res, rej) => writeFile(p, d, o, (e) => e ? rej(e) : res())),
    stat: (p) => new Promise((res, rej) => stat(p, (e, s) => e ? rej(e) : res(s))),
    readdir: (p, o) => new Promise((res, rej) => readdir(p, o, (e, d) => e ? rej(e) : res(d))),
    mkdir: (p, o) => new Promise((res, rej) => mkdir(p, o, (e) => e ? rej(e) : res())),
    unlink: (p) => new Promise((res, rej) => unlink(p, (e) => e ? rej(e) : res())),
    access: (p, m) => new Promise((res, rej) => access(p, m, (e) => e ? rej(e) : res())),

    // W3 additions:
    appendFile: async (p, d, o) => { await _appendFileAsync(p, d, o); },
    lstat: (p) => new Promise((res, rej) => lstat(p, (e, s) => e ? rej(e) : res(s))),
    // The same local retraction and queued authority removal rmSync does.
    rm: async (p, opts) => { await _rmAsync(p, opts); },
    cp: async (src, dest, opts) => {
      const o = opts || {};
      const srcAbs = _resolve(src);
      const srcK = _strip(srcAbs);
      const destK = _strip(_resolve(dest));
      const content = _bundleLookup(srcAbs);
      if (content !== undefined) { await _writeFileAsync(dest, content); return; }
      if (!o.recursive) {
        const err = new Error("EISDIR: cp without recursive on directory: " + src);
        err.code = "EISDIR"; throw err;
      }
      // Recursive: walk the source tree (merging the local sync view with
      // the live VFS listing so files only present in SQLite — e.g. a
      // just-extracted template tarball — are included) and persist every
      // file through the async bridge. Writing through _writeFileAsync —
      // not just the local cache — is required so a subsequent async fs op
      // (e.g. fs.promises.rename of a copied file, as create-cloudflare
      // does for __dot__gitignore) sees the copy in the VFS instead of
      // ENOENT. Each directory is made as mkdir makes it, so the namespace's
      // overlay lists it for the writes beneath it.
      await _mkdirAsync("/" + destK, { recursive: true });
      const walk = async (relDir) => {
        const absDir = relDir ? srcAbs + "/" + relDir : srcAbs;
        const ents = await _readdirAsync(absDir, { withFileTypes: true });
        for (const ent of ents) {
          const rel = relDir ? relDir + "/" + ent.name : ent.name;
          if (ent.isDirectory && ent.isDirectory()) {
            await _mkdirAsync("/" + destK + "/" + rel, { recursive: true });
            await walk(rel);
          } else {
            await _writeFileAsync("/" + destK + "/" + rel, await _readFileAsync(srcAbs + "/" + rel));
          }
        }
      };
      await walk("");
    },
    copyFile: async (src, dest, mode) => {
      if ((Number(mode) & __fsConstants.COPYFILE_EXCL) !== 0 && await _existsAsync(dest)) {
        throw _fsErr("EEXIST", "copyfile", src, dest);
      }
      try { await _writeFileAsync(dest, await _readFileAsync(src)); }
      catch (error) { throw _asCallError(error, "copyfile", src, dest); }
    },
    rename: async (oldP, newP) => { await _renameAsync(oldP, newP); },
    rmdir: async (p) => { await _rmdirAsync(p); },
    realpath: async (p) => __pathMod.resolve(String(p)),
    truncate: async (p, len) => { await _truncateAsync(p, len || 0); },
    chmod: async (p, mode) => { await _chmodAsync(p, mode); },
    chown: async (p, uid, gid) => { await _chownAsync(p, uid, gid); },
    lchmod: async (p, mode) => { await _chmodAsync(p, mode); },
    lchown: async (p, uid, gid) => { await _chownAsync(p, uid, gid, { followSymlinks: false }); },
    utimes: async (p, atime, mtime) => { await _utimesAsync(p, atime, mtime); },
    lutimes: async (p, atime, mtime) => { await _utimesAsync(p, atime, mtime, { followSymlinks: false }); },
    symlink: async (target, path) => { await _symlinkAsync(target, path); },
    link: async (existingPath, newPath) => { throw _fsErr("ENOSYS", "link", existingPath, newPath); },
    readlink: async (p) => _readlinkAsync(p),
    mkdtemp: async (prefix) => _mkdtempAsync(prefix),
    open: async (path, flags, mode) => _openAsync(path, flags, mode),
    opendir: async (p, opts) => _opendirAsync(p, opts),
    statfs: async (p, opts) => _statfsAsync(p, opts),
    watch: async function* (filename, opts) {
      // Minimal async iter — polls _bundleLookup every 500ms and yields
      // a single `change` event when content differs. Adequate for
      // "wait for file to change" patterns; not a complete fsevents.
      const absPath = _resolve(filename);
      let last = _bundleLookup(absPath);
      while (true) {
        await new Promise(r => setTimeout(r, 500));
        const cur = _bundleLookup(absPath);
        if (cur !== last) {
          last = cur;
          yield { eventType: cur === undefined ? 'rename' : 'change', filename: __pathMod.basename(String(filename)) };
        }
      }
    },
    glob: async function* (pattern, opts) {
      // Minimal — yield matching files via prefix scan. Not full glob.
      // Sufficient for "**/*.js" style patterns; documented limitation.
      const root = (opts && opts.cwd) ? _strip(_resolve(opts.cwd)) : _strip(_resolve('.'));
      const re = (() => {
        // Convert simple glob to regex: ** -> .*, * -> [^/]*, ? -> .
        let r = '^' + (root ? root + '/' : '');
        let g = pattern.replace(/\\/g, '/');
        for (let i = 0; i < g.length; i++) {
          const c = g[i];
          if (c === '*') {
            if (g[i+1] === '*') { r += '.*'; i++; if (g[i+1] === '/') i++; }
            else r += '[^/]*';
          } else if (c === '?') r += '.';
          else if (/[.+^$(){}|[\]\\]/.test(c)) r += '\\' + c;
          else r += c;
        }
        r += '$';
        return new RegExp(r);
      })();
      const seen = new Set();
      // The pattern is anchored at the root, so nothing outside that subtree
      // can match and nothing outside it needs visiting.
      if (__vfsBundle) for (const bk of __residentUnder(root ? root + "/" : "")) if (re.test(bk)) seen.add(bk);
      if (__vfsWrites) for (const wk in __vfsWrites) if (re.test(wk)) seen.add(wk);
      for (const m of [...seen].sort()) yield '/' + m;
    },
  };

  // ── constants ── the shared linux x64 table (see __fsConstants).
  const constants = __fsConstants;
  promises.constants = constants;

  // fs.ReadStream / fs.WriteStream classes. Real Node exposes these as
  // constructors; graceful-fs (bundled by degit → create-cloudflare)
  // re-parents its own patched stream off fs.ReadStream.prototype, so
  // the classes must exist with readable prototypes and stream the file.
  // __streamMod is defined later in the generated bundle than __fsMod,
  // so the classes are built lazily on first access (post-init) and
  // cached, exposed via getters to avoid a temporal-dead-zone reference.
  let __ReadStreamClass = null;
  let __WriteStreamClass = null;
  /**
   * An fs stream's close options, as Node reads them: autoClose (default
   * true) is whether it is destroyed once done, emitClose (default true)
   * whether destroying it emits 'close'.
   */
  function __fsStreamLifecycle(opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    return {
      autoDestroy: options.autoClose === undefined ? true : !!options.autoClose,
      emitClose: options.emitClose !== false,
    };
  }
  function __getReadStream() {
    if (__ReadStreamClass) return __ReadStreamClass;
    /**
     * ONE read-stream implementation, behind both `fs.createReadStream`
     * and the exported `fs.ReadStream` class.
     *
     * Each `_read()` pulls exactly one bounded chunk, so a multi-MB asset
     * streams to the consumer without the facet — or the supervisor — ever
     * materialising the whole file, and `.pipe()` backpressure actually
     * throttles the source. A file the prefetch bundle does not carry is
     * read live from the VFS via the same stateless ranged RPC that
     * FileHandle.read uses: the bundle is a cache, the VFS is the truth.
     */
    __ReadStreamClass = class ReadStream extends __streamMod.Readable {
      constructor(path, opts) {
        const options = typeof opts === "string" ? { encoding: opts } : (opts || {});
        super({
          encoding: options.encoding || null,
          highWaterMark: options.highWaterMark || READ_STREAM_CHUNK_BYTES,
          ...__fsStreamLifecycle(options),
        });
        this.path = path;
        this.bytesRead = 0;
        this._abs = _resolve(path);
        this._pos = Number.isFinite(options.start) ? Math.max(0, Math.trunc(options.start)) : 0;
        // Node's `end` option is INCLUSIVE.
        this._last = Number.isFinite(options.end) ? Math.trunc(options.end) : Infinity;
      }
      _read() {
        // The base class guarantees one outstanding _read at a time, so the
        // position cursor advances sequentially without extra locking.
        this._pull().catch((e) => this.destroy(e));
      }
      async _pull() {
        if (this._pos > this._last) { this.push(null); return; }
        const want = Math.min(READ_STREAM_CHUNK_BYTES, this._last - this._pos + 1);
        const chunk = await _readRangeAt(this._abs, this.path, this._pos, want);
        if (chunk === null) { this.push(null); return; }
        this._pos += chunk.byteLength;
        this.bytesRead += chunk.byteLength;
        // A Buffer, as Node's read streams yield (a view, not a copy):
        // `s += chunk` reads text, where a bare Uint8Array reads "97,98".
        this.push(__BufferMod.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if (chunk.byteLength < want) this.push(null);
      }
      open() {}
      close(cb) { this.destroy(); if (cb) cb(); }
    };
    return __ReadStreamClass;
  }
  function __getWriteStream() {
    if (__WriteStreamClass) return __WriteStreamClass;
    __WriteStreamClass = class WriteStream extends __streamMod.Writable {
      constructor(path, opts) { super(__fsStreamLifecycle(opts)); this.path = path; this._opts = opts; this._chunks = []; this._anyBytes = false; }
      _write(chunk, enc, cb) {
        if (chunk instanceof Uint8Array) { this._anyBytes = true; this._chunks.push(chunk); }
        else this._chunks.push(typeof chunk === "string" ? chunk : String(chunk));
        cb();
      }
      _final(cb) {
        try {
          if (this._anyBytes) {
            let total = 0;
            for (const c of this._chunks) total += (c instanceof Uint8Array) ? c.byteLength : _enc.encode(c).length;
            const out = new Uint8Array(total); let off = 0;
            for (const c of this._chunks) { const b = (c instanceof Uint8Array) ? c : _enc.encode(c); out.set(b, off); off += b.byteLength; }
            writeFileSync(this.path, out);
          } else {
            writeFileSync(this.path, this._chunks.join(""));
          }
          cb();
        } catch (e) { cb(e); }
      }
      open() {}
      close(cb) { if (cb) cb(); }
    };
    return __WriteStreamClass;
  }

  const __fsExports = {
    readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync,
    readdirSync, mkdirSync, unlinkSync, rmdirSync, renameSync, copyFileSync,
    realpathSync, utimesSync, lutimesSync, chmodSync, lchmodSync, chownSync, lchownSync, accessSync,
    rmSync, cpSync, mkdtempSync, truncateSync, linkSync, opendirSync, statfsSync,
    openSync, closeSync, readSync, writeSync, fstatSync, ftruncateSync, fsyncSync, fdatasyncSync,
    futimesSync, fchmodSync, fchownSync, readvSync, writevSync,
    open, close, read, write, fstat, ftruncate, fsync, fdatasync, fchmod, futimes, readv, writev,
    readFile, writeFile, appendFile, stat, lstat, readdir, exists, mkdir, unlink, rmdir, rename, utimes, lutimes, chmod, lchmod, chown, lchown, fchown, access,
    rm, cp, truncate, copyFile, mkdtemp, link, symlink, readlink, realpath, opendir, statfs,
    Dirent: __Dirent,
    Dir: __Dir,
    promises, constants,
    createReadStream: (p, opts) => new (__getReadStream())(p, opts),
    createWriteStream: (p, opts) => {
      // binary-fs: chunks may arrive as Uint8Array OR string. Keep
      // each chunk in its native shape; on final, if any chunk is
      // bytes the merged write is bytes; otherwise string-concat
      // (the hot path for ASCII text streams).
      const chunks = [];
      let anyBytes = false;
      const ws = new __streamMod.Writable({
        ...__fsStreamLifecycle(opts),
        write(chunk, enc, cb) {
          if (chunk instanceof Uint8Array) { anyBytes = true; chunks.push(chunk); }
          else chunks.push(typeof chunk === "string" ? chunk : String(chunk));
          cb();
        },
        final(cb) {
          if (anyBytes) {
            // Sum byteLength across mixed chunks; concat to one Uint8Array.
            let total = 0;
            for (const c of chunks) total += (c instanceof Uint8Array) ? c.byteLength : _enc.encode(c).length;
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
              const b = (c instanceof Uint8Array) ? c : _enc.encode(c);
              out.set(b, off);
              off += b.byteLength;
            }
            writeFileSync(p, out);
          } else {
            writeFileSync(p, chunks.join(""));
          }
          cb();
        },
      });
      return ws;
    },
    // fs.watch() — returns a watcher object that emits 'change' events.
    // In the facet context, changes to __vfsBundle/Writes are detected
    // via polling since we don't have the supervisor's event emitter.
    // For the supervisor context, real VFS events are wired separately.
    watch: (filename, opts, listener) => {
      if (typeof opts === "function") { listener = opts; opts = {}; }
      const watcher = new __eventsMod();
      watcher.close = () => { watcher._closed = true; watcher.removeAllListeners(); };
      watcher._closed = false;
      if (listener) watcher.on("change", listener);
      // A resident-store read reassembles a fresh byte buffer every time;
      // object identity is not file identity. It also changes representation
      // when data is hydrated, without a filesystem mutation. Compare the
      // namespace's inode metadata instead, without reading content. Its
      // revision is a listing cursor, not an inode edit: a relist after an
      // unrelated write must not restart every watched configuration file.
      // Heap-only embedders have no namespace, so compare bytes.
      const absPath = _resolve(filename);
      const key = _strip(absPath);
      function snapshot() {
        if (typeof __nsReady === "function") {
          // A relist temporarily makes metadata unavailable. Falling back
          // to byte cells here invents two changes: leaving and re-entering
          // the namespace, even when the watched inode never changed.
          if (!_nsActive()) return null;
          const found = __nsResolve(key, true);
          if (!found || found === "ELOOP") return { stamp: "absent", absent: true };
          const row = found.row;
          return { stamp: [row.ino, row.kind, row.size, row.mtime, row.ctime, row.mode, row.uid, row.gid].join(":"), absent: false };
        }
        const cell = _bundleLookup(absPath);
        return { data: cell instanceof Uint8Array ? cell.slice() : cell, absent: cell === undefined };
      }
      function equal(a, b) {
        if (a.stamp !== undefined || b.stamp !== undefined) return a.stamp === b.stamp;
        if (a.data === b.data) return true;
        const x = typeof a.data === "string" ? __nimbusOutEnc.encode(a.data) : a.data;
        const y = typeof b.data === "string" ? __nimbusOutEnc.encode(b.data) : b.data;
        if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== y.length) return false;
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
        return true;
      }
      let previous = snapshot();
      const interval = setInterval(() => {
        if (watcher._closed) { clearInterval(interval); return; }
        const current = snapshot();
        if (current === null) return;
        if (previous === null) { previous = current; return; }
        if (!equal(current, previous)) {
          const eventType = current.absent || previous.absent ? "rename" : "change";
          previous = current;
          watcher.emit("change", eventType, __pathMod.basename(filename));
        }
      }, 500);
      return watcher;
    },
    watchFile: (filename, opts, listener) => {
      if (typeof opts === "function") { listener = opts; opts = {}; }
      // No-op but accept the API
      return { unref: () => {} };
    },
    unwatchFile: () => {},
  };
  // Lazy getters with setters: graceful-fs reads fs.ReadStream.prototype
  // then reassigns fs.ReadStream / fs.FileReadStream to its patched
  // subclass, so each slot must be both readable (lazily) and writable.
  const __defLazyStream = (key, build) => {
    let __set = false;
    let __val;
    Object.defineProperty(__fsExports, key, {
      get() { return __set ? __val : build(); },
      set(v) { __set = true; __val = v; },
      enumerable: true, configurable: true,
    });
  };
  __defLazyStream("ReadStream", __getReadStream);
  __defLazyStream("WriteStream", __getWriteStream);
  __defLazyStream("FileReadStream", __getReadStream);
  __defLazyStream("FileWriteStream", __getWriteStream);
  _installResumptionBarriers();
  return __fsExports;
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  WebSocket: relayed through the supervisor ───────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// The last resumption that reached a facet without a supervisor message.
// A directly-connected socket delivers `onmessage` as a bare resumption:
// an arbitrary third party wakes the facet at a time of its own choosing,
// and a synchronous read in that handler serves whatever the facet was
// holding when it last heard from the authority. Two facets connected to
// any common external endpoint had a full-duplex channel that never
// touched the supervisor, which breaks causal consistency and not merely
// linearizability.
//
// Proxying the bytes would not have fixed it. The frame has to arrive AS a
// supervisor reply, so the supervisor terminates the socket and this class
// receives frames as replies to a poll it is already blocked on. Then the
// frame handler takes the same ACQUIRE the timer and fetch boundaries take,
// and `_UNBARRIERED_RESUMPTIONS` is empty.
//
// This is a listener registry rather than an EventTarget subclass on
// purpose: it dispatches plain event-shaped objects, which is what a
// relayed frame can carry across RPC, and it keeps `onmessage` and
// `addEventListener` served by one path instead of two.
//
// The second argument is Node's: subprotocols, or a WebSocketInit
// `{ protocols, headers }` (undici's), whose headers the supervisor sends
// with the upgrade. What the handshake answered (the upgrade's response
// headers, or a refusal: __nimbusRefusal) is kept on the socket under
// __NIMBUS_WS_HANDSHAKE, for the `ws` package's upgrade path
// (runtime/node-ws-upgrade.ts), which asks for a refusal's body with
// __NIMBUS_WS_REFUSAL_BODY in the init.
const __NIMBUS_WS_HANDSHAKE = Symbol.for("nimbus.websocket.handshake");
const __NIMBUS_WS_REFUSAL_BODY = Symbol.for("nimbus.websocket.refusal-body");

// A refused upgrade, as the relay answered it (session/ws-relay.ts): its
// head at once, and its body (when asked for) read from the relay as it
// comes, for the one consumer that reads it, until it ends or is cancelled.
// An open body holds the process, as a response's socket does in Node.
function __nimbusRefusal(supervisor, refused) {
  const pending = [];
  let ended = refused.body === null ? true : null;
  let consumer = null;
  let cancelled = false;
  const hold = refused.body === null ? null : __nimbusHoldSocket();
  const finish = (complete) => {
    if (ended !== null) return;
    ended = complete;
    if (hold) hold(false);
    if (consumer) consumer.end(complete);
  };
  if (refused.body !== null) {
    (async () => {
      while (ended === null && !cancelled) {
        let events;
        try {
          events = await __nimbusUseRpcResultUnref(supervisor.wsPoll(refused.body, 5000), (result) => result);
        } catch { finish(false); return; }
        if (!Array.isArray(events)) continue;
        for (const event of events) {
          if (cancelled) return;
          // Its bytes are an inbound delivery, as a frame is.
          await __nimbusInboundBarrier();
          if (event.kind === "message" && event.bytes) {
            if (consumer) consumer.chunk(event.bytes);
            else pending.push(event.bytes);
          } else if (event.kind === "close") {
            finish(event.code === 1000);
            return;
          }
        }
      }
    })();
  }
  return {
    status: refused.status,
    statusText: refused.statusText,
    headers: refused.headers,
    /** Its body to `onChunk`, then `onEnd(complete)`: whether it arrived whole. */
    read(onChunk, onEnd) {
      consumer = { chunk: onChunk, end: onEnd };
      for (const chunk of pending.splice(0)) onChunk(chunk);
      if (ended !== null) onEnd(ended);
    },
    /** The body is not wanted: the relay stops reading it. */
    cancel() {
      if (cancelled || ended !== null) return;
      cancelled = true;
      if (hold) hold(false);
      __nimbusUseRpcResultUnref(supervisor.wsClose(refused.body), () => undefined).catch(() => {});
    },
  };
}
const __NimbusRelayedWebSocket = (() => {
  const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
  /** A header list as the relay takes it: [name, value] pairs. */
  const headerPairs = (headers) => {
    if (headers === undefined || headers === null) return [];
    if (typeof headers.forEach === "function" && !Array.isArray(headers)) {
      const pairs = [];
      headers.forEach((value, name) => { pairs.push([String(name), String(value)]); });
      return pairs;
    }
    if (Array.isArray(headers)) return headers.map(([name, value]) => [String(name), String(value)]);
    return Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((one) => [name, String(one)]));
  };
  class NimbusWebSocket {
    constructor(url, protocolsOrInit) {
      const supervisor = _nimbusSupervisor();
      if (!supervisor || typeof supervisor.wsOpen !== "function") {
        // Not a fallback to the platform socket, deliberately. An
        // unmediated socket is exactly the incoherence this class exists
        // to remove, and opening one quietly would put the guarantee back
        // to being conditional on which facet you happened to be in.
        throw new Error(
          "WebSocket: no supervisor is bound to this process, so a socket " +
          "cannot be relayed; a directly-connected socket would deliver " +
          "frames outside the filesystem coherence barrier",
        );
      }
      this.url = String(url);
      this.readyState = CONNECTING;
      this.protocol = "";
      this.extensions = "";
      this.binaryType = "arraybuffer";
      this.bufferedAmount = 0;
      this.onopen = null; this.onmessage = null;
      this.onerror = null; this.onclose = null;
      this._listeners = new Map();
      this._id = null;
      this._done = false;
      this._sends = Promise.resolve();
      const init = protocolsOrInit !== null && typeof protocolsOrInit === "object" && !Array.isArray(protocolsOrInit)
        ? protocolsOrInit : { protocols: protocolsOrInit };
      const protocols = init.protocols;
      const requested = protocols === undefined ? []
        : (Array.isArray(protocols) ? protocols.map(String) : [String(protocols)]);
      const headers = headerPairs(init.headers);
      const refusalBody = init[__NIMBUS_WS_REFUSAL_BODY] === true;
      this[__NIMBUS_WS_HANDSHAKE] = null;
      // Open, or opening, until its close: a handle, as Node's WebSocket is.
      // Taken only once the socket exists, past every throw in this
      // constructor: a caught constructor failure holds nothing.
      this._hold = __nimbusHoldSocket();
      this._ready = this._connect(supervisor, requested, headers, refusalBody);
    }

    async _connect(supervisor, protocols, headers, refusalBody) {
      try {
        const opened = await __nimbusUseRpcResultUnref(
          supervisor.wsOpen(this.url, protocols, headers, refusalBody),
          (result) => result,
        );
        if (opened.refused) {
          if (this.readyState !== CONNECTING) {
            // Closed while it handshook (an aborted request): its body is not
            // wanted, and nothing of it may hold the process; close() reports the close.
            if (opened.refused.body !== null) {
              __nimbusUseRpcResultUnref(supervisor.wsClose(opened.refused.body), () => undefined).catch(() => {});
            }
            return;
          }
          this[__NIMBUS_WS_HANDSHAKE] = __nimbusRefusal(supervisor, opened.refused);
          throw new Error("websocket relay: " + this.url + " did not upgrade (HTTP " + opened.refused.status + ")");
        }
        this[__NIMBUS_WS_HANDSHAKE] = { status: 101, statusText: "Switching Protocols", headers: opened.headers || [] };
        this._id = opened.id;
        this.protocol = opened.protocol || "";
        this._pump(supervisor);
      } catch (error) {
        this._fail(error);
      }
    }

    async _pump(supervisor) {
      while (!this._done) {
        let events;
        try {
          events = await __nimbusUseRpcResultUnref(
            supervisor.wsPoll(this._id, 5000),
            (result) => result,
          );
        } catch (error) { this._fail(error); return; }
        if (!Array.isArray(events)) continue;
        for (const event of events) {
          if (this._done) return;
          // The barrier the whole relay exists for. Every frame is now a
          // supervisor reply, so it can carry the invalidation delta, and
          // user code runs only after the resident set has caught up.
          await __nimbusInboundBarrier();
          this._deliver(event);
        }
      }
    }

    _deliver(event) {
      if (event.kind === "open") {
        this.readyState = OPEN;
        this._emit({ type: "open", target: this });
        return;
      }
      if (event.kind === "message") {
        const data = event.text !== null && event.text !== undefined
          ? event.text
          : (this.binaryType === "arraybuffer"
            ? _nimbusToArrayBuffer(event.bytes)
            : event.bytes);
        this._emit({ type: "message", data, target: this });
        return;
      }
      if (event.kind === "error") {
        this._emit({ type: "error", message: event.message, target: this });
        return;
      }
      if (event.kind === "close") {
        this._done = true;
        this._hold(false);
        this.readyState = CLOSED;
        this._emit({
          type: "close", code: event.code, reason: event.reason,
          wasClean: event.code === 1000, target: this,
        });
      }
    }

    _fail(error) {
      if (this._done) return;
      this._done = true;
      this._hold(false);
      this.readyState = CLOSED;
      const message = (error && error.message) || String(error);
      this._emit({ type: "error", message, target: this });
      this._emit({ type: "close", code: 1006, reason: message, wasClean: false, target: this });
    }

    _emit(event) {
      const handler = this["on" + event.type];
      if (typeof handler === "function") {
        try { handler.call(this, event); } catch (error) { _nimbusReportListenerError(error); }
      }
      const listeners = this._listeners.get(event.type);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try {
          if (typeof listener === "function") listener.call(this, event);
          else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(event);
        } catch (error) { _nimbusReportListenerError(error); }
      }
    }

    addEventListener(type, listener) {
      const key = String(type);
      if (!this._listeners.has(key)) this._listeners.set(key, new Set());
      this._listeners.get(key).add(listener);
    }

    removeEventListener(type, listener) {
      const listeners = this._listeners.get(String(type));
      if (listeners) listeners.delete(listener);
    }

    dispatchEvent(event) { this._emit(event); return true; }

    send(data) {
      if (this.readyState === CLOSED || this.readyState === CLOSING) {
        throw new Error("WebSocket: send on a socket that is already closing");
      }
      const text = typeof data === "string" ? data : null;
      const bytes = text === null ? _nimbusToBytes(data) : null;
      const size = text !== null ? text.length : (bytes ? bytes.byteLength : 0);
      this.bufferedAmount += size;
      // A frame leaving this facet is an outward-visible effect of whatever
      // it just wrote, so the parked writes go first. Otherwise the peer
      // that reads this frame can act on a write the authority does not
      // have yet, which is the causal edge the protocol closes.
      this._sends = this._sends.then(async () => {
        const supervisor = _nimbusSupervisor();
        if (!supervisor || this._done) return;
        const release = globalThis.__nimbusVfsReleaseBarrier;
        if (typeof release === "function") await release();
        await this._ready;
        if (this._id === null || this._done) return;
        await __nimbusUseRpcResultUnref(
          supervisor.wsSend(this._id, text, bytes),
          () => undefined,
        );
      }).then(
        () => { this.bufferedAmount -= size; },
        (error) => { this.bufferedAmount -= size; this._fail(error); },
      );
      __nimbusTrackOp(this._sends);
    }

    close(code, reason) {
      if (this._done || this.readyState === CLOSING) return;
      this.readyState = CLOSING;
      const supervisor = _nimbusSupervisor();
      const closing = (async () => {
        await this._ready.catch(() => {});
        if (this._id === null || !supervisor) return;
        await __nimbusUseRpcResultUnref(
          supervisor.wsClose(this._id, code, reason),
          () => undefined,
        );
      })().catch(() => {}).then(() => {
        this._done = true;
        this._hold(false);
        this.readyState = CLOSED;
        this._emit({
          type: "close", code: code === undefined ? 1000 : code,
          reason: reason === undefined ? "" : String(reason),
          wasClean: true, target: this,
        });
      });
      __nimbusTrackOp(closing);
    }
  }
  for (const [name, value] of [["CONNECTING", CONNECTING], ["OPEN", OPEN], ["CLOSING", CLOSING], ["CLOSED", CLOSED]]) {
    NimbusWebSocket[name] = value;
    NimbusWebSocket.prototype[name] = value;
  }
  return NimbusWebSocket;
})();

function _nimbusSupervisor() {
  try { return typeof __supervisor !== "undefined" ? __supervisor : null; }
  catch { return null; }
}

function _nimbusToBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}

function _nimbusToArrayBuffer(bytes) {
  if (!bytes) return new ArrayBuffer(0);
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.buffer.byteLength === view.byteLength
    ? view.buffer
    : view.slice().buffer;
}

// A listener that throws is the program's bug, but swallowing it silently
// would make a relayed socket behave differently from a direct one. Route it
// to the same place an uncaught async failure goes.
function _nimbusReportListenerError(error) {
  queueMicrotask(() => { throw error; });
}

globalThis.WebSocket = __NimbusRelayedWebSocket;

// ═══════════════════════════════════════════════════════════════════════
// ──  constants module (framework-fixes-F1) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// require('node:constants') (and the legacy bare require('constants'))
// expose a FLAT object of POSIX/Linux/OpenSSL constants. Real Node ships
// ~234 constants; the full fs slice comes from __fsConstants, and the rest
// is what actually gets touched by:
//   - create-next-app (touches UV_FS_O_FILEMAP — verified via grep on
//     unpkg.com/create-next-app@latest/dist/index.js)
//   - signal/errno tables (shared shape with __osMod.constants.signals
//     etc. — flat here, nested there; both shapes are real-Node-accurate
//     and we expose both via the right module).
//   - dlopen flags (RTLD_*) for libraries that probe defined-ness.
//   - SSL_OP_* / TLS_*_VERSION for libs that probe TLS options
//     (vanilla openssl numeric values — semantic match real Node's).
//
// Values match real Node v20 on Linux exactly. Verified via
// node -e 'console.log(require("node:constants"))'.
//
// History: F1 root cause in framework-fixes wave. Pre-fix create-next-app
// errored with "Cannot find module 'node:constants'" at module init.
// The errno, signal, priority and dlopen tables, written once: node:constants
// spreads them flat, os.constants nests them by name.
const __dlopenConstants = { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0, RTLD_DEEPBIND: 8 };
// Errno (Linux ABI). fs/network libraries (graceful-fs, retry layers in
// node-fetch wrappers) probe these to decide retry strategy.
const __errnoConstants = {
  E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAFNOSUPPORT: 97,
  EAGAIN: 11, EALREADY: 114, EBADF: 9, EBADMSG: 74, EBUSY: 16,
  ECANCELED: 125, ECHILD: 10, ECONNABORTED: 103, ECONNREFUSED: 111,
  ECONNRESET: 104, EDEADLK: 35, EDESTADDRREQ: 89, EDOM: 33, EDQUOT: 122,
  EEXIST: 17, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 113, EIDRM: 43,
  EILSEQ: 84, EINPROGRESS: 115, EINTR: 4, EINVAL: 22, EIO: 5,
  EISCONN: 106, EISDIR: 21, ELOOP: 40, EMFILE: 24, EMLINK: 31,
  EMSGSIZE: 90, EMULTIHOP: 72, ENAMETOOLONG: 36, ENETDOWN: 100,
  ENETRESET: 102, ENETUNREACH: 101, ENFILE: 23, ENOBUFS: 105,
  ENODATA: 61, ENODEV: 19, ENOENT: 2, ENOEXEC: 8, ENOLCK: 37,
  ENOLINK: 67, ENOMEM: 12, ENOMSG: 42, ENOPROTOOPT: 92, ENOSPC: 28,
  ENOSR: 63, ENOSTR: 60, ENOSYS: 38, ENOTCONN: 107, ENOTDIR: 20,
  ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95, ENOTTY: 25, ENXIO: 6,
  EOPNOTSUPP: 95, EOVERFLOW: 75, EPERM: 1, EPIPE: 32, EPROTO: 71,
  EPROTONOSUPPORT: 93, EPROTOTYPE: 91, ERANGE: 34, EROFS: 30,
  ESPIPE: 29, ESRCH: 3, ESTALE: 116, ETIME: 62, ETIMEDOUT: 110,
  ETXTBSY: 26, EWOULDBLOCK: 11, EXDEV: 18,
};
// Process priority, for os.setPriority / os.getPriority.
const __priorityConstants = {
  PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0,
  PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20,
};
// Signals (POSIX + Linux), numbered as the Linux ABI numbers them.
const __signalConstants = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
  SIGABRT: 6, SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9,
  SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14,
  SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16, SIGCONT: 18, SIGSTOP: 19,
  SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24,
  SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
  SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
};
const __constantsMod = {
  ...__dlopenConstants,
  ...__errnoConstants,
  ...__priorityConstants,
  ...__signalConstants,
  // ── fs constants (O_*, S_IF*, S_I*, F_OK.., COPYFILE_*, UV_*) ────
  // Node's constants module is the union of os, fs and crypto constants;
  // the fs slice is __fsConstants, the same object fs.constants exposes.
  ...__fsConstants,
  // ── OpenSSL / TLS option flags ────────────────────────────────────
  // Numeric values from real Node v20. Libraries probe defined-ness;
  // we ship the surface so constants.SSL_OP_* doesn't undefined-throw.
  OPENSSL_VERSION_NUMBER: 810549328,
  SSL_OP_ALL: 2147485776, SSL_OP_ALLOW_NO_DHE_KEX: 1024,
  SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144,
  SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304,
  SSL_OP_CISCO_ANYCONNECT: 32768, SSL_OP_COOKIE_EXCHANGE: 8192,
  SSL_OP_CRYPTOPRO_TLSEXT_BUG: 2147483648,
  SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS: 2048,
  SSL_OP_LEGACY_SERVER_CONNECT: 4, SSL_OP_NO_COMPRESSION: 131072,
  SSL_OP_NO_ENCRYPT_THEN_MAC: 524288, SSL_OP_NO_QUERY_MTU: 4096,
  SSL_OP_NO_RENEGOTIATION: 1073741824,
  SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION: 65536,
  SSL_OP_NO_SSLv2: 0, SSL_OP_NO_SSLv3: 33554432,
  SSL_OP_NO_TICKET: 16384, SSL_OP_NO_TLSv1: 67108864,
  SSL_OP_NO_TLSv1_1: 268435456, SSL_OP_NO_TLSv1_2: 134217728,
  SSL_OP_NO_TLSv1_3: 536870912, SSL_OP_PRIORITIZE_CHACHA: 2097152,
  SSL_OP_TLS_ROLLBACK_BUG: 8388608,
  // ── TLS version numbers ───────────────────────────────────────────
  TLS1_VERSION: 769, TLS1_1_VERSION: 770,
  TLS1_2_VERSION: 771, TLS1_3_VERSION: 772,
  // ── crypto engine method flags ────────────────────────────────────
  ENGINE_METHOD_RSA: 1, ENGINE_METHOD_DSA: 2, ENGINE_METHOD_DH: 4,
  ENGINE_METHOD_RAND: 8, ENGINE_METHOD_EC: 2048,
  ENGINE_METHOD_CIPHERS: 64, ENGINE_METHOD_DIGESTS: 128,
  ENGINE_METHOD_PKEY_METHS: 512, ENGINE_METHOD_PKEY_ASN1_METHS: 1024,
  ENGINE_METHOD_ALL: 65535, ENGINE_METHOD_NONE: 0,
  // ── DH / RSA padding ──────────────────────────────────────────────
  DH_CHECK_P_NOT_SAFE_PRIME: 2, DH_CHECK_P_NOT_PRIME: 1,
  DH_UNABLE_TO_CHECK_GENERATOR: 4, DH_NOT_SUITABLE_GENERATOR: 8,
  RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4, RSA_X931_PADDING: 5,
  RSA_PKCS1_PSS_PADDING: 6,
  RSA_PSS_SALTLEN_DIGEST: -1, RSA_PSS_SALTLEN_MAX_SIGN: -2,
  RSA_PSS_SALTLEN_AUTO: -2,
};

// ═══════════════════════════════════════════════════════════════════════
// ──  os module ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __osMod = {
  platform: () => "linux", arch: () => "x64", type: () => "Linux",
  release: () => "6.0.0-nimbus", tmpdir: () => "/tmp", homedir: () => "/home/user",
  hostname: () => "nimbus", userInfo: () => {
    const uid = Number(cred.uid);
    const gid = Number(cred.gid);
    const root = uid === 0;
    return { uid, gid, username: root ? "root" : "user", homedir: root ? "/root" : "/home/user", shell: "/bin/sh" };
  },
  cpus: () => [{ model: "DO vCPU", speed: 3000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
  // One JavaScript thread per Worker isolate, irrespective of the host CPU.
  availableParallelism: () => 1,
  totalmem: () => 128 * 1024 * 1024, freemem: () => 64 * 1024 * 1024,
  loadavg: () => [0, 0, 0], uptime: () => 3600,
  networkInterfaces: () => ({ lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }] }),
  EOL: "\n", endianness: () => "LE",
  // os.constants — signals + errno + priority. Used by human-signals,
  // signal-exit, cross-spawn, exit-hook, and a long tail of "graceful
  // shutdown" / "child-process plumbing" libraries that real Node ships.
  //
  // human-signals's main.js (v2+) does:
  //   import { constants } from 'node:os'
  //   ...
  //   const findSignalByNumber = (number, signals) =>
  //     signals.find(({ name }) => constants.signals[name] === number)
  //
  // Pre-fix, __osMod had no `constants` field → `constants.signals`
  // was undefined → `signals[name]` throws TypeError → caller's
  // `getSignalsByName` blows up at module init time. Surfaced by
  // create-react-router (transitively depends on human-signals via
  // execa / cross-spawn).
  //
  // Values mirror real Node v20+ on Linux (verified against `node -e
  // "console.log(require('os').constants)"`). The shape is stable;
  // pinning POSIX signal numbers per the LSB / glibc table.
  constants: {
    signals: __signalConstants,
    errno: __errnoConstants,
    priority: __priorityConstants,
    dlopen: __dlopenConstants,
  },
};

// ═══════════════════════════════════════════════════════════════════════
// ──  events module ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// workerd's own node:events (nodejs_compat). Its EventEmitter is Node's
// function constructor, so `EventEmitter.call(this)` + util.inherits,
// mixin-copies of EventEmitter.prototype (express's createApplication) and
// the static once/on/captureRejections helpers behave as in Node, and native
// node:http servers are instances of the same class userland requires.
// https://developers.cloudflare.com/workers/runtime-apis/nodejs/events/ and
// workerd v1.20260926.1 src/node/internal/events.ts (`export function
// EventEmitter`; http servers extend it in internal_http_server.ts).
const __eventsMod = typeof __real_events !== "undefined"
  ? (__real_events.default ?? __real_events.EventEmitter) : globalThis.process.getBuiltinModule("events");

// ═══════════════════════════════════════════════════════════════════════
// ──  stream module (real, with backpressure) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ── Node-compatible Streams (Nimbus v2.0) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════

const __streamMod = (() => {
  const _enc = new TextEncoder();
  const _dec = new TextDecoder();
  const _Decoder = TextDecoder;

  /** Node's ERR_STREAM_DESTROYED, for a write or end() a destroyed stream refuses. */
  function _destroyedError(method) {
    return Object.assign(new Error('Cannot call ' + method + ' after a stream was destroyed'), { code: 'ERR_STREAM_DESTROYED' });
  }

  /**
   * Node's errorBuffer: once destroyed, queued writes and end() callbacks
   * are answered, never left waiting on a stream that will not write them.
   */
  function _errorBuffer(state, err) {
    for (const { chunk, callback } of state.buffer.splice(0)) {
      state.bufferedLength -= (chunk?.length || 0);
      state.pending--;
      if (callback) callback(err ?? _destroyedError('write'));
    }
    for (const cb of state.finishCallbacks.splice(0)) cb(err ?? _destroyedError('end'));
  }

  /** Node's errorOrDestroy for the writable side: autoDestroy closes it. */
  function _errorOrDestroy(stream, err) {
    const state = stream._writableState;
    if (state.destroyed) return;
    if (state.autoDestroy) stream.destroy(err);
    else stream.emit('error', err);
  }

  /**
   * Destroy either side of a stream, and both of a Duplex, once: 'error' if
   * given, then 'close' unless the stream was created with emitClose: false.
   */
  function _destroyStream(stream, err) {
    const r = stream._readableState, w = stream._writableState;
    if ((r && r.destroyed) || (w && w.destroyed)) return stream;
    if (r) { r.destroyed = true; stream.readable = false; }
    if (w) {
      w.destroyed = true;
      // A write in flight answers the queue when it calls back.
      if (!w.writing) queueMicrotask(() => _errorBuffer(w));
    }
    if (err) stream.emit('error', err);
    if ((r || w).emitClose) stream.emit('close');
    return stream;
  }

  // ── Readable ────────────────────────────────────────────────────────
  //
  // Node's read machinery is a PULL: the consumer's demand is what causes
  // `_read()` to be called. Two consumer idioms create demand implicitly —
  // attaching a 'data' listener and `.pipe()` — and both put the stream in
  // flowing mode. Honouring that is not cosmetic: a source whose `_read()`
  // is never called produces nothing at all, so
  // `fs.createReadStream(f).on('data', …)` and `.pipe(res)` hang forever
  // (every static file server, and the doom-web asset serve, are exactly
  // this shape). `_flow` below is the single pump used by flowing mode,
  // `read()`, and the async iterator, so a source that pushes
  // ASYNCHRONOUSLY (a live VFS range read) works through all three.
  /**
   * A stream class as Node defines one: constructed with `new`, extended
   * with `class extends`, and also CALLED on an object that inherits its
   * prototype (`Writable.call(this, opts)`), which pre-class modules do to
   * inherit: follow-redirects (axios's http adapter) does exactly that, and a
   * class constructor refuses to be called. Node's stream constructors are
   * functions for this reason (lib/internal/streams/writable.js); `init`
   * does to `this` what constructing does. Called on anything else, it
   * constructs, as Node's does.
   */
  function __legacyConstructor(Class, name, init) {
    // A function, not a method: only a function is a constructor; the key names it.
    const Constructor = {
      [name]: function (...args) {
        if (new.target) return Reflect.construct(Class, args, new.target);
        if (this instanceof Constructor) {
          init(this, ...args);
          return undefined;
        }
        return new Constructor(...args);
      },
    }[name];
    Constructor.prototype = Class.prototype;
    Object.defineProperty(Class.prototype, 'constructor', { value: Constructor, writable: true, configurable: true, enumerable: false });
    Object.setPrototypeOf(Constructor, Object.getPrototypeOf(Class));
    return Constructor;
  }

  function _initReadable(stream, opts) {
    stream._readableState = {
      buffer: [],
      ended: false,
      endEmitted: false,
      flowing: null,
      // reading — a _read() call is outstanding: no push() and no EOF has
      // landed since. Keeps the pump from stacking redundant _read calls
      // while an async source is in flight.
      reading: false,
      pumping: false,
      highWaterMark: opts?.highWaterMark ?? 16384,
      encoding: opts?.encoding || null,
      objectMode: opts?.objectMode ?? false,
      autoDestroy: opts?.autoDestroy !== false,
      emitClose: opts?.emitClose !== false,
      destroyed: false,
      readableLength: 0,
      // A consumer reads it in readable mode: a 'readable' listener, or an
      // async iterator, which owns it until it completes. Node's
      // flushStdio leaves such a stream to its consumer. Kept current as
      // listeners come and go (_updateReadableListening).
      readableListening: false,
      iterating: false,
    };
    stream.readable = true;
    if (opts?.read) stream._read = opts.read.bind(stream);
  }

  class ReadableClass extends __eventsMod {
    constructor(opts) {
      super();
      _initReadable(this, opts);
    }

    _read(size) { /* override in subclass */ }

    /** Ask the source for more, unless it already owes us a push or is done. */
    _maybeRead() {
      const state = this._readableState;
      if (state.reading || state.ended || state.destroyed) return;
      state.reading = true;
      try { this._read(state.highWaterMark); }
      catch (err) { state.reading = false; this.destroy(err); }
    }

    _shift() {
      const state = this._readableState;
      const chunk = state.buffer.shift();
      state.readableLength -= (chunk?.length || 0);
      return this._decode(chunk);
    }

    _decode(chunk) {
      const enc = this._readableState.encoding;
      if (!enc || enc === 'buffer' || !(chunk instanceof Uint8Array)) return chunk;
      try { return new _Decoder(enc === 'binary' ? 'latin1' : enc).decode(chunk); }
      catch { return chunk; }
    }

    _maybeEmitEnd() {
      const state = this._readableState;
      if (state.ended && state.buffer.length === 0 && !state.endEmitted) {
        state.endEmitted = true;
        this.readable = false;
        this._emitEnd();
        return true;
      }
      return false;
    }

    /**
     * 'end', then Node's autoDestroy (on unless the stream opts out): a
     * stream done reading, and done writing if it is a Duplex, is destroyed,
     * so 'close' follows 'end'. Consumers wait on it: node-static ends the
     * response on its file stream's 'close'.
     */
    _emitEnd() {
      this.emit('end');
      const ws = this._writableState;
      if (this._readableState.autoDestroy && (!ws || (ws.autoDestroy && ws.finished))) {
        queueMicrotask(() => this.destroy());
      }
    }

    /**
     * Drain buffered chunks to 'data' listeners while flowing, then ask the
     * source for more. Deferred to a microtask so a synchronous `push()`
     * from inside `_read()` cannot recurse into the stack.
     */
    _flow() {
      const state = this._readableState;
      if (state.pumping) return;
      state.pumping = true;
      queueMicrotask(() => {
        state.pumping = false;
        while (state.flowing && state.buffer.length > 0 && !state.destroyed) {
          this.emit('data', this._shift());
        }
        if (this._maybeEmitEnd()) return;
        if (state.flowing && !state.destroyed) this._maybeRead();
      });
    }

    read(size) {
      const state = this._readableState;
      if (state.buffer.length === 0) {
        if (state.ended) return null;
        this._maybeRead();
        if (state.buffer.length === 0) return null;
      }
      const chunk = this._shift();
      if (state.buffer.length === 0 && state.ended && !state.endEmitted) {
        state.endEmitted = true;
        this.readable = false;
        queueMicrotask(() => this._emitEnd());
      }
      return chunk;
    }

    push(chunk, encoding) {
      const state = this._readableState;
      state.reading = false;
      if (chunk === null) {
        state.ended = true;
        if (state.flowing) this._flow();
        else if (state.buffer.length === 0 && !state.endEmitted) {
          state.endEmitted = true;
          this.readable = false;
          queueMicrotask(() => this._emitEnd());
        }
        return false;
      }
      if (typeof chunk === 'string' && !state.objectMode) {
        chunk = _enc.encode(chunk);
      }
      state.buffer.push(chunk);
      state.readableLength += (chunk?.length || 0);
      if (state.flowing) this._flow();
      return state.readableLength < state.highWaterMark;
    }

    // Node switches to flowing mode when a 'data' listener is attached,
    // unless the consumer explicitly called pause().
    on(event, listener) {
      const result = super.on(event, listener);
      if (event === 'data' && this._readableState.flowing !== false) this.resume();
      else if (event === 'readable') this._updateReadableListening();
      return result;
    }
    addListener(event, listener) { return this.on(event, listener); }
    // EventEmitter's off is its removeListener itself, not a call through
    // the subclass, so both are overridden; once's wrapper removes itself
    // through removeListener.
    removeListener(event, listener) {
      const result = super.removeListener(event, listener);
      if (event === 'readable') this._updateReadableListening();
      return result;
    }
    off(event, listener) { return this.removeListener(event, listener); }
    removeAllListeners(...args) {
      const result = super.removeAllListeners(...args);
      if (args.length === 0 || args[0] === 'readable') this._updateReadableListening();
      return result;
    }
    _updateReadableListening() {
      const state = this._readableState;
      state.readableListening = state.iterating === true || this.listenerCount('readable') > 0;
    }

    pipe(dest, opts) {
      this.on('data', (chunk) => {
        const canContinue = dest.write(chunk);
        if (!canContinue) {
          this.pause();
          dest.once('drain', () => this.resume());
        }
      });
      this.on('end', () => {
        if (opts?.end !== false) dest.end();
      });
      this.resume();
      return dest;
    }

    unpipe(dest) {
      this.removeAllListeners('data');
      return this;
    }

    resume() {
      const state = this._readableState;
      if (state.flowing !== true) {
        state.flowing = true;
        this._flow();
      }
      return this;
    }

    pause() {
      this._readableState.flowing = false;
      return this;
    }

    setEncoding(enc) {
      this._readableState.encoding = enc;
      return this;
    }

    destroy(err) { return _destroyStream(this, err); }

    get readableEnded() { return this._readableState.endEmitted; }
    get readableLength() { return this._readableState.readableLength; }
    get readableFlowing() { return this._readableState.flowing; }

    // One chunk per tick: resume, take the next 'data', pause again. Uses
    // the same pump as flowing mode, so an asynchronous source works here
    // too (the old implementation called read() once and then waited for a
    // 'data' event that nothing would ever emit in paused mode).
    [Symbol.asyncIterator]() {
      const self = this;
      const state = self._readableState;
      // The iterator owns the stream until it completes.
      state.iterating = true;
      self._updateReadableListening();
      const finish = () => {
        state.iterating = false;
        self._updateReadableListening();
      };
      const iterator = {
        next() {
          return new Promise((resolve, reject) => {
            if (state.buffer.length > 0) {
              const chunk = self._shift();
              self._maybeEmitEnd();
              return resolve({ value: chunk, done: false });
            }
            if (state.ended || state.destroyed) { finish(); return resolve({ value: undefined, done: true }); }
            const cleanup = () => {
              self.off('data', onData);
              self.off('end', onEnd);
              self.off('error', onError);
            };
            const onData = (c) => { cleanup(); self.pause(); resolve({ value: c, done: false }); };
            const onEnd = () => { cleanup(); finish(); resolve({ value: undefined, done: true }); };
            const onError = (e) => { cleanup(); finish(); reject(e); };
            self.once('data', onData);
            self.once('end', onEnd);
            self.once('error', onError);
            self.resume();
          });
        },
        return() {
          finish();
          self.destroy();
          return Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator]() { return iterator; },
      };
      return iterator;
    }
  }
  const Readable = __legacyConstructor(ReadableClass, 'Readable', (stream, opts) => {
    __eventsMod.call(stream, opts);
    _initReadable(stream, opts);
  });

  // ── Readable.from / Readable.fromWeb ────────────────────────────────
  // Node exposes these statics; libraries that stream a fetch
  // `response.body` (a web ReadableStream) into a Node pipeline rely on
  // `Readable.fromWeb` (giget's template download:
  // `pipeline(response.body, createWriteStream(...))`). A web
  // ReadableStream has no `.pipe`, so it must be adapted first.
  Readable.from = function from(iterable, opts) {
    // Node (lib/internal/streams/from.js): object mode unless the caller says
    // otherwise, so values arrive as yielded; and a string or Buffer is
    // emitted whole rather than iterated. http-server streams
    // `Readable.from(bytes)` of each text file into the response, which
    // refuses a byte-number chunk.
    const r = new Readable({ ...opts, objectMode: opts?.objectMode ?? true });
    if (typeof iterable === 'string' || iterable instanceof Uint8Array) {
      r._read = function () { this.push(iterable); this.push(null); };
      return r;
    }
    r._read = () => {};
    (async () => {
      try {
        for await (const chunk of iterable) r.push(chunk);
        r.push(null);
      } catch (err) { r.destroy(err); }
    })();
    return r;
  };
  Readable.fromWeb = function fromWeb(webStream, opts) {
    const r = new Readable({ ...opts });
    const reader = webStream.getReader();
    r._read = () => {};
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { r.push(null); break; }
          r.push(value);
        }
      } catch (err) { r.destroy(err); }
    })();
    return r;
  };

  // ── Writable ────────────────────────────────────────────────────────
  //
  // Node's order (lib/internal/streams/writable.js): one _write at a time,
  // the rest queued; end() waits for every write to call back before
  // _final, 'finish' follows _final's callback, and autoDestroy then closes
  // the stream (a Duplex once its readable side has ended too). An
  // asynchronous _write or _transform is therefore complete, and a
  // Transform's output delivered, before 'finish' and 'close'.
  function _writableState(opts, highWaterMark) {
    return {
      buffer: [],
      writing: false,
      // Writes and _final not yet called back.
      pending: 0,
      ending: false,
      finalCalled: false,
      finished: false,
      finishCallbacks: [],
      highWaterMark,
      needDrain: false,
      autoDestroy: opts?.autoDestroy !== false,
      emitClose: opts?.emitClose !== false,
      destroyed: false,
      corked: 0,
      bufferedLength: 0,
    };
  }

  function _write(stream, chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    const state = stream._writableState;
    if (state.ending || state.destroyed) {
      // A destroyed stream reports nothing further; the write's callback is
      // still answered.
      const err = state.ending
        ? Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' })
        : _destroyedError('write');
      if (state.destroyed) { if (callback) queueMicrotask(() => callback(err)); return false; }
      if (callback) callback(err);
      _errorOrDestroy(stream, err);
      return false;
    }
    if (typeof chunk === 'string') chunk = _enc.encode(chunk);
    state.bufferedLength += (chunk?.length || 0);
    state.pending++;
    const request = { chunk, encoding, callback };
    if (state.writing || state.corked > 0) state.buffer.push(request);
    else _doWrite(stream, request);
    if (state.bufferedLength >= state.highWaterMark) {
      state.needDrain = true;
      return false;
    }
    return true;
  }

  function _doWrite(stream, { chunk, encoding, callback }) {
    const state = stream._writableState;
    state.writing = true;
    let called = false;
    stream._write(chunk, encoding, (err) => {
      if (called) return;
      called = true;
      state.writing = false;
      state.bufferedLength -= (chunk?.length || 0);
      state.pending--;
      if (err) {
        // Node's onwriteError: this callback, then the queue, then 'error'
        // unless the stream was destroyed.
        if (callback) callback(err);
        _errorBuffer(state, err);
        _errorOrDestroy(stream, err);
        return;
      }
      // The next queued write starts before this one's callback, then
      // 'drain', as Node's onwrite/afterWrite order them.
      if (state.buffer.length > 0 && state.corked === 0 && !state.destroyed) _doWrite(stream, state.buffer.shift());
      if (state.needDrain && state.bufferedLength === 0 && !state.ending) {
        state.needDrain = false;
        stream.emit('drain');
      }
      if (callback) callback();
      if (state.destroyed) _errorBuffer(state);
      else _finishMaybe(stream);
    });
  }

  function _end(stream, chunk, encoding, callback) {
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    const state = stream._writableState;
    if (chunk !== undefined && chunk !== null) _write(stream, chunk, encoding);
    if (state.corked > 0) { state.corked = 1; _uncork(stream); }
    if (callback) {
      if (state.finished) queueMicrotask(() => callback());
      else state.finishCallbacks.push(callback);
    }
    if (!state.ending) {
      state.ending = true;
      // A stream ended with nothing in flight finishes on a later tick.
      queueMicrotask(() => _finishMaybe(stream));
    }
    return stream;
  }

  function _uncork(stream) {
    const state = stream._writableState;
    if (state.corked > 0) state.corked--;
    if (state.corked === 0 && !state.writing && state.buffer.length > 0) _doWrite(stream, state.buffer.shift());
  }

  /** _final, then 'finish', once end() was called and every write called back. */
  function _finishMaybe(stream) {
    const state = stream._writableState;
    if (!state.ending || state.finished || state.writing || state.buffer.length > 0 || state.pending > 0 || state.destroyed) return;
    if (!state.finalCalled && typeof stream._final === 'function') {
      state.finalCalled = true;
      state.pending++;
      let called = false;
      const onFinal = (err) => {
        if (called) return;
        called = true;
        state.pending--;
        if (err) {
          for (const cb of state.finishCallbacks.splice(0)) cb(err);
          _errorOrDestroy(stream, err);
          return;
        }
        queueMicrotask(() => _finish(stream));
      };
      try { stream._final(onFinal); } catch (err) { onFinal(err); }
      return;
    }
    if (!state.finalCalled) {
      state.finalCalled = true;
      _finish(stream);
    }
  }

  function _finish(stream) {
    const state = stream._writableState;
    if (state.finished || state.destroyed) return;
    state.finished = true;
    for (const cb of state.finishCallbacks.splice(0)) cb();
    stream.emit('finish');
    // autoDestroy, as Readable's _emitEnd: 'close' follows 'finish', for a
    // Duplex once its readable side has ended too.
    const rs = stream._readableState;
    if (state.autoDestroy && (!rs || (rs.autoDestroy && rs.endEmitted))) queueMicrotask(() => stream.destroy());
  }

  function _initWritable(stream, opts) {
    stream._writableState = _writableState(opts, opts?.highWaterMark ?? 16384);
    stream.writable = true;
    if (opts?.write) stream._write = opts.write.bind(stream);
    if (opts?.final) stream._final = opts.final.bind(stream);
    if (opts?.destroy) stream._destroy = opts.destroy.bind(stream);
  }

  class WritableClass extends __eventsMod {
    constructor(opts) {
      super();
      _initWritable(this, opts);
    }

    _write(chunk, encoding, callback) { callback(); }

    write(chunk, encoding, callback) { return _write(this, chunk, encoding, callback); }
    end(chunk, encoding, callback) { return _end(this, chunk, encoding, callback); }
    cork() { this._writableState.corked++; }
    uncork() { _uncork(this); }
    destroy(err) { return _destroyStream(this, err); }

    get writableEnded() { return this._writableState.ending; }
    get writableFinished() { return this._writableState.finished; }
    get writableLength() { return this._writableState.bufferedLength; }
  }
  const Writable = __legacyConstructor(WritableClass, 'Writable', (stream, opts) => {
    __eventsMod.call(stream, opts);
    _initWritable(stream, opts);
  });

  // ── Duplex ──────────────────────────────────────────────────────────
  function _initDuplexWritable(stream, opts) {
    stream._writableState = _writableState(opts, opts?.writableHighWaterMark ?? opts?.highWaterMark ?? 16384);
    stream.writable = true;
    if (opts?.write) stream._write = opts.write.bind(stream);
    if (opts?.final) stream._final = opts.final.bind(stream);
  }
  const _initDuplex = (stream, opts) => {
    __eventsMod.call(stream, opts);
    _initReadable(stream, opts);
    _initDuplexWritable(stream, opts);
  };

  class DuplexClass extends Readable {
    constructor(opts) {
      super(opts);
      _initDuplexWritable(this, opts);
    }
    _write(chunk, encoding, callback) { callback(); }
    write(chunk, encoding, callback) { return _write(this, chunk, encoding, callback); }
    end(chunk, encoding, callback) { return _end(this, chunk, encoding, callback); }
    cork() { this._writableState.corked++; }
    uncork() { _uncork(this); }
    get writableEnded() { return this._writableState.ending; }
    get writableFinished() { return this._writableState.finished; }
    get writableLength() { return this._writableState.bufferedLength; }
  }
  const Duplex = __legacyConstructor(DuplexClass, 'Duplex', _initDuplex);

  // ── Transform ───────────────────────────────────────────────────────
  function _initTransform(stream, opts) {
    if (opts?.transform) stream._transform = opts.transform.bind(stream);
    if (opts?.flush) stream._flush = opts.flush.bind(stream);
  }
  const _initTransformStream = (stream, opts) => {
    _initDuplex(stream, opts);
    _initTransform(stream, opts);
  };

  class TransformClass extends Duplex {
    constructor(opts) {
      super(opts);
      _initTransform(this, opts);
    }

    _transform(chunk, encoding, callback) { callback(null, chunk); }
    _flush(callback) { callback(); }

    _write(chunk, encoding, callback) {
      this._transform(chunk, encoding, (err, data) => {
        if (err) return callback(err);
        if (data !== null && data !== undefined) this.push(data);
        callback();
      });
    }

    _final(callback) {
      this._flush((err, data) => {
        if (err) return callback(err);
        if (data !== null && data !== undefined) this.push(data);
        this.push(null);
        callback();
      });
    }
  }

  const Transform = __legacyConstructor(TransformClass, 'Transform', _initTransformStream);

  // ── PassThrough ─────────────────────────────────────────────────────
  class PassThroughClass extends Transform {
    constructor(opts) { super(opts); }
    _transform(chunk, encoding, callback) { callback(null, chunk); }
  }
  const PassThrough = __legacyConstructor(PassThroughClass, 'PassThrough', _initTransformStream);

  // ── pipeline ────────────────────────────────────────────────────────
  function pipeline(...args) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    // pipeline(streams[, callback]), as Node takes it too (axios passes its
    // response and decompressor so); a copy, since the adapting below
    // replaces entries.
    const streams = args.length === 1 && Array.isArray(args[0]) ? [...args[0]] : args;
    if (streams.length < 2) {
      if (callback) callback(new Error('pipeline requires at least 2 streams'));
      return streams[0];
    }
    let error = null;
    // Adapt non-Node sources (web ReadableStream from fetch, async
    // iterables) to a Node Readable so `.pipe` exists. Node's pipeline
    // performs the same normalization via Readable.from/fromWeb.
    for (let i = 0; i < streams.length; i++) {
      const s = streams[i];
      if (s && typeof s.pipe !== 'function') {
        if (typeof s.getReader === 'function') streams[i] = Readable.fromWeb(s);
        else if (s[Symbol.asyncIterator] || s[Symbol.iterator]) streams[i] = Readable.from(s);
      }
    }
    for (let i = 0; i < streams.length - 1; i++) {
      const src = streams[i];
      const dst = streams[i + 1];
      src.pipe(dst);
      src.on('error', (e) => { error = e; dst.destroy(e); });
    }
    const last = streams[streams.length - 1];
    last.on('finish', () => { if (callback) callback(error); });
    last.on('error', (e) => { if (!error) { error = e; } if (callback) callback(error); });
    return last;
  }

  // ── finished ────────────────────────────────────────────────────────
  function finished(stream, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    const onFinish = () => { cleanup(); if (callback) callback(null); };
    const onEnd = () => { cleanup(); if (callback) callback(null); };
    const onError = (err) => { cleanup(); if (callback) callback(err); };
    const onClose = () => { cleanup(); if (callback) callback(null); };
    stream.on('finish', onFinish);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);
    function cleanup() {
      stream.off('finish', onFinish);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('close', onClose);
    }
    return cleanup;
  }

  // Real Node's `require('stream')` IS the legacy `Stream` constructor
  // (a function extending EventEmitter), carrying Readable/Writable/etc.
  // as own properties. Userland relies on this in two ways:
  //   - `class X extends require('stream')` / `util.inherits(X, stream)`
  //     (minipass — bundled by degit/create-cloudflare — does
  //     `class Minipass extends Stream__default['default']`).
  //   - `require('stream').prototype` for prototype chaining
  //     (readable-stream@2 _stream_writable.js, send/index.js).
  // A plain namespace object satisfies neither: it is not a constructor,
  // so `class extends` throws "Class extends value is not a constructor".
  // Make the export the Stream constructor itself with the named exports
  // attached, mirroring Node exactly. Like Node's (lib/internal/streams/
  // legacy.js) it is a function, not a class: send (express.static) does
  // `Stream.call(this)`, which a class constructor refuses.
  function Stream(opts) { __eventsMod.call(this, opts); }
  Object.setPrototypeOf(Stream.prototype, __eventsMod.prototype);
  Object.setPrototypeOf(Stream, __eventsMod);
  Stream.prototype.pipe = function pipe(dest, opts) {
    const src = this;
    src.on('data', (chunk) => { dest.write(chunk); });
    src.on('end', () => { if (!opts || opts.end !== false) dest.end(); });
    return dest;
  };
  // ── stream state introspection (node:stream named helpers) ─────────
  // Modern libraries (e.g. those bundled by create-cloudflare) call these
  // off the stream module. They read the public stream state flags.
  const isErrored = (s) => !!(s && (s.errored || (s._readableState && s._readableState.errored) || (s._writableState && s._writableState.errored)));
  const isReadable = (s) => !!(s && s.readable && !(s._readableState && s._readableState.endEmitted));
  const isWritable = (s) => !!(s && s.writable && !(s._writableState && s._writableState.finished));
  const isDisturbed = (s) => !!(s && (s.readableDidRead || (s._readableState && (s._readableState.dataEmitted || s._readableState.endEmitted))));
  const addAbortSignal = (signal, stream) => {
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => { stream.destroy(new Error('AbortError')); }, { once: true });
    }
    return stream;
  };

  const __streamMod = Object.assign(Stream, {
    Readable, Writable, Duplex, Transform, PassThrough,
    Stream,
    pipeline, finished,
    isErrored, isReadable, isWritable, isDisturbed, addAbortSignal,
    // Aliases for compatibility
    _Readable: Readable, _Writable: Writable, _Transform: Transform,
  });
  return __streamMod;
})();


// ═══════════════════════════════════════════════════════════════════════
// ──  node:sqlite module (sql.js-backed) ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ── node:sqlite shim (sql.js-backed, Nimbus) ────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

const __sqliteMod = (() => {
  function __unsupported(name) {
    return new Error("node:sqlite: " + name + " not supported");
  }

  // Engine boot, run lazily on the FIRST DatabaseSync open — or eagerly
  // via __nimbusInitSqlite by a caller that KNOWS it will open a DB (the
  // opencode serve facet: it serves sessions from the DB within its first
  // requests, and booting eagerly there keeps its long-proven boot shape —
  // removing the eager boot live-wedged serve's handler-time chunk import
  // of server/server, the #20 shape-sensitivity, 2026-07-21).
  //
  // The sql.js glue is evaluated via `new Function` at MODULE-INIT time
  // (generateSqliteFacetPreamble, prepended to the facet) because workerd
  // disallows code-generation-from-strings at request time; by now
  // globalThis.__nimbusSqlJsFactory is the prepared initSqlJs factory. We
  // only call it + instantiate the pre-compiled WebAssembly.Module (both
  // allowed at request time). Synchronicity is structural, not lucky:
  // sql.js uses the caller's config object AS the Emscripten Module, and
  // with a synchronous `instantiateWasm` hook (and no `setStatus`)
  // Emscripten runs runtime init + postRun in the same tick — so the
  // config/Module closure carries the ready { Database } namespace before
  // this function returns, which is exactly what node:sqlite's
  // synchronous constructor needs. Fail loud if that structure ever
  // changes in a sql.js upgrade.
  function __getSQL() {
    if (globalThis.__nimbusSQL) return globalThis.__nimbusSQL;
    const wasmModule = globalThis.__nimbusSqliteWasmModule;
    if (!wasmModule) {
      throw new Error(
        "node:sqlite: sql.js wasm module not attached to this facet " +
        "(internal: __nimbusSqliteWasmModule missing — module-map wiring bug)"
      );
    }
    const initSqlJs = globalThis.__nimbusSqlJsFactory;
    if (typeof initSqlJs !== "function") {
      throw new Error(
        "node:sqlite: sql.js factory not prepared at module init " +
        "(internal: __nimbusSqlJsFactory missing — facet-preamble wiring bug)"
      );
    }
    const engine = {
      // Feed the pre-compiled WebAssembly.Module to sql.js so it never
      // calls WebAssembly.compile(bytes) (blocked in facets at request
      // time). The hook gets the imports object and a callback; we
      // instantiate synchronously and invoke it.
      instantiateWasm(imports, successCallback) {
        const instance = new WebAssembly.Instance(wasmModule, imports);
        successCallback(instance, wasmModule);
        return instance.exports;
      },
    };
    let ready = false;
    engine.postRun = [() => { ready = true; }];
    initSqlJs(engine);
    if (!ready || typeof engine.Database !== "function") {
      throw new Error(
        "node:sqlite: sql.js did not complete synchronous init " +
        "(internal: the glue's Module/postRun structure changed — see sqlite-shim.ts __getSQL)"
      );
    }
    globalThis.__nimbusSQL = engine;
    return engine;
  }

  // Idempotent eager boot for callers that will certainly open a DB.
  // Same engine, same failure modes as the lazy path — just earlier.
  globalThis.__nimbusInitSqlite = async function __nimbusInitSqlite() {
    return __getSQL();
  };

  // Strip a leading slash so __vfsBundle keys (stored slash-stripped)
  // line up with absolute paths the user passes.
  function __vfsKey(p) {
    return String(p).replace(/^\/+/, "");
  }

  // Synchronously read the existing DB bytes for a file-backed database
  // from the facet's startup VFS snapshot, if present. Returns a
  // Uint8Array or null. Pure in-memory and :memory: databases never read.
  function __readDbBytes(path) {
    let bundle;
    try { bundle = __vfsBundle; } catch { bundle = null; }
    if (!bundle) return null;
    const direct = bundle[path];
    const cell = direct !== undefined ? direct : bundle[__vfsKey(path)];
    if (cell === undefined || cell === null) return null;
    if (cell instanceof Uint8Array) return cell.length ? cell : null;
    if (typeof cell === "string") {
      // A SQLite file would normally be stored as a Uint8Array cell, but
      // an empty/zero-length placeholder may round-trip as "". Treat
      // non-empty strings as latin1 bytes for completeness.
      if (cell.length === 0) return null;
      const bytes = new Uint8Array(cell.length);
      for (let i = 0; i < cell.length; i++) bytes[i] = cell.charCodeAt(i) & 0xff;
      return bytes;
    }
    return null;
  }

  class StatementSync {
    constructor(db, sql) {
      this.__db = db;
      this.__sql = sql;
      this.__readBigInts = false;
      this.__returnArrays = false;
    }

    setReadBigInts(enabled) {
      this.__readBigInts = !!enabled;
      return this;
    }

    setReturnArrays(enabled) {
      this.__returnArrays = !!enabled;
      return this;
    }

    setAllowBareNamedParameters() {
      throw __unsupported("StatementSync.prototype.setAllowBareNamedParameters");
    }

    // sql.js stmt API drives all reads/writes. We prepare a fresh stmt
    // per call and free it deterministically so no wasm handle leaks.
    __prepare(params) {
      const handle = this.__db.__raw;
      if (!handle) throw new Error("node:sqlite: database is closed");
      const stmt = handle.prepare(this.__sql);
      if (params.length > 0) {
        stmt.bind(__bindParams(params));
      }
      return stmt;
    }

    all(...params) {
      const stmt = this.__prepare(params);
      const rows = [];
      try {
        const cols = stmt.getColumnNames();
        while (stmt.step()) {
          rows.push(this.__shapeRow(stmt, cols));
        }
      } finally {
        stmt.free();
      }
      return rows;
    }

    get(...params) {
      const stmt = this.__prepare(params);
      try {
        if (!stmt.step()) return undefined;
        const cols = stmt.getColumnNames();
        return this.__shapeRow(stmt, cols);
      } finally {
        stmt.free();
      }
    }

    run(...params) {
      const handle = this.__db.__raw;
      if (!handle) throw new Error("node:sqlite: database is closed");
      const stmt = this.__prepare(params);
      try {
        stmt.step();
      } finally {
        stmt.free();
      }
      this.__db.__dirty = true;
      const changes = handle.getRowsModified();
      const lastRowId = __lastInsertRowid(handle);
      return {
        changes: this.__readBigInts ? BigInt(changes) : changes,
        lastInsertRowid: this.__readBigInts ? BigInt(lastRowId) : lastRowId,
      };
    }

    iterate() {
      throw __unsupported("StatementSync.prototype.iterate");
    }

    columns() {
      throw __unsupported("StatementSync.prototype.columns");
    }

    __shapeRow(stmt, cols) {
      const raw = stmt.get();
      if (this.__returnArrays) {
        return raw.map((v) => this.__coerce(v));
      }
      const obj = {};
      for (let i = 0; i < cols.length; i++) {
        obj[cols[i]] = this.__coerce(raw[i]);
      }
      return obj;
    }

    // sql.js returns numbers for INTEGER/REAL, strings for TEXT,
    // Uint8Array for BLOB, null for NULL. node:sqlite returns bigint for
    // INTEGER columns when setReadBigInts(true); otherwise number.
    __coerce(value) {
      if (this.__readBigInts && typeof value === "number" && Number.isInteger(value)) {
        return BigInt(value);
      }
      return value;
    }
  }

  function __bindParams(params) {
    // node:sqlite accepts positional params (array) and named params via a
    // single object argument. sql.js bind() takes an array (positional) or
    // an object keyed by ":name"/"@name"/"$name".
    if (params.length === 1 && __isNamedParamObject(params[0])) {
      return __normalizeNamedParams(params[0]);
    }
    return params.map(__coerceBindValue);
  }

  function __isNamedParamObject(v) {
    return (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !(v instanceof Uint8Array) &&
      !(v instanceof ArrayBuffer)
    );
  }

  function __normalizeNamedParams(obj) {
    const out = {};
    for (const key of Object.keys(obj)) {
      const prefixed = /^[:@$]/.test(key) ? key : ":" + key;
      out[prefixed] = __coerceBindValue(obj[key]);
    }
    return out;
  }

  function __coerceBindValue(v) {
    if (typeof v === "bigint") {
      // sql.js binds JS numbers; SQLite INTEGER is 64-bit. Within the
      // safe-integer range we pass a number; beyond it we throw rather
      // than silently lose precision.
      if (v >= -9007199254740991n && v <= 9007199254740991n) return Number(v);
      throw new Error("node:sqlite: bigint parameter exceeds safe-integer range");
    }
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return v;
  }

  function __lastInsertRowid(handle) {
    // sql.js does not expose last_insert_rowid() directly; query it.
    const stmt = handle.prepare("SELECT last_insert_rowid()");
    try {
      stmt.step();
      const row = stmt.get();
      return row && row.length ? Number(row[0]) : 0;
    } finally {
      stmt.free();
    }
  }

  class DatabaseSync {
    constructor(path, options) {
      const opts = options || {};
      this.__path = typeof path === "string" ? path : "";
      this.__memory = !this.__path || this.__path === ":memory:";
      this.__open = false;
      this.__raw = null;
      this.__dirty = false;
      const open = opts.open === undefined ? true : !!opts.open;
      if (open) this.__doOpen();
    }

    __doOpen() {
      const SQL = __getSQL();
      const bytes = this.__memory ? null : __readDbBytes(this.__path);
      this.__raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
      this.__open = true;
    }

    open() {
      if (this.__open) return;
      this.__doOpen();
    }

    get isOpen() {
      return this.__open;
    }

    prepare(sql) {
      if (!this.__open) throw new Error("node:sqlite: database is not open");
      return new StatementSync(this, String(sql));
    }

    exec(sql) {
      if (!this.__open) throw new Error("node:sqlite: database is not open");
      // sql.js run() executes one-or-more statements with no result rows;
      // PRAGMAs are honored against the single in-memory connection (or
      // no-op where not meaningful for an in-memory whole-DB snapshot).
      this.__raw.run(String(sql));
      this.__dirty = true;
    }

    function() {
      throw __unsupported("DatabaseSync.prototype.function");
    }

    aggregate() {
      throw __unsupported("DatabaseSync.prototype.aggregate");
    }

    createSession() {
      throw __unsupported("DatabaseSync.prototype.createSession");
    }

    applyChangeset() {
      throw __unsupported("DatabaseSync.prototype.applyChangeset");
    }

    enableLoadExtension() {
      throw __unsupported("DatabaseSync.prototype.enableLoadExtension");
    }

    loadExtension() {
      throw __unsupported("DatabaseSync.prototype.loadExtension");
    }

    // Flush the in-memory DB image back to the live VFS via the async
    // supervisor bridge. Used by close() and as a public checkpoint
    // boundary. Returns a promise pushed onto __pendingIO so the facet
    // drains it before isolate teardown.
    __flush() {
      if (this.__memory || !this.__open || !this.__dirty) return Promise.resolve();
      let supervisor;
      try { supervisor = __supervisor; } catch { supervisor = null; }
      if (!supervisor || typeof supervisor.writeFile !== "function") {
        return Promise.resolve();
      }
      const bytes = this.__raw.export();
      this.__dirty = false;
      const task = Promise.resolve()
        .then(() => supervisor.writeFile(this.__path, bytes))
        .catch(() => {});
      try { __pendingIO.push(task); } catch {}
      return task;
    }

    close() {
      if (!this.__open) return;
      // Capture the export + queue the flush BEFORE freeing the handle.
      this.__flush();
      try { this.__raw.close(); } catch {}
      this.__raw = null;
      this.__open = false;
    }

    [Symbol.dispose]() {
      this.close();
    }
  }

  return { DatabaseSync, StatementSync };
})();


// ═══════════════════════════════════════════════════════════════════════
// ──  undici (npm) — mapped onto the platform HTTP stack ─────────────
// ═══════════════════════════════════════════════════════════════════════

const __undiciMod = (() => {
  // The patched global fetch, captured now. Captured rather than dereferenced
  // per call so that user code doing `globalThis.fetch = undici.fetch` — a real
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
  // Real classes, because consumers branch on `instanceof` and on `err.code`.
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
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return body;
    // A Node Readable (or any async iterable) — drain it into the request.
    if (typeof body[Symbol.asyncIterator] === "function") return collect(body);
    throw new errors.InvalidArgumentError("undici: unsupported request body type");
  };

  /**
   * undici's response body: a Node Readable that also carries the WHATWG body
   * mixin. Both surfaces read the same stream, so consuming one marks the body
   * used for the other — matching undici, where `body.text()` after a manual
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
   * `maxRedirections` (default 0 — do NOT follow) is honoured exactly rather
   * than approximated by fetch's own follow limit.
   */
  const request = async (url, options) => {
    const opts = options || {};
    assertInertDispatcher(opts.dispatcher, "request({ dispatcher })");
    let target = targetUrl(url, opts);
    const method = String(opts.method || "GET").toUpperCase();
    const headers = requestHeaders(opts.headers);
    const body = await requestBody(opts.body);
    let budget = Number(opts.maxRedirections) || 0;

    let response;
    for (;;) {
      response = await __fetch(target.href, {
        method,
        headers,
        body,
        signal: opts.signal || undefined,
        redirect: "manual",
      });
      if (budget <= 0) break;
      const location = response.headers.get("location");
      if (response.status < 300 || response.status > 399 || !location) break;
      budget -= 1;
      target = new URL(location, target);
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
  // Interop: undici is CJS with an `export default Undici`. The ESM→CJS
  // pre-pass reads `.default` for `import undici from 'undici'`; `.Undici`
  // mirrors the package's own self-reference.
  mod.default = mod;
  mod.Undici = mod;
  return mod;
})();


// ═══════════════════════════════════════════════════════════════════════
// ──  util module ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// util.inspect, format and formatWithOptions are Node v22.22.3's own
// lib/internal/util/inspect.js (node-inspect-source.ts), evaluated the first
// time a program formats a value, over what node-inspect-host.ts gives it in
// place of Node's internals: what a program prints of a value, through util
// or console, is what Node prints (node-inspect-matches-node,
// console-format-matches-node-workerd). workerd's own node:util gives
// util.types, and reads what only V8's internals hold (a promise's state,
// a proxy's target) as values, through its inspect. consola's FancyReporter
// calls formatWithOptions directly (nuxi init).
const __realUtil = typeof __real_util !== "undefined"
  ? (__real_util.default ?? __real_util) : globalThis.process.getBuiltinModule("util");
let __nimbusNodeInspectExports = null;
function __nimbusNodeInspect() {
  if (__nimbusNodeInspectExports !== null) return __nimbusNodeInspectExports;
  // The East Asian Wide and Fullwidth ranges, ascending: [first, last] pairs.
  const wide = "1100-115f,231a-231b,2329-232a,23e9-23ec,23f0,23f3,25fd-25fe,2614-2615,2630-2637,2648-2653,267f,268a-268f,2693,26a1,26aa-26ab,26bd-26be,26c4-26c5,26ce,26d4,26ea,26f2-26f3,26f5,26fa,26fd,2705,270a-270b,2728,274c,274e,2753-2755,2757,2795-2797,27b0,27bf,2b1b-2b1c,2b50,2b55,2e80-2e99,2e9b-2ef3,2f00-2fd5,2ff0-303e,3041-3096,3099-30ff,3105-312f,3131-318e,3190-31e5,31ef-321e,3220-3247,3250-a48c,a490-a4c6,a960-a97c,ac00-d7a3,f900-faff,fe10-fe19,fe30-fe52,fe54-fe66,fe68-fe6b,ff01-ff60,ffe0-ffe6,16fe0-16fe4,16ff0-16ff6,17000-18cd5,18cff-18d1e,18d80-18df2,1aff0-1aff3,1aff5-1affb,1affd-1affe,1b000-1b122,1b132,1b150-1b152,1b155,1b164-1b167,1b170-1b2fb,1d300-1d356,1d360-1d376,1f004,1f0cf,1f18e,1f191-1f19a,1f200-1f202,1f210-1f23b,1f240-1f248,1f250-1f251,1f260-1f265,1f300-1f320,1f32d-1f335,1f337-1f37c,1f37e-1f393,1f3a0-1f3ca,1f3cf-1f3d3,1f3e0-1f3f0,1f3f4,1f3f8-1f43e,1f440,1f442-1f4fc,1f4ff-1f53d,1f54b-1f54e,1f550-1f567,1f57a,1f595-1f596,1f5a4,1f5fb-1f64f,1f680-1f6c5,1f6cc,1f6d0-1f6d2,1f6d5-1f6d8,1f6dc-1f6df,1f6eb-1f6ec,1f6f4-1f6fc,1f7e0-1f7eb,1f7f0,1f90c-1f93a,1f93c-1f945,1f947-1f9ff,1fa70-1fa7c,1fa80-1fa8a,1fa8e-1fac6,1fac8,1facd-1fadc,1fadf-1faea,1faef-1faf8,20000-2fffd,30000-3fffd".split(",").flatMap((range) => {
    const [first, last = first] = range.split("-");
    return [parseInt(first, 16), parseInt(last, 16)];
  });
  __nimbusNodeInspectExports = (function createNodeInspect(platform) {
  "use strict";
  const platformUtil = platform.util;
  const types = platformUtil.types;
  const primordials = {};
  platform.primordialsOf(primordials, globalThis);
  const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
  let lazyInspect;

  // lib/internal/errors.js: the errors inspect.js and its validators raise.
  function nodeError(Base, code, message) {
    const error = new Base(message);
    Object.defineProperty(error, "code", { value: code, enumerable: true, writable: true, configurable: true });
    Object.defineProperty(error, "toString", {
      value() { return this.name + " [" + code + "]: " + this.message; }, writable: true, configurable: true,
    });
    return error;
  }
  function determineSpecificType(value) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    switch (typeof value) {
      case "bigint": return "type bigint (" + value + "n)";
      case "number":
        if (value === 0) return 1 / value === -Infinity ? "type number (-0)" : "type number (0)";
        if (value !== value) return "type number (NaN)";
        if (value === Infinity) return "type number (Infinity)";
        if (value === -Infinity) return "type number (-Infinity)";
        return "type number (" + value + ")";
      case "boolean": return value ? "type boolean (true)" : "type boolean (false)";
      case "symbol": return "type symbol (" + String(value) + ")";
      case "function": return "function " + value.name;
      case "object":
        if (value.constructor && "name" in value.constructor) return "an instance of " + value.constructor.name;
        return lazyInspect.inspect(value, { depth: -1 });
      case "string": {
        const text = value.length > 28 ? value.slice(0, 25) + "..." : value;
        if (text.indexOf("'") === -1) return "type string ('" + text + "')";
        return "type string (" + JSON.stringify(text) + ")";
      }
      default: {
        let inspected = lazyInspect.inspect(value, { colors: false });
        if (inspected.length > 28) inspected = inspected.slice(0, 25) + "...";
        return "type " + typeof value + " (" + inspected + ")";
      }
    }
  }
  // ERR_INVALID_ARG_TYPE for the one type each validator here expects.
  function invalidArgType(name, type, actual) {
    const kind = name.includes(".") ? "property" : "argument";
    return nodeError(TypeError, "ERR_INVALID_ARG_TYPE",
      "The \"" + name + "\" " + kind + " must be of type " + type + ". Received " + determineSpecificType(actual));
  }
  let maxStackErrorName;
  let maxStackErrorMessage;
  function isStackOverflowError(err) {
    if (maxStackErrorMessage === undefined) {
      try {
        function overflowStack() { overflowStack(); }
        overflowStack();
      } catch (e) {
        maxStackErrorMessage = e.message;
        maxStackErrorName = e.name;
      }
    }
    return !!err && err.name === maxStackErrorName && err.message === maxStackErrorMessage;
  }
  function assert(value, message) {
    if (!value) {
      throw nodeError(Error, "ERR_INTERNAL_ASSERTION", message ?? "This is caused by either a bug in Node.js or incorrect usage of Node.js internals.\nPlease open an issue with this stack trace at https://github.com/nodejs/node/issues\n");
    }
  }
  assert.fail = (message) => assert(false, message);

  // lib/internal/validators.js
  const kValidateObjectNone = 0;
  const kValidateObjectAllowNullable = 1 << 0;
  const kValidateObjectAllowArray = 1 << 1;
  const kValidateObjectAllowFunction = 1 << 2;
  function validateObject(value, name, options = kValidateObjectNone) {
    if (options === kValidateObjectNone) {
      if (value === null || Array.isArray(value) || typeof value !== "object") throw invalidArgType(name, "object", value);
      return;
    }
    if ((kValidateObjectAllowNullable & options) === 0 && value === null) throw invalidArgType(name, "object", value);
    if ((kValidateObjectAllowArray & options) === 0 && Array.isArray(value)) throw invalidArgType(name, "object", value);
    const throwOnFunction = (kValidateObjectAllowFunction & options) === 0;
    if (typeof value !== "object" && (throwOnFunction || typeof value !== "function")) throw invalidArgType(name, "object", value);
  }
  function validateString(value, name) {
    if (typeof value !== "string") throw invalidArgType(name, "string", value);
  }

  // lib/internal/util.js
  const colorRegExp = /\u001b\[\d\d?m/g;
  const internalUtil = {
    customInspectSymbol,
    isError: (e) => types.isNativeError(e) || e instanceof Error,
    join(output, separator) {
      let str = "";
      if (output.length !== 0) {
        const lastIndex = output.length - 1;
        for (let i = 0; i < lastIndex; i++) {
          str += output[i];
          str += separator;
        }
        str += output[lastIndex];
      }
      return str;
    },
    removeColors: (str) => String.prototype.replace.call(str, colorRegExp, ""),
  };

  // THE BINDING's V8 slots (a promise's state and result, a proxy's target
  // and handler, an iterator's and a weak collection's entries) are
  // platform.slots', after an intrinsic brand check: values, which
  // inspect.js formats itself.
  const slots = platform.slots;

  // V8's names (Object::GetConstructorName) for objects inspect.js finds no named constructor for.
  const builtinNames = [
    ["isMap", "Map"], ["isSet", "Set"], ["isWeakMap", "WeakMap"], ["isWeakSet", "WeakSet"], ["isDate", "Date"],
    ["isRegExp", "RegExp"], ["isPromise", "Promise"], ["isNativeError", "Error"], ["isArrayBuffer", "ArrayBuffer"],
    ["isSharedArrayBuffer", "SharedArrayBuffer"], ["isDataView", "DataView"], ["isNumberObject", "Number"],
    ["isStringObject", "String"], ["isBooleanObject", "Boolean"], ["isBigIntObject", "BigInt"], ["isSymbolObject", "Symbol"],
  ];
  const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
  const isArrayIndex = (key) => /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;
  const utilBinding = {
    constants: { ALL_PROPERTIES: 0, ONLY_ENUMERABLE: 2, kPending: 0, kRejected: 2 },
    getOwnNonIndexProperties(object, filter) {
      // An object's own keys list its array indices first, ascending
      // (OrdinaryOwnPropertyKeys, and an array's, a typed array's and a
      // String object's alike): the rest start where they end.
      const all = Reflect.ownKeys(object);
      let low = 0;
      let high = all.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (typeof all[mid] === "string" && isArrayIndex(all[mid])) low = mid + 1;
        else high = mid;
      }
      const keys = [];
      for (let i = low; i < all.length; i++) {
        const key = all[i];
        if (filter === 2 && !Object.prototype.propertyIsEnumerable.call(object, key)) continue;
        keys.push(key);
      }
      return keys;
    },
    getProxyDetails: (value, showProxy) => (types.isProxy(value) ? slots.getProxyDetails(value, showProxy) : undefined),
    getPromiseDetails: (promise) => slots.getPromiseDetails(promise),
    // As inspect.js asks: a weak collection's entries alone, an iterator's with whether they pair.
    previewEntries: (...args) => Reflect.apply(slots.previewEntries, slots, args),
    getConstructorName(value) {
      if (Array.isArray(value)) return "Array";
      if (types.isTypedArray(value)) return String(Reflect.apply(typedArrayTag, value, []));
      for (const [test, name] of builtinNames) if (types[test](value)) return name;
      return typeof value === "function" ? "Function" : "Object";
    },
    getExternalValue: () => 0n,
  };

  // src/node_i18n.cc GetStringWidth, as Node built with ICU counts columns:
  // an East Asian Wide or Fullwidth character two, a default-emoji-
  // presentation character two, a control, format character, enclosing or
  // nonspacing mark or emoji modifier none (SOFT HYPHEN one), any other one.
  const zeroWidth = /^(?!\u00AD)[\p{Cc}\p{Cf}\p{Me}\p{Mn}\p{Emoji_Modifier}]$/u;
  const emojiPresentation = /^\p{Emoji_Presentation}$/u;
  const icuBinding = {
    getStringWidth(str) {
      let width = 0;
      for (const char of str) {
        if (platform.eastAsianWide(char.codePointAt(0)) || emojiPresentation.test(char)) width += 2;
        else if (!zeroWidth.test(char)) width += 1;
      }
      return width;
    },
  };

  function evaluate() {
    const modules = {
      "internal/util": internalUtil,
      "internal/errors": { isStackOverflowError },
      "internal/util/types": types,
      "internal/assert": assert,
      // Node's own modules, whose frames read node:<id> (colored grey).
      "internal/bootstrap/realm": { BuiltinModule: { exists: (id) => id.startsWith("internal/") || platform.builtinModules.includes(id) } },
      "internal/validators": { validateObject, validateString, kValidateObjectAllowArray },
      "internal/url": platform.url,
      buffer: { Buffer: platform.Buffer },
    };
    const bindings = { util: utilBinding, config: { hasIntl: true }, icu: icuBinding };
    const module = { exports: {} };
    platform.inspectOf(module.exports, (id) => modules[id], module, platform.process, (name) => bindings[name], inspectPrimordials);
    return module.exports;
  }
  // inspect.js reads primordials.globalThis once, for the names it counts as
  // built-in (showHidden shows a prototype's properties when its
  // constructor's name is not one): the capitalised globals there were when
  // Node loaded it, measured (node-inspect-source.ts NODE_BUILTIN_OBJECTS).
  const bootGlobal = Object.create(null);
  for (const name of platform.builtinObjects) bootGlobal[name] = globalThis[name];
  const inspectPrimordials = Object.create(null);
  for (const key of Reflect.ownKeys(primordials)) inspectPrimordials[key] = primordials[key];
  inspectPrimordials.globalThis = bootGlobal;
  const nodeInspect = evaluate();
  lazyInspect = nodeInspect;
  return nodeInspect;
})({
    util: __realUtil,
    // V8's slots, as workerd's inspect reaches them (node-inspect-host.ts THE BINDING).
    slots: (function createWorkerdSlots(util) {
  "use strict";
  const kPending = 0;
  const kFulfilled = 1;
  const kRejected = 2;
  const PROXY = "Proxy [Array]";
  const REVOKED = "<Revoked Proxy>";
  const arrayPrototype = Array.prototype;
  const customInspect = Symbol.for("nodejs.util.inspect.custom");
  const isProxy = util.types.isProxy;
  const escapes = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", "'": "'", "\\": "\\" };
  // The primitive workerd's formatPrimitive handed stylize as 'text', or null for any other mark.
  function primitiveOf(text, style) {
    switch (style) {
      case "number": return /^(?:-?(?:[0-9]|Infinity)|NaN$)/.test(text) ? { primitive: Number(text) } : null;
      case "bigint": return /^-?[0-9]+n$/.test(text) ? { primitive: BigInt(text.slice(0, -1)) } : null;
      case "boolean": return text === "true" || text === "false" ? { primitive: text === "true" } : null;
      case "undefined": return text === "undefined" ? { primitive: undefined } : null;
      case "null": return text === "null" ? { primitive: null } : null;
      case "symbol": return text.startsWith("Symbol(") && text.endsWith(")") ? { primitive: Symbol(text.slice(7, -1)) } : null;
      case "string":
        if (!/^['"\u0060]/.test(text)) return null;
        // strEscape's escapes: the meta table's and a lone surrogate's.
        return { primitive: text.slice(1, -1).replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[btnfr'\\])/g, (all, escape) => (escape.length > 1 ? String.fromCharCode(parseInt(escape.slice(1), 16)) : escapes[escape])) };
      default: return null;
    }
  }
  // What workerd's inspect of 'value' formats 'level' deep: objects,
  // primitives and marks, in order, and the text, for an iterator's brace.
  // Its 'seen' (the objects being formatted, outermost first) holds 'level'
  // of them then: a prototype's properties showHidden adds are formatted
  // before the value is pushed, and a proxy (showProxy) pushes none.
  // Array.prototype.includes is held only until workerd's first cycle
  // check, which no program code runs before; from then the hook is that
  // call's own 'seen' array's, where no program can reach it. What program
  // code still runs while workerd formats (the value's own toStringTag
  // getter, a proxy in its prototype chain) sees every built-in as it was,
  // and can inspect: a nested read holds and lets go of its own.
  function capture(value, options, level) {
    const events = [];
    const previous = arrayPrototype.includes;
    let seen = null;
    let referenced = false;
    const isObject = (item) => (typeof item === "object" && item !== null) || typeof item === "function";
    // An object 'level' deep is taken, and answered as seen: workerd marks
    // it circular and formats none of it, so no code of it runs (a getter,
    // a trap). Answered so for the value itself, workerd marks the value a
    // reference too, last.
    function record(item) {
      if (this !== seen || seen.length !== level || !isObject(item)) return Reflect.apply(previous, this, arguments);
      events.push({ object: item });
      if (item === value) referenced = true;
      return true;
    }
    const first = function includes(item) {
      arrayPrototype.includes = previous;
      seen = this;
      Object.defineProperty(seen, "includes", { value: record, writable: true, configurable: true });
      return Reflect.apply(record, this, arguments);
    };
    arrayPrototype.includes = first;
    let text;
    try {
      text = util.inspect(value, {
        showHidden: false, depth: 0, ...options,
        showProxy: true, colors: false, customInspect: false, getters: false, maxStringLength: Infinity,
        breakLength: Infinity, compact: 3, sorted: false, numericSeparator: false,
        stylize(mark, style) {
          if ((seen === null ? 0 : seen.length) === level) events.push(primitiveOf(mark, style) ?? { mark });
          return mark;
        },
      });
    } finally {
      if (arrayPrototype.includes === first) arrayPrototype.includes = previous;
    }
    if (referenced) events.pop();
    return { events, text };
  }
  // The values a slot holds, read from 'read(depth)' (capture's events),
  // each a value, a proxy (its parts, read a level deeper each time, until
  // none is left past the depth) or a revoked proxy. 'count' values, or as
  // many as the first read holds.
  function slotValues(read, count) {
    let nodes;
    for (let depth = 0; ; depth++) {
      const events = read(depth);
      let at = 0;
      let deeper = false;
      // A node 'r' levels in, as this read formats it ('known' from the last).
      const node = (known, r) => {
        if (known !== undefined && known.parts !== undefined) {
          if (r > depth) {
            if (events[at++]?.mark !== PROXY) throw unreadable("a proxy");
            deeper = true;
            return known;
          }
          return { parts: [node(known.parts?.[0], r + 1), node(known.parts?.[1], r + 1)] };
        }
        const event = events[at++];
        if (event === undefined) throw unreadable("a value");
        if ("primitive" in event) return { value: event.primitive };
        if ("object" in event) {
          // Its own mark, past the depth.
          while (at < events.length && "mark" in events[at] && events[at].mark !== PROXY && events[at].mark !== REVOKED) at++;
          return { value: event.object };
        }
        if (event.mark === REVOKED) return { revoked: true };
        if (event.mark === PROXY) {
          deeper = true;
          return { parts: null };
        }
        throw unreadable("a mark (" + event.mark + ")");
      };
      const next = [];
      for (let i = 0; nodes === undefined ? at < events.length : i < nodes.length; i++) {
        next.push(node(nodes?.[i], 1));
        if (count !== undefined && nodes === undefined && next.length === count) break;
      }
      nodes = next;
      if (!deeper) return nodes.map(standIn);
      if (depth === 64) throw unreadable("a proxy 64 deep");
    }
  }
  // Stand-ins: a proxy among a slot's values, rebuilt over its target with a
  // handler of none of a program's traps, and the [target, handler] it
  // stands for (null, revoked). inspect.js never formats one as an object:
  // it asks getProxyDetails first, which unwraps it (below).
  const standIns = new WeakMap();
  function standIn(node) {
    if (node.revoked) {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      standIns.set(revocable.proxy, null);
      return revocable.proxy;
    }
    if (node.parts === undefined) return node.value;
    const parts = [standIn(node.parts[0]), standIn(node.parts[1])];
    const proxy = new Proxy(parts[0], {});
    standIns.set(proxy, parts);
    return proxy;
  }
  // What inspect.js formats for a proxy, showProxy off: its innermost target
  // (no stand-in is formatted as an object, nor any proxy trap run), or a
  // revoked proxy, which throws there as in Node.
  function innermostTarget(target) {
    while (standIns.get(target)) target = standIns.get(target)[0];
    return target;
  }
  // Whether inspect.js would find a custom inspect on 'object', read without
  // running a program's code; a proxy on the way may hold one.
  function reachesCustomInspect(object) {
    for (let at = object; at !== null; at = Object.getPrototypeOf(at)) {
      if (isProxy(at)) return true;
      const own = Object.getOwnPropertyDescriptor(at, customInspect);
      if (own !== undefined) return own.get !== undefined || typeof own.value === "function";
    }
    return false;
  }
  // Whether workerd formats 'holder' with none of a program's code run: no
  // proxy on its prototype chain (its constructor name is read there), and
  // no accessor for its Symbol.toStringTag, read as workerd reads it.
  function formatsInertly(holder) {
    let tag = false;
    for (let at = holder; at !== null; at = Object.getPrototypeOf(at)) {
      if (isProxy(at)) return false;
      const own = tag ? undefined : Object.getOwnPropertyDescriptor(at, Symbol.toStringTag);
      if (own === undefined) continue;
      if (own.get !== undefined || own.set !== undefined) return false;
      tag = true;
    }
    return true;
  }
  // What a slot whose holder cannot be read inertly shows (formatsInertly).
  function unknown(text) {
    return Object.freeze(Object.create(null, {
      [customInspect]: { value: (depth, options) => options.stylize(text, "special") },
      [Symbol.toStringTag]: { value: text },
    }));
  }
  const ITEMS_UNKNOWN = unknown("<items unknown>");
  const UNKNOWN = unknown("<unknown>");
  function unreadable(what) {
    return new Error("util.inspect: workerd's inspect did not hand over " + what + " in a V8 slot");
  }
  function getPromiseDetails(promise) {
    if (!formatsInertly(promise)) return [kFulfilled, UNKNOWN];
    const first = capture(promise, {}, 1);
    if (first.events.length > 0 && first.events[0].mark === "<pending>") return [kPending];
    const rejected = first.events.some((event) => event.mark === "<rejected>");
    // Its result, the first value formatted (before the promise's own properties).
    const [result] = slotValues((depth) => (depth === 0 ? first : capture(promise, { depth }, 1)).events, 1);
    return [rejected ? kRejected : kFulfilled, result];
  }
  function getProxyDetails(proxy, showProxy) {
    let parts = standIns.get(proxy);
    if (parts === undefined) {
      const first = capture(proxy, {}, 0);
      // Revoked itself: its one mark (a revoked target's is the first of two parts').
      if (first.events.length === 1 && first.events[0].mark === REVOKED) parts = null;
      else parts = slotValues((depth) => (depth === 0 ? first : capture(proxy, { depth }, 0)).events, 2);
    }
    if (parts === null) return showProxy ? [null, null] : null;
    if (showProxy) return parts;
    // inspect.js calls the target's custom inspect with the proxy as this: a
    // program's own proxy is that; a stand-in must never be, so the target of
    // one, if it has such a hook, is not shown (nor its constructor's checks run).
    const target = innermostTarget(parts[0]);
    return standIns.has(proxy) && !standIns.has(target) && reachesCustomInspect(target) ? UNKNOWN : target;
  }
  function previewEntries(value, isKeyValue) {
    if (!formatsInertly(value)) return isKeyValue === undefined ? [ITEMS_UNKNOWN] : [[ITEMS_UNKNOWN], false];
    // A weak collection's entries are what showHidden shows. The value's own
    // properties follow its entries: counted off by a read showing none.
    const options = { showHidden: isKeyValue === undefined };
    let text;
    const entries = slotValues((depth) => {
      const all = capture(value, { ...options, depth, maxArrayLength: Infinity }, 1);
      const own = capture(value, { ...options, depth, maxArrayLength: 0 }, 1).events;
      text ??= all.text;
      return all.events.slice(0, all.events.length - own.length);
    });
    if (isKeyValue === undefined) return entries;
    const pairs = /^[^{]*\[(?:Map|Set) Entries\] \{/.test(text);
    if (pairs && entries.length % 2 !== 0) throw unreadable("an iterator's pairs");
    return [entries, pairs];
  }
  return { getPromiseDetails, getProxyDetails, previewEntries };
})(__realUtil),
    Buffer: __BufferMod,
    url: { pathToFileURL: __urlMod.pathToFileURL, URL: __urlMod.URL },
    process: __processMod,
    builtinModules: __NodeModule.builtinModules,
    builtinObjects: ["Object","Function","Array","Number","Infinity","NaN","Boolean","String","Symbol","Date","Promise","RegExp","Error","AggregateError","EvalError","RangeError","ReferenceError","SyntaxError","TypeError","URIError","JSON","Math","Intl","ArrayBuffer","Atomics","Uint8Array","Int8Array","Uint16Array","Int16Array","Uint32Array","Int32Array","Float32Array","Float64Array","Uint8ClampedArray","BigUint64Array","BigInt64Array","DataView","Map","BigInt","Set","WeakMap","WeakSet","Proxy","Reflect","FinalizationRegistry","WeakRef"],
    eastAsianWide(code) {
      let low = 0;
      let high = wide.length / 2 - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (code < wide[2 * mid]) high = mid - 1;
        else if (code > wide[2 * mid + 1]) low = mid + 1;
        else return true;
      }
      return false;
    },
    primordialsOf: function (primordials, globalThis) {
'use strict';

/* eslint-disable node-core/prefer-primordials */

// This file subclasses and stores the JS builtins that come from the VM
// so that Node.js's builtin modules do not need to later look these up from
// the global proxy, which can be mutated by users.

// Use of primordials have sometimes a dramatic impact on performance, please
// benchmark all changes made in performance-sensitive areas of the codebase.
// See: https://github.com/nodejs/node/pull/38248

const {
  defineProperty: ReflectDefineProperty,
  getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
  ownKeys: ReflectOwnKeys,
} = Reflect;

// `uncurryThis` is equivalent to `func => Function.prototype.call.bind(func)`.
// It is using `bind.bind(call)` to avoid using `Function.prototype.bind`
// and `Function.prototype.call` after it may have been mutated by users.
const { apply, bind, call } = Function.prototype;
const uncurryThis = bind.bind(call);
primordials.uncurryThis = uncurryThis;

// `applyBind` is equivalent to `func => Function.prototype.apply.bind(func)`.
// It is using `bind.bind(apply)` to avoid using `Function.prototype.bind`
// and `Function.prototype.apply` after it may have been mutated by users.
const applyBind = bind.bind(apply);
primordials.applyBind = applyBind;

// Methods that accept a variable number of arguments, and thus it's useful to
// also create `${prefix}${key}Apply`, which uses `Function.prototype.apply`,
// instead of `Function.prototype.call`, and thus doesn't require iterator
// destructuring.
const varargsMethods = [
  // 'ArrayPrototypeConcat' is omitted, because it performs the spread
  // on its own for arrays and array-likes with a truthy
  // @@isConcatSpreadable symbol property.
  'ArrayOf',
  'ArrayPrototypePush',
  'ArrayPrototypeUnshift',
  // 'FunctionPrototypeCall' is omitted, since there's 'ReflectApply'
  // and 'FunctionPrototypeApply'.
  'MathHypot',
  'MathMax',
  'MathMin',
  'StringFromCharCode',
  'StringFromCodePoint',
  'StringPrototypeConcat',
  'TypedArrayOf',
];

function getNewKey(key) {
  return typeof key === 'symbol' ?
    `Symbol${key.description[7].toUpperCase()}${key.description.slice(8)}` :
    `${key[0].toUpperCase()}${key.slice(1)}`;
}

function copyAccessor(dest, prefix, key, { enumerable, get, set }) {
  ReflectDefineProperty(dest, `${prefix}Get${key}`, {
    __proto__: null,
    value: uncurryThis(get),
    enumerable,
  });
  if (set !== undefined) {
    ReflectDefineProperty(dest, `${prefix}Set${key}`, {
      __proto__: null,
      value: uncurryThis(set),
      enumerable,
    });
  }
}

function copyPropsRenamed(src, dest, prefix) {
  for (const key of ReflectOwnKeys(src)) {
    const newKey = getNewKey(key);
    const desc = ReflectGetOwnPropertyDescriptor(src, key);
    if ('get' in desc) {
      copyAccessor(dest, prefix, newKey, desc);
    } else {
      const name = `${prefix}${newKey}`;
      ReflectDefineProperty(dest, name, { __proto__: null, ...desc });
      if (varargsMethods.includes(name)) {
        ReflectDefineProperty(dest, `${name}Apply`, {
          __proto__: null,
          // `src` is bound as the `this` so that the static `this` points
          // to the object it was defined on,
          // e.g.: `ArrayOfApply` gets a `this` of `Array`:
          value: applyBind(desc.value, src),
        });
      }
    }
  }
}

function copyPropsRenamedBound(src, dest, prefix) {
  for (const key of ReflectOwnKeys(src)) {
    const newKey = getNewKey(key);
    const desc = ReflectGetOwnPropertyDescriptor(src, key);
    if ('get' in desc) {
      copyAccessor(dest, prefix, newKey, desc);
    } else {
      const { value } = desc;
      if (typeof value === 'function') {
        desc.value = value.bind(src);
      }

      const name = `${prefix}${newKey}`;
      ReflectDefineProperty(dest, name, { __proto__: null, ...desc });
      if (varargsMethods.includes(name)) {
        ReflectDefineProperty(dest, `${name}Apply`, {
          __proto__: null,
          value: applyBind(value, src),
        });
      }
    }
  }
}

function copyPrototype(src, dest, prefix) {
  for (const key of ReflectOwnKeys(src)) {
    const newKey = getNewKey(key);
    const desc = ReflectGetOwnPropertyDescriptor(src, key);
    if ('get' in desc) {
      copyAccessor(dest, prefix, newKey, desc);
    } else {
      const { value } = desc;
      if (typeof value === 'function') {
        desc.value = uncurryThis(value);
      }

      const name = `${prefix}${newKey}`;
      ReflectDefineProperty(dest, name, { __proto__: null, ...desc });
      if (varargsMethods.includes(name)) {
        ReflectDefineProperty(dest, `${name}Apply`, {
          __proto__: null,
          value: applyBind(value),
        });
      }
    }
  }
}

// Create copies of configurable value properties of the global object
[
  'Proxy',
  'globalThis',
].forEach((name) => {
  // eslint-disable-next-line no-restricted-globals
  primordials[name] = globalThis[name];
});

// Create copies of URI handling functions
[
  decodeURI,
  decodeURIComponent,
  encodeURI,
  encodeURIComponent,
].forEach((fn) => {
  primordials[fn.name] = fn;
});

// Create copies of legacy functions
[
  escape,
  eval,
  unescape,
].forEach((fn) => {
  primordials[fn.name] = fn;
});

// Create copies of the namespace objects
[
  'Atomics',
  'JSON',
  'Math',
  'Proxy',
  'Reflect',
].forEach((name) => {
  // eslint-disable-next-line no-restricted-globals
  copyPropsRenamed(globalThis[name], primordials, name);
});

// Create copies of intrinsic objects
[
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'FinalizationRegistry',
  'Float32Array',
  'Float64Array',
  'Function',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Map',
  'Number',
  'Object',
  'RangeError',
  'ReferenceError',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
].forEach((name) => {
  // eslint-disable-next-line no-restricted-globals
  const original = globalThis[name];
  primordials[name] = original;
  copyPropsRenamed(original, primordials, name);
  copyPrototype(original.prototype, primordials, `${name}Prototype`);
});


// Create copies of intrinsic objects that require a valid `this` to call
// static methods.
// Refs: https://www.ecma-international.org/ecma-262/#sec-promise.all
[
  'Promise',
].forEach((name) => {
  // eslint-disable-next-line no-restricted-globals
  const original = globalThis[name];
  primordials[name] = original;
  copyPropsRenamedBound(original, primordials, name);
  copyPrototype(original.prototype, primordials, `${name}Prototype`);
});

// Create copies of abstract intrinsic objects that are not directly exposed
// on the global object.
// Refs: https://tc39.es/ecma262/#sec-%typedarray%-intrinsic-object
[
  { name: 'TypedArray', original: Reflect.getPrototypeOf(Uint8Array) },
  { name: 'ArrayIterator', original: {
    prototype: Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]()),
  } },
  { name: 'StringIterator', original: {
    prototype: Reflect.getPrototypeOf(String.prototype[Symbol.iterator]()),
  } },
].forEach(({ name, original }) => {
  primordials[name] = original;
  // The static %TypedArray% methods require a valid `this`, but can't be bound,
  // as they need a subclass constructor as the receiver:
  copyPrototype(original, primordials, name);
  copyPrototype(original.prototype, primordials, `${name}Prototype`);
});

primordials.IteratorPrototype = Reflect.getPrototypeOf(primordials.ArrayIteratorPrototype);

/* eslint-enable node-core/prefer-primordials */

const {
  Array: ArrayConstructor,
  ArrayPrototypeForEach,
  ArrayPrototypeMap,
  ArrayPrototypePushApply,
  ArrayPrototypeSlice,
  FinalizationRegistry,
  FunctionPrototypeCall,
  Map,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectSetPrototypeOf,
  Promise,
  PromisePrototypeThen,
  PromiseResolve,
  ReflectApply,
  ReflectConstruct,
  ReflectGet,
  ReflectSet,
  RegExp,
  RegExpPrototype,
  RegExpPrototypeExec,
  RegExpPrototypeGetDotAll,
  RegExpPrototypeGetFlags,
  RegExpPrototypeGetGlobal,
  RegExpPrototypeGetHasIndices,
  RegExpPrototypeGetIgnoreCase,
  RegExpPrototypeGetMultiline,
  RegExpPrototypeGetSource,
  RegExpPrototypeGetSticky,
  RegExpPrototypeGetUnicode,
  Set,
  SymbolIterator,
  SymbolMatch,
  SymbolMatchAll,
  SymbolReplace,
  SymbolSearch,
  SymbolSpecies,
  SymbolSplit,
  WeakMap,
  WeakRef,
  WeakSet,
} = primordials;


/**
 * Creates a class that can be safely iterated over.
 *
 * Because these functions are used by `makeSafe`, which is exposed on the
 * `primordials` object, it's important to use const references to the
 * primordials that they use.
 * @template {Iterable} T
 * @template {*} TReturn
 * @template {*} TNext
 * @param {(self: T) => IterableIterator<T>} factory
 * @param {(...args: [] | [TNext]) => IteratorResult<T, TReturn>} next
 * @returns {Iterator<T, TReturn, TNext>}
 */
const createSafeIterator = (factory, next) => {
  class SafeIterator {
    constructor(iterable) {
      this._iterator = factory(iterable);
    }
    next() {
      return next(this._iterator);
    }
    [SymbolIterator]() {
      return this;
    }
  }
  ObjectSetPrototypeOf(SafeIterator.prototype, null);
  ObjectFreeze(SafeIterator.prototype);
  ObjectFreeze(SafeIterator);
  return SafeIterator;
};

primordials.SafeArrayIterator = createSafeIterator(
  primordials.ArrayPrototypeSymbolIterator,
  primordials.ArrayIteratorPrototypeNext,
);
primordials.SafeStringIterator = createSafeIterator(
  primordials.StringPrototypeSymbolIterator,
  primordials.StringIteratorPrototypeNext,
);

const copyProps = (src, dest) => {
  ArrayPrototypeForEach(ReflectOwnKeys(src), (key) => {
    if (!ReflectGetOwnPropertyDescriptor(dest, key)) {
      ReflectDefineProperty(
        dest,
        key,
        { __proto__: null, ...ReflectGetOwnPropertyDescriptor(src, key) });
    }
  });
};

/**
 * @type {typeof primordials.makeSafe}
 */
const makeSafe = (unsafe, safe) => {
  if (SymbolIterator in unsafe.prototype) {
    const dummy = new unsafe();
    let next; // We can reuse the same `next` method.

    ArrayPrototypeForEach(ReflectOwnKeys(unsafe.prototype), (key) => {
      if (!ReflectGetOwnPropertyDescriptor(safe.prototype, key)) {
        const desc = ReflectGetOwnPropertyDescriptor(unsafe.prototype, key);
        if (
          typeof desc.value === 'function' &&
          desc.value.length === 0 &&
          SymbolIterator in (FunctionPrototypeCall(desc.value, dummy) ?? {})
        ) {
          const createIterator = uncurryThis(desc.value);
          next ??= uncurryThis(createIterator(dummy).next);
          const SafeIterator = createSafeIterator(createIterator, next);
          desc.value = function() {
            return new SafeIterator(this);
          };
        }
        ReflectDefineProperty(safe.prototype, key, { __proto__: null, ...desc });
      }
    });
  } else {
    copyProps(unsafe.prototype, safe.prototype);
  }
  copyProps(unsafe, safe);

  ObjectSetPrototypeOf(safe.prototype, null);
  ObjectFreeze(safe.prototype);
  ObjectFreeze(safe);
  return safe;
};
primordials.makeSafe = makeSafe;

// Subclass the constructors because we need to use their prototype
// methods later.
primordials.SafeMap = makeSafe(
  Map,
  class SafeMap extends Map {},
);
primordials.SafeWeakMap = makeSafe(
  WeakMap,
  class SafeWeakMap extends WeakMap {},
);

primordials.SafeSet = makeSafe(
  Set,
  class SafeSet extends Set {},
);
primordials.SafeWeakSet = makeSafe(
  WeakSet,
  class SafeWeakSet extends WeakSet {},
);

primordials.SafeFinalizationRegistry = makeSafe(
  FinalizationRegistry,
  class SafeFinalizationRegistry extends FinalizationRegistry {},
);
primordials.SafeWeakRef = makeSafe(
  WeakRef,
  class SafeWeakRef extends WeakRef {},
);

const SafePromise = makeSafe(
  Promise,
  class SafePromise extends Promise {},
);

/**
 * Attaches a callback that is invoked when the Promise is settled (fulfilled or
 * rejected). The resolved value cannot be modified from the callback.
 * Prefer using async functions when possible.
 * @param {Promise<any>} thisPromise
 * @param {(() => void) | undefined | null} onFinally The callback to execute
 *        when the Promise is settled (fulfilled or rejected).
 * @returns {Promise} A Promise for the completion of the callback.
 */
primordials.SafePromisePrototypeFinally = (thisPromise, onFinally) =>
  // Wrapping on a new Promise is necessary to not expose the SafePromise
  // prototype to user-land.
  new Promise((a, b) =>
    new SafePromise((a, b) => PromisePrototypeThen(thisPromise, a, b))
      .finally(onFinally)
      .then(a, b),
  );

primordials.AsyncIteratorPrototype =
  primordials.ReflectGetPrototypeOf(
    primordials.ReflectGetPrototypeOf(
      async function* () {}).prototype);

const arrayToSafePromiseIterable = (promises, mapFn) =>
  new primordials.SafeArrayIterator(
    ArrayPrototypeMap(
      promises,
      (promise, i) =>
        new SafePromise((a, b) => PromisePrototypeThen(mapFn == null ? promise : mapFn(promise, i), a, b)),
    ),
  );

/**
 * @template T,U
 * @param {Array<T | PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<Awaited<U>[]>}
 */
primordials.SafePromiseAll = (promises, mapFn) =>
  // Wrapping on a new Promise is necessary to not expose the SafePromise
  // prototype to user-land.
  new Promise((a, b) =>
    SafePromise.all(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );

/**
 * Should only be used for internal functions, this would produce similar
 * results as `Promise.all` but without prototype pollution, and the return
 * value is not a genuine Array but an array-like object.
 * @template T,U
 * @param {ArrayLike<T | PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<ArrayLike<Awaited<U>>>}
 */
primordials.SafePromiseAllReturnArrayLike = (promises, mapFn) =>
  new Promise((resolve, reject) => {
    const { length } = promises;

    const returnVal = ArrayConstructor(length);
    ObjectSetPrototypeOf(returnVal, null);
    if (length === 0) resolve(returnVal);

    let pendingPromises = length;
    for (let i = 0; i < length; i++) {
      const promise = mapFn != null ? mapFn(promises[i], i) : promises[i];
      PromisePrototypeThen(PromiseResolve(promise), (result) => {
        returnVal[i] = result;
        if (--pendingPromises === 0) resolve(returnVal);
      }, reject);
    }
  });

/**
 * Should only be used when we only care about waiting for all the promises to
 * resolve, not what value they resolve to.
 * @template T,U
 * @param {ArrayLike<T | PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<void>}
 */
primordials.SafePromiseAllReturnVoid = (promises, mapFn) =>
  new Promise((resolve, reject) => {
    let pendingPromises = promises.length;
    if (pendingPromises === 0) resolve();
    const onFulfilled = () => {
      if (--pendingPromises === 0) {
        resolve();
      }
    };
    for (let i = 0; i < promises.length; i++) {
      const promise = mapFn != null ? mapFn(promises[i], i) : promises[i];
      PromisePrototypeThen(PromiseResolve(promise), onFulfilled, reject);
    }
  });

/**
 * @template T,U
 * @param {Array<T|PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<PromiseSettledResult<any>[]>}
 */
primordials.SafePromiseAllSettled = (promises, mapFn) =>
  // Wrapping on a new Promise is necessary to not expose the SafePromise
  // prototype to user-land.
  new Promise((a, b) =>
    SafePromise.allSettled(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );

/**
 * Should only be used when we only care about waiting for all the promises to
 * settle, not what value they resolve or reject to.
 * @template T,U
 * @param {ArrayLike<T|PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<void>}
 */
primordials.SafePromiseAllSettledReturnVoid = (promises, mapFn) => new Promise((resolve) => {
  let pendingPromises = promises.length;
  if (pendingPromises === 0) resolve();
  const onSettle = () => {
    if (--pendingPromises === 0) resolve();
  };
  for (let i = 0; i < promises.length; i++) {
    const promise = mapFn != null ? mapFn(promises[i], i) : promises[i];
    PromisePrototypeThen(PromiseResolve(promise), onSettle, onSettle);
  }
});

/**
 * @template T,U
 * @param {Array<T|PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<Awaited<U>>}
 */
primordials.SafePromiseAny = (promises, mapFn) =>
  // Wrapping on a new Promise is necessary to not expose the SafePromise
  // prototype to user-land.
  new Promise((a, b) =>
    SafePromise.any(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );

/**
 * @template T,U
 * @param {Array<T|PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<Awaited<U>>}
 */
primordials.SafePromiseRace = (promises, mapFn) =>
  // Wrapping on a new Promise is necessary to not expose the SafePromise
  // prototype to user-land.
  new Promise((a, b) =>
    SafePromise.race(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );


const {
  exec: OriginalRegExpPrototypeExec,
  [SymbolMatch]: OriginalRegExpPrototypeSymbolMatch,
  [SymbolMatchAll]: OriginalRegExpPrototypeSymbolMatchAll,
  [SymbolReplace]: OriginalRegExpPrototypeSymbolReplace,
  [SymbolSearch]: OriginalRegExpPrototypeSymbolSearch,
  [SymbolSplit]: OriginalRegExpPrototypeSymbolSplit,
} = RegExpPrototype;

class RegExpLikeForStringSplitting {
  #regex;
  constructor() {
    this.#regex = ReflectConstruct(RegExp, arguments);
  }

  get lastIndex() {
    return ReflectGet(this.#regex, 'lastIndex');
  }
  set lastIndex(value) {
    ReflectSet(this.#regex, 'lastIndex', value);
  }

  exec() {
    return ReflectApply(OriginalRegExpPrototypeExec, this.#regex, arguments);
  }
}
ObjectSetPrototypeOf(RegExpLikeForStringSplitting.prototype, null);

/**
 * @param {RegExp} pattern
 * @returns {RegExp}
 */
primordials.hardenRegExp = function hardenRegExp(pattern) {
  ObjectDefineProperties(pattern, {
    [SymbolMatch]: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeSymbolMatch,
    },
    [SymbolMatchAll]: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeSymbolMatchAll,
    },
    [SymbolReplace]: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeSymbolReplace,
    },
    [SymbolSearch]: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeSymbolSearch,
    },
    [SymbolSplit]: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeSymbolSplit,
    },
    constructor: {
      __proto__: null,
      configurable: true,
      value: {
        [SymbolSpecies]: RegExpLikeForStringSplitting,
      },
    },
    dotAll: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetDotAll(pattern),
    },
    exec: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeExec,
    },
    global: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetGlobal(pattern),
    },
    hasIndices: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetHasIndices(pattern),
    },
    ignoreCase: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetIgnoreCase(pattern),
    },
    multiline: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetMultiline(pattern),
    },
    source: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetSource(pattern),
    },
    sticky: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetSticky(pattern),
    },
    unicode: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetUnicode(pattern),
    },
  });
  ObjectDefineProperty(pattern, 'flags', {
    __proto__: null,
    configurable: true,
    value: RegExpPrototypeGetFlags(pattern),
  });
  return pattern;
};


/**
 * @param {string} str
 * @param {RegExp} regexp
 * @returns {number}
 */
primordials.SafeStringPrototypeSearch = (str, regexp) => {
  regexp.lastIndex = 0;
  const match = RegExpPrototypeExec(regexp, str);
  return match ? match.index : -1;
};

/**
 * Variadic functions with lots of arguments will cause stack overflow errors.
 * Use this function when `items` can be arbitrarily large, this function splits
 * it into chunks of size 2**16 making stack overflow less likely.
 * @param {Array<unknown>} arr
 * @param {Parameters<typeof Array.prototype.push>} items
 * @returns {ReturnType<typeof Array.prototype.push>}
 */
primordials.SafeArrayPrototypePushApply = (arr, items) => {
  let end = 0x10000;
  if (end < items.length) {
    let start = 0;
    do {
      ArrayPrototypePushApply(arr, ArrayPrototypeSlice(items, start, start = end));
      end += 0x10000;
    } while (end < items.length);
    items = ArrayPrototypeSlice(items, start);
  }
  return ArrayPrototypePushApply(arr, items);
};

ObjectSetPrototypeOf(primordials, null);
ObjectFreeze(primordials);

    },
    inspectOf: function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  AggregateError,
  AggregateErrorPrototype,
  Array,
  ArrayBuffer,
  ArrayBufferPrototype,
  ArrayIsArray,
  ArrayPrototype,
  ArrayPrototypeFilter,
  ArrayPrototypeForEach,
  ArrayPrototypeIncludes,
  ArrayPrototypeIndexOf,
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  ArrayPrototypePop,
  ArrayPrototypePush,
  ArrayPrototypePushApply,
  ArrayPrototypeSlice,
  ArrayPrototypeSort,
  ArrayPrototypeSplice,
  ArrayPrototypeUnshift,
  BigIntPrototypeValueOf,
  Boolean,
  BooleanPrototype,
  BooleanPrototypeValueOf,
  DataView,
  DataViewPrototype,
  Date,
  DatePrototype,
  DatePrototypeGetTime,
  DatePrototypeToISOString,
  DatePrototypeToString,
  Error,
  ErrorPrototype,
  ErrorPrototypeToString,
  Function,
  FunctionPrototype,
  FunctionPrototypeBind,
  FunctionPrototypeCall,
  FunctionPrototypeSymbolHasInstance,
  FunctionPrototypeToString,
  JSONStringify,
  Map,
  MapPrototype,
  MapPrototypeEntries,
  MapPrototypeGetSize,
  MathFloor,
  MathMax,
  MathMin,
  MathRound,
  MathSqrt,
  MathTrunc,
  Number,
  NumberIsFinite,
  NumberIsNaN,
  NumberParseFloat,
  NumberParseInt,
  NumberPrototype,
  NumberPrototypeToString,
  NumberPrototypeValueOf,
  Object,
  ObjectAssign,
  ObjectDefineProperty,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetOwnPropertyNames,
  ObjectGetOwnPropertySymbols,
  ObjectGetPrototypeOf,
  ObjectIs,
  ObjectKeys,
  ObjectPrototype,
  ObjectPrototypeHasOwnProperty,
  ObjectPrototypePropertyIsEnumerable,
  ObjectPrototypeToString,
  ObjectSeal,
  ObjectSetPrototypeOf,
  Promise,
  PromisePrototype,
  RangeError,
  RangeErrorPrototype,
  ReflectApply,
  ReflectOwnKeys,
  RegExp,
  RegExpPrototype,
  RegExpPrototypeExec,
  RegExpPrototypeSymbolReplace,
  RegExpPrototypeSymbolSplit,
  RegExpPrototypeToString,
  SafeMap,
  SafeSet,
  SafeStringIterator,
  Set,
  SetPrototype,
  SetPrototypeGetSize,
  SetPrototypeValues,
  String,
  StringPrototype,
  StringPrototypeCharCodeAt,
  StringPrototypeCodePointAt,
  StringPrototypeEndsWith,
  StringPrototypeIncludes,
  StringPrototypeIndexOf,
  StringPrototypeLastIndexOf,
  StringPrototypeNormalize,
  StringPrototypePadEnd,
  StringPrototypePadStart,
  StringPrototypeRepeat,
  StringPrototypeReplace,
  StringPrototypeReplaceAll,
  StringPrototypeSlice,
  StringPrototypeSplit,
  StringPrototypeStartsWith,
  StringPrototypeToLowerCase,
  StringPrototypeValueOf,
  SymbolIterator,
  SymbolPrototypeToString,
  SymbolPrototypeValueOf,
  SymbolToPrimitive,
  SymbolToStringTag,
  TypeError,
  TypeErrorPrototype,
  TypedArray,
  TypedArrayPrototype,
  TypedArrayPrototypeGetLength,
  TypedArrayPrototypeGetSymbolToStringTag,
  Uint8Array,
  WeakMap,
  WeakMapPrototype,
  WeakSet,
  WeakSetPrototype,
  globalThis,
  uncurryThis,
} = primordials;

const {
  constants: {
    ALL_PROPERTIES,
    ONLY_ENUMERABLE,
    kPending,
    kRejected,
  },
  getOwnNonIndexProperties,
  getPromiseDetails,
  getProxyDetails,
  previewEntries,
  getConstructorName: internalGetConstructorName,
  getExternalValue,
} = internalBinding('util');

const {
  customInspectSymbol,
  isError,
  join,
  removeColors,
} = require('internal/util');

const {
  isStackOverflowError,
} = require('internal/errors');

const {
  isAsyncFunction,
  isGeneratorFunction,
  isAnyArrayBuffer,
  isArrayBuffer,
  isArgumentsObject,
  isBoxedPrimitive,
  isDataView,
  isExternal,
  isMap,
  isMapIterator,
  isModuleNamespaceObject,
  isNativeError,
  isPromise,
  isSet,
  isSetIterator,
  isWeakMap,
  isWeakSet,
  isRegExp,
  isDate,
  isTypedArray,
  isStringObject,
  isNumberObject,
  isBooleanObject,
  isBigIntObject,
} = require('internal/util/types');

const assert = require('internal/assert');

const { BuiltinModule } = require('internal/bootstrap/realm');
const {
  validateObject,
  validateString,
  kValidateObjectAllowArray,
} = require('internal/validators');

let hexSlice;
let internalUrl;

function pathToFileUrlHref(filepath) {
  internalUrl ??= require('internal/url');
  return internalUrl.pathToFileURL(filepath).href;
}

function isURL(value) {
  internalUrl ??= require('internal/url');
  return typeof value.href === 'string' && value instanceof internalUrl.URL;
}

const builtInObjects = new SafeSet(
  ArrayPrototypeFilter(
    ObjectGetOwnPropertyNames(globalThis),
    (e) => RegExpPrototypeExec(/^[A-Z][a-zA-Z0-9]+$/, e) !== null,
  ),
);

// https://tc39.es/ecma262/#sec-IsHTMLDDA-internal-slot
const isUndetectableObject = (v) => typeof v === 'undefined' && v !== undefined;

// These options must stay in sync with `getUserOptions`. So if any option will
// be added or removed, `getUserOptions` must also be updated accordingly.
const inspectDefaultOptions = ObjectSeal({
  showHidden: false,
  depth: 2,
  colors: false,
  customInspect: true,
  showProxy: false,
  maxArrayLength: 100,
  maxStringLength: 10000,
  breakLength: 80,
  compact: 3,
  sorted: false,
  getters: false,
  numericSeparator: false,
});

const kObjectType = 0;
const kArrayType = 1;
const kArrayExtrasType = 2;

/* eslint-disable no-control-regex */
const strEscapeSequencesRegExp = /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const strEscapeSequencesReplacer = /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const strEscapeSequencesRegExpSingle = /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const strEscapeSequencesReplacerSingle = /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/* eslint-enable no-control-regex */

const keyStrRegExp = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
const numberRegExp = /^(0|[1-9][0-9]*)$/;

const coreModuleRegExp = /^ {4}at (?:[^/\\(]+ \(|)node:(.+):\d+:\d+\)?$/;

const classRegExp = /^(\s+[^(]*?)\s*{/;
// eslint-disable-next-line node-core/no-unescaped-regexp-dot
const stripCommentsRegExp = /(\/\/.*?\n)|(\/\*(.|\n)*?\*\/)/g;

const kMinLineLength = 16;

// Constants to map the iterator state.
const kWeak = 0;
const kIterator = 1;
const kMapEntries = 2;

// Escaped control characters (plus the single quote and the backslash). Use
// empty strings to fill up unused entries.
const meta = [
  '\\x00', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06', '\\x07', // x07
  '\\b', '\\t', '\\n', '\\x0B', '\\f', '\\r', '\\x0E', '\\x0F',           // x0F
  '\\x10', '\\x11', '\\x12', '\\x13', '\\x14', '\\x15', '\\x16', '\\x17', // x17
  '\\x18', '\\x19', '\\x1A', '\\x1B', '\\x1C', '\\x1D', '\\x1E', '\\x1F', // x1F
  '', '', '', '', '', '', '', "\\'", '', '', '', '', '', '', '', '',      // x2F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x3F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x4F
  '', '', '', '', '', '', '', '', '', '', '', '', '\\\\', '', '', '',     // x5F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x6F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '\\x7F',    // x7F
  '\\x80', '\\x81', '\\x82', '\\x83', '\\x84', '\\x85', '\\x86', '\\x87', // x87
  '\\x88', '\\x89', '\\x8A', '\\x8B', '\\x8C', '\\x8D', '\\x8E', '\\x8F', // x8F
  '\\x90', '\\x91', '\\x92', '\\x93', '\\x94', '\\x95', '\\x96', '\\x97', // x97
  '\\x98', '\\x99', '\\x9A', '\\x9B', '\\x9C', '\\x9D', '\\x9E', '\\x9F', // x9F
];

// Regex used for ansi escape code splitting
// Ref: https://github.com/chalk/ansi-regex/blob/f338e1814144efb950276aac84135ff86b72dc8e/index.js
// License: MIT by Sindre Sorhus <sindresorhus@gmail.com>
// Matches all ansi escape code sequences in a string
const ansi = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*' +
  '(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*' +
  '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?' +
  '(?:\\u0007|\\u001B\\u005C|\\u009C))' +
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?' +
  '[\\dA-PR-TZcf-nq-uy=><~]))', 'g',
);

let getStringWidth;

function getUserOptions(ctx, isCrossContext) {
  const ret = {
    stylize: ctx.stylize,
    showHidden: ctx.showHidden,
    depth: ctx.depth,
    colors: ctx.colors,
    customInspect: ctx.customInspect,
    showProxy: ctx.showProxy,
    maxArrayLength: ctx.maxArrayLength,
    maxStringLength: ctx.maxStringLength,
    breakLength: ctx.breakLength,
    compact: ctx.compact,
    sorted: ctx.sorted,
    getters: ctx.getters,
    numericSeparator: ctx.numericSeparator,
    ...ctx.userOptions,
  };

  // Typically, the target value will be an instance of `Object`. If that is
  // *not* the case, the object may come from another vm.Context, and we want
  // to avoid passing it objects from this Context in that case, so we remove
  // the prototype from the returned object itself + the `stylize()` function,
  // and remove all other non-primitives, including non-primitive user options.
  if (isCrossContext) {
    ObjectSetPrototypeOf(ret, null);
    for (const key of ObjectKeys(ret)) {
      if ((typeof ret[key] === 'object' || typeof ret[key] === 'function') &&
          ret[key] !== null) {
        delete ret[key];
      }
    }
    ret.stylize = ObjectSetPrototypeOf((value, flavour) => {
      let stylized;
      try {
        stylized = `${ctx.stylize(value, flavour)}`;
      } catch {
        // Continue regardless of error.
      }

      if (typeof stylized !== 'string') return value;
      // `stylized` is a string as it should be, which is safe to pass along.
      return stylized;
    }, null);
  }

  return ret;
}

/**
 * Echos the value of any input. Tries to print the value out
 * in the best way possible given the different types.
 * @param {any} value The value to print out.
 * @param {object} opts Optional options object that alters the output.
 */
/* Legacy: value, showHidden, depth, colors */
function inspect(value, opts) {
  // Default options
  const ctx = {
    budget: {},
    indentationLvl: 0,
    seen: [],
    currentDepth: 0,
    stylize: stylizeNoColor,
    showHidden: inspectDefaultOptions.showHidden,
    depth: inspectDefaultOptions.depth,
    colors: inspectDefaultOptions.colors,
    customInspect: inspectDefaultOptions.customInspect,
    showProxy: inspectDefaultOptions.showProxy,
    maxArrayLength: inspectDefaultOptions.maxArrayLength,
    maxStringLength: inspectDefaultOptions.maxStringLength,
    breakLength: inspectDefaultOptions.breakLength,
    compact: inspectDefaultOptions.compact,
    sorted: inspectDefaultOptions.sorted,
    getters: inspectDefaultOptions.getters,
    numericSeparator: inspectDefaultOptions.numericSeparator,
  };
  if (arguments.length > 1) {
    // Legacy...
    if (arguments.length > 2) {
      if (arguments[2] !== undefined) {
        ctx.depth = arguments[2];
      }
      if (arguments.length > 3 && arguments[3] !== undefined) {
        ctx.colors = arguments[3];
      }
    }
    // Set user-specified options
    if (typeof opts === 'boolean') {
      ctx.showHidden = opts;
    } else if (opts) {
      const optKeys = ObjectKeys(opts);
      for (let i = 0; i < optKeys.length; ++i) {
        const key = optKeys[i];
        // TODO(BridgeAR): Find a solution what to do about stylize. Either make
        // this function public or add a new API with a similar or better
        // functionality.
        if (
          ObjectPrototypeHasOwnProperty(inspectDefaultOptions, key) ||
          key === 'stylize') {
          ctx[key] = opts[key];
        } else if (ctx.userOptions === undefined) {
          // This is required to pass through the actual user input.
          ctx.userOptions = opts;
        }
      }
    }
  }
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
  if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
  return formatValue(ctx, value, 0);
}
inspect.custom = customInspectSymbol;

ObjectDefineProperty(inspect, 'defaultOptions', {
  __proto__: null,
  get() {
    return inspectDefaultOptions;
  },
  set(options) {
    validateObject(options, 'options');
    return ObjectAssign(inspectDefaultOptions, options);
  },
});

// Set Graphics Rendition https://en.wikipedia.org/wiki/ANSI_escape_code#graphics
// Each color consists of an array with the color code as first entry and the
// reset code as second entry.
const defaultFG = 39;
const defaultBG = 49;
inspect.colors = {
  __proto__: null,
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22], // Alias: faint
  italic: [3, 23],
  underline: [4, 24],
  blink: [5, 25],
  // Swap foreground and background colors
  inverse: [7, 27], // Alias: swapcolors, swapColors
  hidden: [8, 28], // Alias: conceal
  strikethrough: [9, 29], // Alias: strikeThrough, crossedout, crossedOut
  doubleunderline: [21, 24], // Alias: doubleUnderline
  black: [30, defaultFG],
  red: [31, defaultFG],
  green: [32, defaultFG],
  yellow: [33, defaultFG],
  blue: [34, defaultFG],
  magenta: [35, defaultFG],
  cyan: [36, defaultFG],
  white: [37, defaultFG],
  bgBlack: [40, defaultBG],
  bgRed: [41, defaultBG],
  bgGreen: [42, defaultBG],
  bgYellow: [43, defaultBG],
  bgBlue: [44, defaultBG],
  bgMagenta: [45, defaultBG],
  bgCyan: [46, defaultBG],
  bgWhite: [47, defaultBG],
  framed: [51, 54],
  overlined: [53, 55],
  gray: [90, defaultFG], // Alias: grey, blackBright
  redBright: [91, defaultFG],
  greenBright: [92, defaultFG],
  yellowBright: [93, defaultFG],
  blueBright: [94, defaultFG],
  magentaBright: [95, defaultFG],
  cyanBright: [96, defaultFG],
  whiteBright: [97, defaultFG],
  bgGray: [100, defaultBG], // Alias: bgGrey, bgBlackBright
  bgRedBright: [101, defaultBG],
  bgGreenBright: [102, defaultBG],
  bgYellowBright: [103, defaultBG],
  bgBlueBright: [104, defaultBG],
  bgMagentaBright: [105, defaultBG],
  bgCyanBright: [106, defaultBG],
  bgWhiteBright: [107, defaultBG],
};

function defineColorAlias(target, alias) {
  ObjectDefineProperty(inspect.colors, alias, {
    __proto__: null,
    get() {
      return this[target];
    },
    set(value) {
      this[target] = value;
    },
    configurable: true,
    enumerable: false,
  });
}

defineColorAlias('gray', 'grey');
defineColorAlias('gray', 'blackBright');
defineColorAlias('bgGray', 'bgGrey');
defineColorAlias('bgGray', 'bgBlackBright');
defineColorAlias('dim', 'faint');
defineColorAlias('strikethrough', 'crossedout');
defineColorAlias('strikethrough', 'strikeThrough');
defineColorAlias('strikethrough', 'crossedOut');
defineColorAlias('hidden', 'conceal');
defineColorAlias('inverse', 'swapColors');
defineColorAlias('inverse', 'swapcolors');
defineColorAlias('doubleunderline', 'doubleUnderline');

// TODO(BridgeAR): Add function style support for more complex styles.
// Don't use 'blue' not visible on cmd.exe
inspect.styles = ObjectAssign({ __proto__: null }, {
  special: 'cyan',
  number: 'yellow',
  bigint: 'yellow',
  boolean: 'yellow',
  undefined: 'grey',
  null: 'bold',
  string: 'green',
  symbol: 'green',
  date: 'magenta',
  // "name": intentionally not styling
  // TODO(BridgeAR): Highlight regular expressions properly.
  regexp: 'red',
  module: 'underline',
});

function addQuotes(str, quotes) {
  if (quotes === -1) {
    return `"${str}"`;
  }
  if (quotes === -2) {
    return `\`${str}\``;
  }
  return `'${str}'`;
}

function escapeFn(str) {
  const charCode = StringPrototypeCharCodeAt(str);
  return meta.length > charCode ? meta[charCode] : `\\u${NumberPrototypeToString(charCode, 16)}`;
}

// Escape control characters, single quotes and the backslash.
// This is similar to JSON stringify escaping.
function strEscape(str) {
  let escapeTest = strEscapeSequencesRegExp;
  let escapeReplace = strEscapeSequencesReplacer;
  let singleQuote = 39;

  // Check for double quotes. If not present, do not escape single quotes and
  // instead wrap the text in double quotes. If double quotes exist, check for
  // backticks. If they do not exist, use those as fallback instead of the
  // double quotes.
  if (StringPrototypeIncludes(str, "'")) {
    // This invalidates the charCode and therefore can not be matched for
    // anymore.
    if (!StringPrototypeIncludes(str, '"')) {
      singleQuote = -1;
    } else if (!StringPrototypeIncludes(str, '`') &&
               !StringPrototypeIncludes(str, '${')) {
      singleQuote = -2;
    }
    if (singleQuote !== 39) {
      escapeTest = strEscapeSequencesRegExpSingle;
      escapeReplace = strEscapeSequencesReplacerSingle;
    }
  }

  // Some magic numbers that worked out fine while benchmarking with v8 6.0
  if (str.length < 5000 && RegExpPrototypeExec(escapeTest, str) === null)
    return addQuotes(str, singleQuote);
  if (str.length > 100) {
    str = RegExpPrototypeSymbolReplace(escapeReplace, str, escapeFn);
    return addQuotes(str, singleQuote);
  }

  let result = '';
  let last = 0;
  for (let i = 0; i < str.length; i++) {
    const point = StringPrototypeCharCodeAt(str, i);
    if (point === singleQuote ||
        point === 92 ||
        point < 32 ||
        (point > 126 && point < 160)) {
      if (last === i) {
        result += meta[point];
      } else {
        result += `${StringPrototypeSlice(str, last, i)}${meta[point]}`;
      }
      last = i + 1;
    } else if (point >= 0xd800 && point <= 0xdfff) {
      if (point <= 0xdbff && i + 1 < str.length) {
        const point = StringPrototypeCharCodeAt(str, i + 1);
        if (point >= 0xdc00 && point <= 0xdfff) {
          i++;
          continue;
        }
      }
      result += `${StringPrototypeSlice(str, last, i)}\\u${NumberPrototypeToString(point, 16)}`;
      last = i + 1;
    }
  }

  if (last !== str.length) {
    result += StringPrototypeSlice(str, last);
  }
  return addQuotes(result, singleQuote);
}

function stylizeWithColor(str, styleType) {
  const style = inspect.styles[styleType];
  if (style !== undefined) {
    const color = inspect.colors[style];
    if (color !== undefined)
      return `\u001b[${color[0]}m${str}\u001b[${color[1]}m`;
  }
  return str;
}

function stylizeNoColor(str) {
  return str;
}

// Return a new empty array to push in the results of the default formatter.
function getEmptyFormatArray() {
  return [];
}

function isInstanceof(object, proto) {
  try {
    return object instanceof proto;
  } catch {
    return false;
  }
}

// Special-case for some builtin prototypes in case their `constructor` property has been tampered.
const wellKnownPrototypes = new SafeMap()
  .set(ArrayPrototype, { name: 'Array', constructor: Array })
  .set(ArrayBufferPrototype, { name: 'ArrayBuffer', constructor: ArrayBuffer })
  .set(FunctionPrototype, { name: 'Function', constructor: Function })
  .set(MapPrototype, { name: 'Map', constructor: Map })
  .set(SetPrototype, { name: 'Set', constructor: Set })
  .set(ObjectPrototype, { name: 'Object', constructor: Object })
  .set(TypedArrayPrototype, { name: 'TypedArray', constructor: TypedArray })
  .set(RegExpPrototype, { name: 'RegExp', constructor: RegExp })
  .set(DatePrototype, { name: 'Date', constructor: Date })
  .set(DataViewPrototype, { name: 'DataView', constructor: DataView })

  .set(ErrorPrototype, { name: 'Error', constructor: Error })
  .set(AggregateErrorPrototype, { name: 'AggregateError', constructor: AggregateError })
  .set(RangeErrorPrototype, { name: 'RangeError', constructor: RangeError })
  .set(TypeErrorPrototype, { name: 'TypeError', constructor: TypeError })

  .set(BooleanPrototype, { name: 'Boolean', constructor: Boolean })
  .set(NumberPrototype, { name: 'Number', constructor: Number })
  .set(StringPrototype, { name: 'String', constructor: String })
  .set(PromisePrototype, { name: 'Promise', constructor: Promise })
  .set(WeakMapPrototype, { name: 'WeakMap', constructor: WeakMap })
  .set(WeakSetPrototype, { name: 'WeakSet', constructor: WeakSet });

function getConstructorName(obj, ctx, recurseTimes, protoProps) {
  let firstProto;
  const tmp = obj;
  while (obj || isUndetectableObject(obj)) {
    const wellKnownPrototypeNameAndConstructor = wellKnownPrototypes.get(obj);
    if (wellKnownPrototypeNameAndConstructor !== undefined) {
      const { name, constructor } = wellKnownPrototypeNameAndConstructor;
      if (FunctionPrototypeSymbolHasInstance(constructor, tmp)) {
        if (protoProps !== undefined && firstProto !== obj) {
          addPrototypeProperties(
            ctx, tmp, firstProto || tmp, recurseTimes, protoProps);
        }
        return name;
      }
    }
    const descriptor = ObjectGetOwnPropertyDescriptor(obj, 'constructor');
    if (descriptor !== undefined &&
        typeof descriptor.value === 'function' &&
        descriptor.value.name !== '' &&
        isInstanceof(tmp, descriptor.value)) {
      if (protoProps !== undefined &&
         (firstProto !== obj ||
         !builtInObjects.has(descriptor.value.name))) {
        addPrototypeProperties(
          ctx, tmp, firstProto || tmp, recurseTimes, protoProps);
      }
      return String(descriptor.value.name);
    }

    obj = ObjectGetPrototypeOf(obj);
    if (firstProto === undefined) {
      firstProto = obj;
    }
  }

  if (firstProto === null) {
    return null;
  }

  const res = internalGetConstructorName(tmp);

  if (recurseTimes > ctx.depth && ctx.depth !== null) {
    return `${res} <Complex prototype>`;
  }

  const protoConstr = getConstructorName(
    firstProto, ctx, recurseTimes + 1, protoProps);

  if (protoConstr === null) {
    return `${res} <${inspect(firstProto, {
      ...ctx,
      customInspect: false,
      depth: -1,
    })}>`;
  }

  return `${res} <${protoConstr}>`;
}

// This function has the side effect of adding prototype properties to the
// `output` argument (which is an array). This is intended to highlight user
// defined prototype properties.
function addPrototypeProperties(ctx, main, obj, recurseTimes, output) {
  let depth = 0;
  let keys;
  let keySet;
  do {
    if (depth !== 0 || main === obj) {
      obj = ObjectGetPrototypeOf(obj);
      // Stop as soon as a null prototype is encountered.
      if (obj === null) {
        return;
      }
      // Stop as soon as a built-in object type is detected.
      const descriptor = ObjectGetOwnPropertyDescriptor(obj, 'constructor');
      if (descriptor !== undefined &&
          typeof descriptor.value === 'function' &&
          builtInObjects.has(descriptor.value.name)) {
        return;
      }
    }

    if (depth === 0) {
      keySet = new SafeSet();
    } else {
      ArrayPrototypeForEach(keys, (key) => keySet.add(key));
    }
    // Get all own property names and symbols.
    keys = ReflectOwnKeys(obj);
    ArrayPrototypePush(ctx.seen, main);
    for (const key of keys) {
      // Ignore the `constructor` property and keys that exist on layers above.
      if (key === 'constructor' ||
          ObjectPrototypeHasOwnProperty(main, key) ||
          (depth !== 0 && keySet.has(key))) {
        continue;
      }
      const desc = ObjectGetOwnPropertyDescriptor(obj, key);
      if (typeof desc.value === 'function') {
        continue;
      }
      const value = formatProperty(
        ctx, obj, recurseTimes, key, kObjectType, desc, main);
      if (ctx.colors) {
        // Faint!
        ArrayPrototypePush(output, `\u001b[2m${value}\u001b[22m`);
      } else {
        ArrayPrototypePush(output, value);
      }
    }
    ArrayPrototypePop(ctx.seen);
  // Limit the inspection to up to three prototype layers. Using `recurseTimes`
  // is not a good choice here, because it's as if the properties are declared
  // on the current object from the users perspective.
  } while (++depth !== 3);
}

/** @type {(constructor: string, tag: string, fallback: string, size?: string) => string} */
function getPrefix(constructor, tag, fallback, size = '') {
  if (constructor === null) {
    if (tag !== '' && fallback !== tag) {
      return `[${fallback}${size}: null prototype] [${tag}] `;
    }
    return `[${fallback}${size}: null prototype] `;
  }

  let result = `${constructor}${size} `;
  if (tag !== '') {
    const position = constructor.indexOf(tag);
    if (position === -1) {
      result += `[${tag}] `;
    } else {
      const endPos = position + tag.length;
      if (endPos !== constructor.length &&
        constructor[endPos] === constructor[endPos].toLowerCase()) {
        result += `[${tag}] `;
      }
    }
  }
  return result;
}

// Look up the keys of the object.
function getKeys(value, showHidden) {
  let keys;
  const symbols = ObjectGetOwnPropertySymbols(value);
  if (showHidden) {
    keys = ObjectGetOwnPropertyNames(value);
    if (symbols.length !== 0)
      ArrayPrototypePushApply(keys, symbols);
  } else {
    // This might throw if `value` is a Module Namespace Object from an
    // unevaluated module, but we don't want to perform the actual type
    // check because it's expensive.
    // TODO(devsnek): track https://github.com/tc39/ecma262/issues/1209
    // and modify this logic as needed.
    try {
      keys = ObjectKeys(value);
    } catch (err) {
      assert(isNativeError(err) && err.name === 'ReferenceError' &&
             isModuleNamespaceObject(value));
      keys = ObjectGetOwnPropertyNames(value);
    }
    if (symbols.length !== 0) {
      const filter = (key) => ObjectPrototypePropertyIsEnumerable(value, key);
      ArrayPrototypePushApply(keys, ArrayPrototypeFilter(symbols, filter));
    }
  }
  return keys;
}

function getCtxStyle(value, constructor, tag) {
  let fallback = '';
  if (constructor === null) {
    fallback = internalGetConstructorName(value);
    if (fallback === tag) {
      fallback = 'Object';
    }
  }
  return getPrefix(constructor, tag, fallback);
}

function formatProxy(ctx, proxy, recurseTimes) {
  if (recurseTimes > ctx.depth && ctx.depth !== null) {
    return ctx.stylize('Proxy [Array]', 'special');
  }
  recurseTimes += 1;
  ctx.indentationLvl += 2;
  const res = [
    formatValue(ctx, proxy[0], recurseTimes),
    formatValue(ctx, proxy[1], recurseTimes),
  ];
  ctx.indentationLvl -= 2;
  return reduceToSingleString(
    ctx, res, '', ['Proxy [', ']'], kArrayExtrasType, recurseTimes);
}

// Note: using `formatValue` directly requires the indentation level to be
// corrected by setting `ctx.indentationLvL += diff` and then to decrease the
// value afterwards again.
function formatValue(ctx, value, recurseTimes, typedArray) {
  // Primitive types cannot have properties.
  if (typeof value !== 'object' &&
      typeof value !== 'function' &&
      !isUndetectableObject(value)) {
    return formatPrimitive(ctx.stylize, value, ctx);
  }
  if (value === null) {
    return ctx.stylize('null', 'null');
  }

  // Memorize the context for custom inspection on proxies.
  const context = value;
  // Always check for proxies to prevent side effects and to prevent triggering
  // any proxy handlers.
  const proxy = getProxyDetails(value, !!ctx.showProxy);
  if (proxy !== undefined) {
    if (proxy === null || proxy[0] === null) {
      return ctx.stylize('<Revoked Proxy>', 'special');
    }
    if (ctx.showProxy) {
      return formatProxy(ctx, proxy, recurseTimes);
    }
    value = proxy;
  }

  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it.
  if (ctx.customInspect) {
    const maybeCustom = value[customInspectSymbol];
    if (typeof maybeCustom === 'function' &&
        // Filter out the util module, its inspect function is special.
        maybeCustom !== inspect &&
        // Also filter out any prototype objects using the circular check.
        ObjectGetOwnPropertyDescriptor(value, 'constructor')?.value?.prototype !== value) {
      // This makes sure the recurseTimes are reported as before while using
      // a counter internally.
      const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
      const isCrossContext =
        proxy !== undefined || !FunctionPrototypeSymbolHasInstance(Object, context);
      const ret = FunctionPrototypeCall(
        maybeCustom,
        context,
        depth,
        getUserOptions(ctx, isCrossContext),
        inspect,
      );
      // If the custom inspection method returned `this`, don't go into
      // infinite recursion.
      if (ret !== context) {
        if (typeof ret !== 'string') {
          return formatValue(ctx, ret, recurseTimes);
        }
        return StringPrototypeReplaceAll(ret, '\n', `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`);
      }
    }
  }

  // Using an array here is actually better for the average case than using
  // a Set. `seen` will only check for the depth and will never grow too large.
  if (ctx.seen.includes(value)) {
    let index = 1;
    if (ctx.circular === undefined) {
      ctx.circular = new SafeMap();
      ctx.circular.set(value, index);
    } else {
      index = ctx.circular.get(value);
      if (index === undefined) {
        index = ctx.circular.size + 1;
        ctx.circular.set(value, index);
      }
    }
    return ctx.stylize(`[Circular *${index}]`, 'special');
  }

  return formatRaw(ctx, value, recurseTimes, typedArray);
}

function formatRaw(ctx, value, recurseTimes, typedArray) {
  let keys;
  let protoProps;
  if (ctx.showHidden && (recurseTimes <= ctx.depth || ctx.depth === null)) {
    protoProps = [];
  }

  const constructor = getConstructorName(value, ctx, recurseTimes, protoProps);
  // Reset the variable to check for this later on.
  if (protoProps !== undefined && protoProps.length === 0) {
    protoProps = undefined;
  }

  let tag = value[SymbolToStringTag];
  // Only list the tag in case it's non-enumerable / not an own property.
  // Otherwise we'd print this twice.
  if (typeof tag !== 'string' ||
      (tag !== '' &&
      (ctx.showHidden ?
        ObjectPrototypeHasOwnProperty :
        ObjectPrototypePropertyIsEnumerable)(
        value, SymbolToStringTag,
      ))) {
    tag = '';
  }
  let base = '';
  let formatter = getEmptyFormatArray;
  let braces;
  let noIterator = true;
  let i = 0;
  const filter = ctx.showHidden ? ALL_PROPERTIES : ONLY_ENUMERABLE;

  let extrasType = kObjectType;
  let extraKeys;

  // Iterators and the rest are split to reduce checks.
  // We have to check all values in case the constructor is set to null.
  // Otherwise it would not possible to identify all types properly.
  if (SymbolIterator in value || constructor === null) {
    noIterator = false;
    if (ArrayIsArray(value)) {
      // Only set the constructor for non ordinary ("Array [...]") arrays.
      const prefix = (constructor !== 'Array' || tag !== '') ?
        getPrefix(constructor, tag, 'Array', `(${value.length})`) :
        '';
      keys = getOwnNonIndexProperties(value, filter);
      braces = [`${prefix}[`, ']'];
      if (value.length === 0 && keys.length === 0 && protoProps === undefined)
        return `${braces[0]}]`;
      extrasType = kArrayExtrasType;
      formatter = formatArray;
    } else if (isSet(value)) {
      const size = SetPrototypeGetSize(value);
      const prefix = getPrefix(constructor, tag, 'Set', `(${size})`);
      keys = getKeys(value, ctx.showHidden);
      formatter = constructor !== null ?
        FunctionPrototypeBind(formatSet, null, value) :
        FunctionPrototypeBind(formatSet, null, SetPrototypeValues(value));
      if (size === 0 && keys.length === 0 && protoProps === undefined)
        return `${prefix}{}`;
      braces = [`${prefix}{`, '}'];
    } else if (isMap(value)) {
      const size = MapPrototypeGetSize(value);
      const prefix = getPrefix(constructor, tag, 'Map', `(${size})`);
      keys = getKeys(value, ctx.showHidden);
      formatter = constructor !== null ?
        FunctionPrototypeBind(formatMap, null, value) :
        FunctionPrototypeBind(formatMap, null, MapPrototypeEntries(value));
      if (size === 0 && keys.length === 0 && protoProps === undefined)
        return `${prefix}{}`;
      braces = [`${prefix}{`, '}'];
    } else if (isTypedArray(value)) {
      keys = getOwnNonIndexProperties(value, filter);
      let bound = value;
      let fallback = '';
      if (constructor === null) {
        fallback = TypedArrayPrototypeGetSymbolToStringTag(value);
        // Reconstruct the array information.
        bound = new primordials[fallback](value);
      }
      const size = TypedArrayPrototypeGetLength(value);
      const prefix = getPrefix(constructor, tag, fallback, `(${size})`);
      braces = [`${prefix}[`, ']'];
      if (value.length === 0 && keys.length === 0 && !ctx.showHidden)
        return `${braces[0]}]`;
      // Special handle the value. The original value is required below. The
      // bound function is required to reconstruct missing information.
      formatter = FunctionPrototypeBind(formatTypedArray, null, bound, size);
      extrasType = kArrayExtrasType;

      if (ctx.showHidden) {
        extraKeys = ['BYTES_PER_ELEMENT', 'length', 'byteLength', 'byteOffset', 'buffer'];
        typedArray = true;
      }
    } else if (isMapIterator(value)) {
      keys = getKeys(value, ctx.showHidden);
      braces = getIteratorBraces('Map', tag);
      // Add braces to the formatter parameters.
      formatter = FunctionPrototypeBind(formatIterator, null, braces);
    } else if (isSetIterator(value)) {
      keys = getKeys(value, ctx.showHidden);
      braces = getIteratorBraces('Set', tag);
      // Add braces to the formatter parameters.
      formatter = FunctionPrototypeBind(formatIterator, null, braces);
    } else {
      noIterator = true;
    }
  }
  if (noIterator) {
    keys = getKeys(value, ctx.showHidden);
    braces = ['{', '}'];
    if (typeof value === 'function') {
      base = getFunctionBase(ctx, value, constructor, tag);
      if (keys.length === 0 && protoProps === undefined)
        return ctx.stylize(base, 'special');
    } else if (constructor === 'Object') {
      if (isArgumentsObject(value)) {
        braces[0] = '[Arguments] {';
      } else if (tag !== '') {
        braces[0] = `${getPrefix(constructor, tag, 'Object')}{`;
      }
      if (keys.length === 0 && protoProps === undefined) {
        return `${braces[0]}}`;
      }
    } else if (isRegExp(value)) {
      // Make RegExps say that they are RegExps
      base = RegExpPrototypeToString(
        constructor !== null ? value : new RegExp(value),
      );
      const prefix = getPrefix(constructor, tag, 'RegExp');
      if (prefix !== 'RegExp ')
        base = `${prefix}${base}`;
      if ((keys.length === 0 && protoProps === undefined) ||
          (recurseTimes > ctx.depth && ctx.depth !== null)) {
        return ctx.stylize(base, 'regexp');
      }
    } else if (isDate(value)) {
      // Make dates with properties first say the date
      base = NumberIsNaN(DatePrototypeGetTime(value)) ?
        DatePrototypeToString(value) :
        DatePrototypeToISOString(value);
      const prefix = getPrefix(constructor, tag, 'Date');
      if (prefix !== 'Date ')
        base = `${prefix}${base}`;
      if (keys.length === 0 && protoProps === undefined) {
        return ctx.stylize(base, 'date');
      }
    } else if (isError(value)) {
      base = formatError(value, constructor, tag, ctx, keys);
      if (keys.length === 0 && protoProps === undefined)
        return base;
    } else if (isAnyArrayBuffer(value)) {
      // Fast path for ArrayBuffer and SharedArrayBuffer.
      // Can't do the same for DataView because it has a non-primitive
      // .buffer property that we need to recurse for.
      const arrayType = isArrayBuffer(value) ? 'ArrayBuffer' :
        'SharedArrayBuffer';
      const prefix = getPrefix(constructor, tag, arrayType);
      if (typedArray === undefined) {
        formatter = formatArrayBuffer;
      } else if (keys.length === 0 && protoProps === undefined) {
        return prefix +
              `{ [byteLength]: ${formatNumber(ctx.stylize, value.byteLength, false)} }`;
      }
      braces[0] = `${prefix}{`;
      extraKeys = ['byteLength'];
    } else if (isDataView(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'DataView')}{`;
      // .buffer goes last, it's not a primitive like the others.
      extraKeys = ['byteLength', 'byteOffset', 'buffer'];
    } else if (isPromise(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'Promise')}{`;
      formatter = formatPromise;
    } else if (isWeakSet(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'WeakSet')}{`;
      formatter = ctx.showHidden ? formatWeakSet : formatWeakCollection;
    } else if (isWeakMap(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'WeakMap')}{`;
      formatter = ctx.showHidden ? formatWeakMap : formatWeakCollection;
    } else if (isModuleNamespaceObject(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'Module')}{`;
      // Special handle keys for namespace objects.
      formatter = formatNamespaceObject.bind(null, keys);
    } else if (isBoxedPrimitive(value)) {
      base = getBoxedBase(value, ctx, keys, constructor, tag);
      if (keys.length === 0 && protoProps === undefined) {
        return base;
      }
    } else if (isURL(value) && !(recurseTimes > ctx.depth && ctx.depth !== null)) {
      base = value.href;
      if (keys.length === 0 && protoProps === undefined) {
        return base;
      }
    } else {
      if (keys.length === 0 && protoProps === undefined) {
        if (isExternal(value)) {
          const address = getExternalValue(value).toString(16);
          return ctx.stylize(`[External: ${address}]`, 'special');
        }
        return `${getCtxStyle(value, constructor, tag)}{}`;
      }
      braces[0] = `${getCtxStyle(value, constructor, tag)}{`;
    }
  }

  if (recurseTimes > ctx.depth && ctx.depth !== null) {
    let constructorName = StringPrototypeSlice(getCtxStyle(value, constructor, tag), 0, -1);
    if (constructor !== null)
      constructorName = `[${constructorName}]`;
    return ctx.stylize(constructorName, 'special');
  }
  recurseTimes += 1;

  ctx.seen.push(value);
  ctx.currentDepth = recurseTimes;
  let output;
  const indentationLvl = ctx.indentationLvl;
  try {
    output = formatter(ctx, value, recurseTimes);
    if (extraKeys !== undefined) {
      for (i = 0; i < extraKeys.length; i++) {
        let formatted;
        try {
          formatted = formatExtraProperties(ctx, value, recurseTimes, extraKeys[i], typedArray);
        } catch {
          const tempValue = { [extraKeys[i]]: value.buffer[extraKeys[i]] };
          formatted = formatExtraProperties(ctx, tempValue, recurseTimes, extraKeys[i], typedArray);
        }
        ArrayPrototypePush(output, formatted);
      }
    }
    for (i = 0; i < keys.length; i++) {
      ArrayPrototypePush(
        output,
        formatProperty(ctx, value, recurseTimes, keys[i], extrasType),
      );
    }
    if (protoProps !== undefined) {
      ArrayPrototypePushApply(output, protoProps);
    }
  } catch (err) {
    if (!isStackOverflowError(err)) throw err;
    const constructorName = StringPrototypeSlice(getCtxStyle(value, constructor, tag), 0, -1);
    return handleMaxCallStackSize(ctx, err, constructorName, indentationLvl);
  }
  if (ctx.circular !== undefined) {
    const index = ctx.circular.get(value);
    if (index !== undefined) {
      const reference = ctx.stylize(`<ref *${index}>`, 'special');
      // Add reference always to the very beginning of the output.
      if (ctx.compact !== true) {
        base = base === '' ? reference : `${reference} ${base}`;
      } else {
        braces[0] = `${reference} ${braces[0]}`;
      }
    }
  }
  ctx.seen.pop();

  if (ctx.sorted) {
    const comparator = ctx.sorted === true ? undefined : ctx.sorted;
    if (extrasType === kObjectType) {
      ArrayPrototypeSort(output, comparator);
    } else if (keys.length > 1) {
      const sorted = ArrayPrototypeSort(ArrayPrototypeSlice(output, output.length - keys.length), comparator);
      ArrayPrototypeUnshift(sorted, output, output.length - keys.length, keys.length);
      ReflectApply(ArrayPrototypeSplice, null, sorted);
    }
  }

  const res = reduceToSingleString(
    ctx, output, base, braces, extrasType, recurseTimes, value);
  const budget = ctx.budget[ctx.indentationLvl] || 0;
  const newLength = budget + res.length;
  ctx.budget[ctx.indentationLvl] = newLength;
  // If any indentationLvl exceeds this limit, limit further inspecting to the
  // minimum. Otherwise the recursive algorithm might continue inspecting the
  // object even though the maximum string size (~2 ** 28 on 32 bit systems and
  // ~2 ** 30 on 64 bit systems) exceeded. The actual output is not limited at
  // exactly 2 ** 27 but a bit higher. This depends on the object shape.
  // This limit also makes sure that huge objects don't block the event loop
  // significantly.
  if (newLength > 2 ** 27) {
    ctx.depth = -1;
  }
  return res;
}

function getIteratorBraces(type, tag) {
  if (tag !== `${type} Iterator`) {
    if (tag !== '')
      tag += '] [';
    tag += `${type} Iterator`;
  }
  return [`[${tag}] {`, '}'];
}

function getBoxedBase(value, ctx, keys, constructor, tag) {
  let fn;
  let type;
  if (isNumberObject(value)) {
    fn = NumberPrototypeValueOf;
    type = 'Number';
  } else if (isStringObject(value)) {
    fn = StringPrototypeValueOf;
    type = 'String';
    // For boxed Strings, we have to remove the 0-n indexed entries,
    // since they just noisy up the output and are redundant
    // Make boxed primitive Strings look like such
    keys.splice(0, value.length);
  } else if (isBooleanObject(value)) {
    fn = BooleanPrototypeValueOf;
    type = 'Boolean';
  } else if (isBigIntObject(value)) {
    fn = BigIntPrototypeValueOf;
    type = 'BigInt';
  } else {
    fn = SymbolPrototypeValueOf;
    type = 'Symbol';
  }
  let base = `[${type}`;
  if (type !== constructor) {
    if (constructor === null) {
      base += ' (null prototype)';
    } else {
      base += ` (${constructor})`;
    }
  }
  base += `: ${formatPrimitive(stylizeNoColor, fn(value), ctx)}]`;
  if (tag !== '' && tag !== constructor) {
    base += ` [${tag}]`;
  }
  if (keys.length !== 0 || ctx.stylize === stylizeNoColor)
    return base;
  return ctx.stylize(base, StringPrototypeToLowerCase(type));
}

function getClassBase(value, constructor, tag) {
  const hasName = ObjectPrototypeHasOwnProperty(value, 'name');
  const name = (hasName && value.name) || '(anonymous)';
  let base = `class ${name}`;
  if (constructor !== 'Function' && constructor !== null) {
    base += ` [${constructor}]`;
  }
  if (tag !== '' && constructor !== tag) {
    base += ` [${tag}]`;
  }
  if (constructor !== null) {
    const superName = ObjectGetPrototypeOf(value).name;
    if (superName) {
      base += ` extends ${superName}`;
    }
  } else {
    base += ' extends [null prototype]';
  }
  return `[${base}]`;
}

function getFunctionBase(ctx, value, constructor, tag) {
  const stringified = FunctionPrototypeToString(value);
  if (StringPrototypeStartsWith(stringified, 'class') && stringified[stringified.length - 1] === '}') {
    const slice = StringPrototypeSlice(stringified, 5, -1);
    const bracketIndex = StringPrototypeIndexOf(slice, '{');
    if (bracketIndex !== -1 &&
        (!StringPrototypeIncludes(StringPrototypeSlice(slice, 0, bracketIndex), '(') ||
        // Slow path to guarantee that it's indeed a class.
        RegExpPrototypeExec(classRegExp, RegExpPrototypeSymbolReplace(stripCommentsRegExp, slice)) !== null)
    ) {
      return getClassBase(value, constructor, tag);
    }
  }
  let type = 'Function';
  if (isGeneratorFunction(value)) {
    type = `Generator${type}`;
  }
  if (isAsyncFunction(value)) {
    type = `Async${type}`;
  }
  let base = `[${type}`;
  if (constructor === null) {
    base += ' (null prototype)';
  }
  if (value.name === '') {
    base += ' (anonymous)';
  } else {
    base += `: ${typeof value.name === 'string' ? value.name : formatValue(ctx, value.name)}`;
  }
  base += ']';
  if (constructor !== type && constructor !== null) {
    base += ` ${constructor}`;
  }
  if (tag !== '' && constructor !== tag) {
    base += ` [${tag}]`;
  }
  return base;
}

function identicalSequenceRange(a, b) {
  for (let i = 0; i < a.length - 3; i++) {
    // Find the first entry of b that matches the current entry of a.
    const pos = ArrayPrototypeIndexOf(b, a[i]);
    if (pos !== -1) {
      const rest = b.length - pos;
      if (rest > 3) {
        let len = 1;
        const maxLen = MathMin(a.length - i, rest);
        // Count the number of consecutive entries.
        while (maxLen > len && a[i + len] === b[pos + len]) {
          len++;
        }
        if (len > 3) {
          return [len, i];
        }
      }
    }
  }

  return [0, 0];
}

function getDuplicateErrorFrameRanges(frames) {
  // Build a map: frame line -> sorted list of indices where it occurs
  const result = [];
  const lineToPositions = new SafeMap();

  for (let i = 0; i < frames.length; i++) {
    const positions = lineToPositions.get(frames[i]);
    if (positions === undefined) {
      lineToPositions.set(frames[i], [i]);
    } else {
      positions[positions.length] = i;
    }
  }

  const minimumDuplicateRange = 3;
  // Not enough duplicate lines to consider collapsing
  if (frames.length - lineToPositions.size <= minimumDuplicateRange) {
    return result;
  }

  for (let i = 0; i < frames.length - minimumDuplicateRange; i++) {
    const positions = lineToPositions.get(frames[i]);
    // Find the next occurrence of the same line after i, if any
    if (positions.length === 1 || positions[positions.length - 1] === i) {
      continue;
    }

    const current = positions.indexOf(i) + 1;
    if (current === positions.length) {
      continue;
    }

    // Theoretical maximum range, adjusted while iterating
    let range = positions[positions.length - 1] - i;
    if (range < minimumDuplicateRange) {
      continue;
    }
    let extraSteps;
    if (current + 1 < positions.length) {
      // Optimize initial step size by choosing the greatest common divisor (GCD)
      // of all candidate distances to the same frame line. This tends to match
      // the true repeating block size and minimizes fallback iterations.
      let gcdRange = 0;
      for (let j = current; j < positions.length; j++) {
        let distance = positions[j] - i;
        while (distance !== 0) {
          const remainder = gcdRange % distance;
          if (gcdRange !== 0) {
            // Add other possible ranges as fallback
            extraSteps ??= new SafeSet();
            extraSteps.add(gcdRange);
          }
          gcdRange = distance;
          distance = remainder;
        }
        if (gcdRange === 1) break;
      }
      range = gcdRange;
      if (extraSteps) {
        extraSteps.delete(range);
        extraSteps = [...extraSteps];
      }
    }
    let maxRange = range;
    let maxDuplicates = 0;

    let duplicateRanges = 0;

    for (let nextStart = i + range; /* ignored */ ; nextStart += range) {
      let equalFrames = 0;
      for (let j = 0; j < range; j++) {
        if (frames[i + j] !== frames[nextStart + j]) {
          break;
        }
        equalFrames++;
      }
      // Adjust the range to match different type of ranges.
      if (equalFrames !== range) {
        if (!extraSteps?.length) {
          break;
        }
        // Memorize former range in case the smaller one would hide less.
        if (duplicateRanges !== 0 && maxRange * maxDuplicates < range * duplicateRanges) {
          maxRange = range;
          maxDuplicates = duplicateRanges;
        }
        range = extraSteps.pop();
        nextStart = i;
        duplicateRanges = 0;
        continue;
      }
      duplicateRanges++;
    }

    if (maxDuplicates !== 0 && maxRange * maxDuplicates >= range * duplicateRanges) {
      range = maxRange;
      duplicateRanges = maxDuplicates;
    }

    if (duplicateRanges * range >= 3) {
      result.push(i + range, range, duplicateRanges);
      // Skip over the collapsed portion to avoid overlapping matches.
      i += range * (duplicateRanges + 1) - 1;
    }
  }

  return result;
}

function getStackString(ctx, error) {
  let stack;
  try {
    stack = error.stack;
  } catch {
    // If stack is getter that throws, we ignore the error.
  }
  if (stack) {
    if (typeof stack === 'string') {
      return stack;
    }
    ctx.seen.push(error);
    ctx.indentationLvl += 4;
    const result = formatValue(ctx, stack);
    ctx.indentationLvl -= 4;
    ctx.seen.pop();
    return `${ErrorPrototypeToString(error)}\n    ${result}`;
  }
  return ErrorPrototypeToString(error);
}

function getStackFrames(ctx, err, stack) {
  const frames = StringPrototypeSplit(stack, '\n');

  let cause;
  try {
    ({ cause } = err);
  } catch {
    // If 'cause' is a getter that throws, ignore it.
  }

  // Remove stack frames identical to frames in cause.
  if (cause != null && isError(cause)) {
    const causeStack = getStackString(ctx, cause);
    const causeStackStart = StringPrototypeIndexOf(causeStack, '\n    at');
    if (causeStackStart !== -1) {
      const causeFrames = StringPrototypeSplit(StringPrototypeSlice(causeStack, causeStackStart + 1), '\n');
      const { 0: len, 1: offset } = identicalSequenceRange(frames, causeFrames);
      if (len > 0) {
        const skipped = len - 2;
        const msg = `    ... ${skipped} lines matching cause stack trace ...`;
        frames.splice(offset + 1, skipped, ctx.stylize(msg, 'undefined'));
      }
    }
  }

  // Remove recursive repetitive stack frames in long stacks
  if (frames.length > 10) {
    const ranges = getDuplicateErrorFrameRanges(frames);

    for (let i = ranges.length - 3; i >= 0; i -= 3) {
      const offset = ranges[i];
      const length = ranges[i + 1];
      const duplicateRanges = ranges[i + 2];

      const msg = `    ... collapsed ${length * duplicateRanges} duplicate lines ` +
        'matching above ' +
        (duplicateRanges > 1 ?
          `${length} lines ${duplicateRanges} times...` :
          'lines ...');
      frames.splice(offset, length * duplicateRanges, ctx.stylize(msg, 'undefined'));
    }
  }

  return frames;
}

/** @type {(stack: string, constructor: string | null, name: unknown, tag: string) => string} */
function improveStack(stack, constructor, name, tag) {
  // A stack trace may contain arbitrary data. Only manipulate the output
  // for "regular errors" (errors that "look normal") for now.
  let len = name.length;

  if (typeof name !== 'string') {
    stack = StringPrototypeReplace(
      stack,
      `${name}`,
      `${name} [${StringPrototypeSlice(getPrefix(constructor, tag, 'Error'), 0, -1)}]`,
    );
  }

  if (constructor === null ||
      (StringPrototypeEndsWith(name, 'Error') &&
      StringPrototypeStartsWith(stack, name) &&
      (stack.length === len || stack[len] === ':' || stack[len] === '\n'))) {
    let fallback = 'Error';
    if (constructor === null) {
      const start = RegExpPrototypeExec(/^([A-Z][a-z_ A-Z0-9[\]()-]+)(?::|\n {4}at)/, stack) ||
      RegExpPrototypeExec(/^([a-z_A-Z0-9-]*Error)$/, stack);
      fallback = (start?.[1]) || '';
      len = fallback.length;
      fallback ||= 'Error';
    }
    const prefix = StringPrototypeSlice(getPrefix(constructor, tag, fallback), 0, -1);
    if (name !== prefix) {
      if (StringPrototypeIncludes(prefix, name)) {
        if (len === 0) {
          stack = `${prefix}: ${stack}`;
        } else {
          stack = `${prefix}${StringPrototypeSlice(stack, len)}`;
        }
      } else {
        stack = `${prefix} [${name}]${StringPrototypeSlice(stack, len)}`;
      }
    }
  }
  return stack;
}

function markNodeModules(ctx, line) {
  let tempLine = '';
  let lastPos = 0;
  let searchFrom = 0;

  while (true) {
    const nodeModulePosition = StringPrototypeIndexOf(line, 'node_modules', searchFrom);
    if (nodeModulePosition === -1) {
      break;
    }

    // Ensure it's a path segment: must have a path separator before and after
    const separator = line[nodeModulePosition - 1];
    const after = line[nodeModulePosition + 12]; // 'node_modules'.length === 12

    if ((after !== '/' && after !== '\\') || (separator !== '/' && separator !== '\\')) {
      // Not a proper segment; continue searching
      searchFrom = nodeModulePosition + 1;
      continue;
    }

    const moduleStart = nodeModulePosition + 13; // Include trailing separator

    // Append up to and including '/node_modules/'
    tempLine += StringPrototypeSlice(line, lastPos, moduleStart);

    let moduleEnd = StringPrototypeIndexOf(line, separator, moduleStart);
    if (line[moduleStart] === '@') {
      // Namespaced modules have an extra slash: @namespace/package
      moduleEnd = StringPrototypeIndexOf(line, separator, moduleEnd + 1);
    }

    const nodeModule = StringPrototypeSlice(line, moduleStart, moduleEnd);
    tempLine += ctx.stylize(nodeModule, 'module');

    lastPos = moduleEnd;
    searchFrom = moduleEnd;
  }

  if (lastPos !== 0) {
    line = tempLine + StringPrototypeSlice(line, lastPos);
  }
  return line;
}

function markCwd(ctx, line, workingDirectory) {
  let cwdStartPos = StringPrototypeIndexOf(line, workingDirectory);
  let tempLine = '';
  let cwdLength = workingDirectory.length;
  if (cwdStartPos !== -1) {
    if (StringPrototypeSlice(line, cwdStartPos - 7, cwdStartPos) === 'file://') {
      cwdLength += 7;
      cwdStartPos -= 7;
    }
    const start = line[cwdStartPos - 1] === '(' ? cwdStartPos - 1 : cwdStartPos;
    const end = start !== cwdStartPos && StringPrototypeEndsWith(line, ')') ? -1 : line.length;
    const workingDirectoryEndPos = cwdStartPos + cwdLength + 1;
    const cwdSlice = StringPrototypeSlice(line, start, workingDirectoryEndPos);

    tempLine += StringPrototypeSlice(line, 0, start);
    tempLine += ctx.stylize(cwdSlice, 'undefined');
    tempLine += StringPrototypeSlice(line, workingDirectoryEndPos, end);
    if (end === -1) {
      tempLine += ctx.stylize(')', 'undefined');
    }
  } else {
    tempLine += line;
  }
  return tempLine;
}

function safeGetCWD() {
  let workingDirectory;
  try {
    workingDirectory = process.cwd();
  } catch {
    return;
  }
  return workingDirectory;
}

function formatError(err, constructor, tag, ctx, keys) {
  let message, name, stack;
  try {
    stack = getStackString(ctx, err);
  } catch {
    return ObjectPrototypeToString(err);
  }

  let messageIsGetterThatThrows = false;
  try {
    message = err.message;
  } catch {
    messageIsGetterThatThrows = true;
  }
  let nameIsGetterThatThrows = false;
  try {
    name = err.name;
  } catch {
    nameIsGetterThatThrows = true;
  }

  if (!ctx.showHidden && keys.length !== 0) {
    const index = ArrayPrototypeIndexOf(keys, 'stack');
    if (index !== -1) {
      ArrayPrototypeSplice(keys, index, 1);
    }

    if (!messageIsGetterThatThrows) {
      const index = ArrayPrototypeIndexOf(keys, 'message');
      // Only hide the property if it's a string and if it's part of the original stack
      if (index !== -1 && (typeof message !== 'string' || StringPrototypeIncludes(stack, message))) {
        ArrayPrototypeSplice(keys, index, 1);
      }
    }

    if (!nameIsGetterThatThrows) {
      const index = ArrayPrototypeIndexOf(keys, 'name');
      // Only hide the property if it's a string and if it's part of the original stack
      if (index !== -1 && (typeof name !== 'string' || StringPrototypeIncludes(stack, name))) {
        ArrayPrototypeSplice(keys, index, 1);
      }
    }
  }
  name ??= 'Error';

  if (ObjectPrototypeHasOwnProperty(err, 'cause') &&
      (keys.length === 0 || !ArrayPrototypeIncludes(keys, 'cause'))) {
    ArrayPrototypePush(keys, 'cause');
  }

  // Print errors aggregated into AggregateError
  try {
    const errors = err.errors;
    if (ArrayIsArray(errors) && ObjectPrototypeHasOwnProperty(err, 'errors') &&
      (keys.length === 0 || !ArrayPrototypeIncludes(keys, 'errors'))) {
      ArrayPrototypePush(keys, 'errors');
    }
  } catch {
    // If errors is a getter that throws, we ignore the error.
  }

  stack = improveStack(stack, constructor, name, tag);

  // Ignore the error message if it's contained in the stack.
  let pos = (message && StringPrototypeIndexOf(stack, message)) || -1;
  if (pos !== -1)
    pos += message.length;
  // Wrap the error in brackets in case it has no stack trace.
  const stackStart = StringPrototypeIndexOf(stack, '\n    at', pos);
  if (stackStart === -1) {
    stack = `[${stack}]`;
  } else {
    let newStack = StringPrototypeSlice(stack, 0, stackStart);
    const stackFramePart = StringPrototypeSlice(stack, stackStart + 1);
    const lines = getStackFrames(ctx, err, stackFramePart);
    if (ctx.colors) {
      // Highlight userland code and node modules.
      const workingDirectory = safeGetCWD();
      let esmWorkingDirectory;
      for (let line of lines) {
        const core = RegExpPrototypeExec(coreModuleRegExp, line);
        if (core !== null && BuiltinModule.exists(core[1])) {
          newStack += `\n${ctx.stylize(line, 'undefined')}`;
        } else {
          newStack += '\n';

          line = markNodeModules(ctx, line);
          if (workingDirectory !== undefined) {
            let newLine = markCwd(ctx, line, workingDirectory);
            if (newLine === line) {
              esmWorkingDirectory ??= pathToFileUrlHref(workingDirectory);
              newLine = markCwd(ctx, line, esmWorkingDirectory);
            }
            line = newLine;
          }

          newStack += line;
        }
      }
    } else {
      newStack += `\n${ArrayPrototypeJoin(lines, '\n')}`;
    }
    stack = newStack;
  }
  // The message and the stack have to be indented as well!
  if (ctx.indentationLvl !== 0) {
    const indentation = StringPrototypeRepeat(' ', ctx.indentationLvl);
    stack = StringPrototypeReplaceAll(stack, '\n', `\n${indentation}`);
  }
  return stack;
}

function groupArrayElements(ctx, output, value) {
  let totalLength = 0;
  let maxLength = 0;
  let i = 0;
  let outputLength = output.length;
  if (ctx.maxArrayLength < output.length) {
    // This makes sure the "... n more items" part is not taken into account.
    outputLength--;
  }
  const separatorSpace = 2; // Add 1 for the space and 1 for the separator.
  const dataLen = new Array(outputLength);
  // Calculate the total length of all output entries and the individual max
  // entries length of all output entries. We have to remove colors first,
  // otherwise the length would not be calculated properly.
  for (; i < outputLength; i++) {
    const len = getStringWidth(output[i], ctx.colors);
    dataLen[i] = len;
    totalLength += len + separatorSpace;
    if (maxLength < len)
      maxLength = len;
  }
  // Add two to `maxLength` as we add a single whitespace character plus a comma
  // in-between two entries.
  const actualMax = maxLength + separatorSpace;
  // Check if at least three entries fit next to each other and prevent grouping
  // of arrays that contains entries of very different length (i.e., if a single
  // entry is longer than 1/5 of all other entries combined). Otherwise the
  // space in-between small entries would be enormous.
  if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
      (totalLength / actualMax > 5 || maxLength <= 6)) {

    const approxCharHeights = 2.5;
    const averageBias = MathSqrt(actualMax - totalLength / output.length);
    const biasedMax = MathMax(actualMax - 3 - averageBias, 1);
    // Dynamically check how many columns seem possible.
    const columns = MathMin(
      // Ideally a square should be drawn. We expect a character to be about 2.5
      // times as high as wide. This is the area formula to calculate a square
      // which contains n rectangles of size `actualMax * approxCharHeights`.
      // Divide that by `actualMax` to receive the correct number of columns.
      // The added bias increases the columns for short entries.
      MathRound(
        MathSqrt(
          approxCharHeights * biasedMax * outputLength,
        ) / biasedMax,
      ),
      // Do not exceed the breakLength.
      MathFloor((ctx.breakLength - ctx.indentationLvl) / actualMax),
      // Limit array grouping for small `compact` modes as the user requested
      // minimal grouping.
      ctx.compact * 4,
      // Limit the columns to a maximum of fifteen.
      15,
    );
    // Return with the original output if no grouping should happen.
    if (columns <= 1) {
      return output;
    }
    const tmp = [];
    const maxLineLength = [];
    for (let i = 0; i < columns; i++) {
      let lineMaxLength = 0;
      for (let j = i; j < output.length; j += columns) {
        if (dataLen[j] > lineMaxLength)
          lineMaxLength = dataLen[j];
      }
      lineMaxLength += separatorSpace;
      maxLineLength[i] = lineMaxLength;
    }
    let order = StringPrototypePadStart;
    if (value !== undefined) {
      for (let i = 0; i < output.length; i++) {
        if (typeof value[i] !== 'number' && typeof value[i] !== 'bigint') {
          order = StringPrototypePadEnd;
          break;
        }
      }
    }
    // Each iteration creates a single line of grouped entries.
    for (let i = 0; i < outputLength; i += columns) {
      // The last lines may contain less entries than columns.
      const max = MathMin(i + columns, outputLength);
      let str = '';
      let j = i;
      for (; j < max - 1; j++) {
        // Calculate extra color padding in case it's active. This has to be
        // done line by line as some lines might contain more colors than
        // others.
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j];
        str += order(`${output[j]}, `, padding, ' ');
      }
      if (order === StringPrototypePadStart) {
        const padding = maxLineLength[j - i] +
                        output[j].length -
                        dataLen[j] -
                        separatorSpace;
        str += StringPrototypePadStart(output[j], padding, ' ');
      } else {
        str += output[j];
      }
      ArrayPrototypePush(tmp, str);
    }
    if (ctx.maxArrayLength < output.length) {
      ArrayPrototypePush(tmp, output[outputLength]);
    }
    output = tmp;
  }
  return output;
}

function handleMaxCallStackSize(ctx, err, constructorName, indentationLvl) {
  ctx.seen.pop();
  ctx.indentationLvl = indentationLvl;
  return ctx.stylize(
    `[${constructorName}: Inspection interrupted ` +
      'prematurely. Maximum call stack size exceeded.]',
    'special',
  );
}

function addNumericSeparator(integerString) {
  let result = '';
  let i = integerString.length;
  assert(i !== 0);
  const start = integerString[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    result = `_${StringPrototypeSlice(integerString, i - 3, i)}${result}`;
  }
  return i === integerString.length ?
    integerString :
    `${StringPrototypeSlice(integerString, 0, i)}${result}`;
}

function addNumericSeparatorEnd(integerString) {
  let result = '';
  let i = 0;
  for (; i < integerString.length - 3; i += 3) {
    result += `${StringPrototypeSlice(integerString, i, i + 3)}_`;
  }
  return i === 0 ?
    integerString :
    `${result}${StringPrototypeSlice(integerString, i)}`;
}

const remainingText = (remaining) => `... ${remaining} more item${remaining > 1 ? 's' : ''}`;

function formatNumber(fn, number, numericSeparator) {
  if (!numericSeparator) {
    // Format -0 as '-0'. Checking `number === -0` won't distinguish 0 from -0.
    if (ObjectIs(number, -0)) {
      return fn('-0', 'number');
    }
    return fn(`${number}`, 'number');
  }

  const numberString = String(number);
  const integer = MathTrunc(number);

  if (integer === number) {
    if (!NumberIsFinite(number) || StringPrototypeIncludes(numberString, 'e')) {
      return fn(numberString, 'number');
    }
    return fn(addNumericSeparator(numberString), 'number');
  }
  if (NumberIsNaN(number)) {
    return fn(numberString, 'number');
  }

  const decimalIndex = StringPrototypeIndexOf(numberString, '.');
  const integerPart = StringPrototypeSlice(numberString, 0, decimalIndex);
  const fractionalPart = StringPrototypeSlice(numberString, decimalIndex + 1);

  return fn(`${
    addNumericSeparator(integerPart)
  }.${
    addNumericSeparatorEnd(fractionalPart)
  }`, 'number');
}

function formatBigInt(fn, bigint, numericSeparator) {
  const string = String(bigint);
  if (!numericSeparator) {
    return fn(`${string}n`, 'bigint');
  }
  return fn(`${addNumericSeparator(string)}n`, 'bigint');
}

function formatPrimitive(fn, value, ctx) {
  if (typeof value === 'string') {
    let trailer = '';
    if (value.length > ctx.maxStringLength) {
      const remaining = value.length - ctx.maxStringLength;
      value = StringPrototypeSlice(value, 0, ctx.maxStringLength);
      trailer = `... ${remaining} more character${remaining > 1 ? 's' : ''}`;
    }
    if (ctx.compact !== true &&
        // We do not support handling unicode characters width with
        // the readline getStringWidth function as there are
        // performance implications.
        value.length > kMinLineLength &&
        value.length > ctx.breakLength - ctx.indentationLvl - 4) {
      return ArrayPrototypeJoin(
        ArrayPrototypeMap(
          RegExpPrototypeSymbolSplit(/(?<=\n)/, value),
          (line) => fn(strEscape(line), 'string'),
        ),
        ` +\n${StringPrototypeRepeat(' ', ctx.indentationLvl + 2)}`,
      ) + trailer;
    }
    return fn(strEscape(value), 'string') + trailer;
  }
  if (typeof value === 'number')
    return formatNumber(fn, value, ctx.numericSeparator);
  if (typeof value === 'bigint')
    return formatBigInt(fn, value, ctx.numericSeparator);
  if (typeof value === 'boolean')
    return fn(`${value}`, 'boolean');
  if (typeof value === 'undefined')
    return fn('undefined', 'undefined');
  // es6 symbol primitive
  return fn(SymbolPrototypeToString(value), 'symbol');
}

function formatNamespaceObject(keys, ctx, value, recurseTimes) {
  const output = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    try {
      output[i] = formatProperty(ctx, value, recurseTimes, keys[i],
                                 kObjectType);
    } catch (err) {
      assert(isNativeError(err) && err.name === 'ReferenceError');
      // Use the existing functionality. This makes sure the indentation and
      // line breaks are always correct. Otherwise it is very difficult to keep
      // this aligned, even though this is a hacky way of dealing with this.
      const tmp = { [keys[i]]: '' };
      output[i] = formatProperty(ctx, tmp, recurseTimes, keys[i], kObjectType);
      const pos = StringPrototypeLastIndexOf(output[i], ' ');
      // We have to find the last whitespace and have to replace that value as
      // it will be visualized as a regular string.
      output[i] = StringPrototypeSlice(output[i], 0, pos + 1) +
                  ctx.stylize('<uninitialized>', 'special');
    }
  }
  // Reset the keys to an empty array. This prevents duplicated inspection.
  keys.length = 0;
  return output;
}

// The array is sparse and/or has extra keys
function formatSpecialArray(ctx, value, recurseTimes, maxLength, output, i) {
  const keys = ObjectKeys(value);
  let index = i;
  for (; i < keys.length && output.length < maxLength; i++) {
    const key = keys[i];
    const tmp = +key;
    // Arrays can only have up to 2^32 - 1 entries
    if (tmp > 2 ** 32 - 2) {
      break;
    }
    if (`${index}` !== key) {
      if (RegExpPrototypeExec(numberRegExp, key) === null) {
        break;
      }
      const emptyItems = tmp - index;
      const ending = emptyItems > 1 ? 's' : '';
      const message = `<${emptyItems} empty item${ending}>`;
      ArrayPrototypePush(output, ctx.stylize(message, 'undefined'));
      index = tmp;
      if (output.length === maxLength) {
        break;
      }
    }
    ArrayPrototypePush(output, formatProperty(ctx, value, recurseTimes, key, kArrayType));
    index++;
  }
  const remaining = value.length - index;
  if (output.length !== maxLength) {
    if (remaining > 0) {
      const ending = remaining > 1 ? 's' : '';
      const message = `<${remaining} empty item${ending}>`;
      ArrayPrototypePush(output, ctx.stylize(message, 'undefined'));
    }
  } else if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatArrayBuffer(ctx, value) {
  let buffer;
  try {
    buffer = new Uint8Array(value);
  } catch {
    return [ctx.stylize('(detached)', 'special')];
  }
  if (hexSlice === undefined)
    hexSlice = uncurryThis(require('buffer').Buffer.prototype.hexSlice);
  const rawString = hexSlice(buffer, 0, MathMin(ctx.maxArrayLength, buffer.length));
  let str = '';
  let i = 0;
  for (; i < rawString.length - 2; i += 2) {
    str += `${rawString[i]}${rawString[i + 1]} `;
  }
  if (rawString.length > 0) {
    str += `${rawString[i]}${rawString[i + 1]}`;
  }
  const remaining = buffer.length - ctx.maxArrayLength;
  if (remaining > 0)
    str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
  return [`${ctx.stylize('[Uint8Contents]', 'special')}: <${str}>`];
}

function formatArray(ctx, value, recurseTimes) {
  const valLen = value.length;
  const len = MathMin(MathMax(0, ctx.maxArrayLength), valLen);

  const remaining = valLen - len;
  const output = [];
  for (let i = 0; i < len; i++) {
    const desc = ObjectGetOwnPropertyDescriptor(value, i);
    if (desc === undefined) {
      // Special handle sparse arrays.
      return formatSpecialArray(ctx, value, recurseTimes, len, output, i);
    }
    ArrayPrototypePush(output, formatProperty(ctx, value, recurseTimes, i, kArrayType, desc));
  }
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatTypedArray(value, length, ctx) {
  const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
  const remaining = value.length - maxLength;
  const output = new Array(maxLength);
  const elementFormatter = value.length > 0 && typeof value[0] === 'number' ?
    formatNumber :
    formatBigInt;
  for (let i = 0; i < maxLength; ++i) {
    output[i] = elementFormatter(ctx.stylize, value[i], ctx.numericSeparator);
  }
  if (remaining > 0) {
    output[maxLength] = remainingText(remaining);
  }
  return output;
}

function formatSet(value, ctx, ignored, recurseTimes) {
  const length = value.size;
  const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
  const remaining = length - maxLength;
  const output = [];
  ctx.indentationLvl += 2;
  let i = 0;
  for (const v of value) {
    if (i >= maxLength) break;
    ArrayPrototypePush(output, formatValue(ctx, v, recurseTimes));
    i++;
  }
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  ctx.indentationLvl -= 2;
  return output;
}

function formatMap(value, ctx, ignored, recurseTimes) {
  const length = value.size;
  const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
  const remaining = length - maxLength;
  const output = [];
  ctx.indentationLvl += 2;
  let i = 0;
  for (const { 0: k, 1: v } of value) {
    if (i >= maxLength) break;
    ArrayPrototypePush(
      output,
      `${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`,
    );
    i++;
  }
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  ctx.indentationLvl -= 2;
  return output;
}

function formatSetIterInner(ctx, recurseTimes, entries, state) {
  const maxArrayLength = MathMax(ctx.maxArrayLength, 0);
  const maxLength = MathMin(maxArrayLength, entries.length);
  const output = new Array(maxLength);
  ctx.indentationLvl += 2;
  for (let i = 0; i < maxLength; i++) {
    output[i] = formatValue(ctx, entries[i], recurseTimes);
  }
  ctx.indentationLvl -= 2;
  if (state === kWeak && !ctx.sorted) {
    // Sort all entries to have a halfway reliable output (if more entries than
    // retrieved ones exist, we can not reliably return the same output) if the
    // output is not sorted anyway.
    ArrayPrototypeSort(output);
  }
  const remaining = entries.length - maxLength;
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatMapIterInner(ctx, recurseTimes, entries, state) {
  const maxArrayLength = MathMax(ctx.maxArrayLength, 0);
  // Entries exist as [key1, val1, key2, val2, ...]
  const len = entries.length / 2;
  const remaining = len - maxArrayLength;
  const maxLength = MathMin(maxArrayLength, len);
  const output = new Array(maxLength);
  let i = 0;
  ctx.indentationLvl += 2;
  if (state === kWeak) {
    for (; i < maxLength; i++) {
      const pos = i * 2;
      output[i] =
        `${formatValue(ctx, entries[pos], recurseTimes)} => ${formatValue(ctx, entries[pos + 1], recurseTimes)}`;
    }
    // Sort all entries to have a halfway reliable output (if more entries than
    // retrieved ones exist, we can not reliably return the same output) if the
    // output is not sorted anyway.
    if (!ctx.sorted)
      ArrayPrototypeSort(output);
  } else {
    for (; i < maxLength; i++) {
      const pos = i * 2;
      const res = [
        formatValue(ctx, entries[pos], recurseTimes),
        formatValue(ctx, entries[pos + 1], recurseTimes),
      ];
      output[i] = reduceToSingleString(
        ctx, res, '', ['[', ']'], kArrayExtrasType, recurseTimes);
    }
  }
  ctx.indentationLvl -= 2;
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatWeakCollection(ctx) {
  return [ctx.stylize('<items unknown>', 'special')];
}

function formatWeakSet(ctx, value, recurseTimes) {
  const entries = previewEntries(value);
  return formatSetIterInner(ctx, recurseTimes, entries, kWeak);
}

function formatWeakMap(ctx, value, recurseTimes) {
  const entries = previewEntries(value);
  return formatMapIterInner(ctx, recurseTimes, entries, kWeak);
}

function formatIterator(braces, ctx, value, recurseTimes) {
  const { 0: entries, 1: isKeyValue } = previewEntries(value, true);
  if (isKeyValue) {
    // Mark entry iterators as such.
    braces[0] = RegExpPrototypeSymbolReplace(/ Iterator] {$/, braces[0], ' Entries] {');
    return formatMapIterInner(ctx, recurseTimes, entries, kMapEntries);
  }

  return formatSetIterInner(ctx, recurseTimes, entries, kIterator);
}

function formatPromise(ctx, value, recurseTimes) {
  let output;
  const { 0: state, 1: result } = getPromiseDetails(value);
  if (state === kPending) {
    output = [ctx.stylize('<pending>', 'special')];
  } else {
    ctx.indentationLvl += 2;
    const str = formatValue(ctx, result, recurseTimes);
    ctx.indentationLvl -= 2;
    output = [
      state === kRejected ?
        `${ctx.stylize('<rejected>', 'special')} ${str}` :
        str,
    ];
  }
  return output;
}

function formatExtraProperties(ctx, value, recurseTimes, key, typedArray) {
  ctx.indentationLvl += 2;
  const str = formatValue(ctx, value[key], recurseTimes, typedArray);
  ctx.indentationLvl -= 2;

  // These entries are mainly getters. Should they be formatted like getters?
  const name = ctx.stylize(`[${key}]`, 'string');
  return `${name}: ${str}`;
}

function formatProperty(ctx, value, recurseTimes, key, type, desc,
                        original = value) {
  let name, str;
  let extra = ' ';
  desc ??= ObjectGetOwnPropertyDescriptor(value, key);
  if (desc.value !== undefined) {
    const diff = (ctx.compact !== true || type !== kObjectType) ? 2 : 3;
    ctx.indentationLvl += diff;
    str = formatValue(ctx, desc.value, recurseTimes);
    if (diff === 3 && ctx.breakLength < getStringWidth(str, ctx.colors)) {
      extra = `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`;
    }
    ctx.indentationLvl -= diff;
  } else if (desc.get !== undefined) {
    const label = desc.set !== undefined ? 'Getter/Setter' : 'Getter';
    const s = ctx.stylize;
    const sp = 'special';
    if (ctx.getters && (ctx.getters === true ||
          (ctx.getters === 'get' && desc.set === undefined) ||
          (ctx.getters === 'set' && desc.set !== undefined))) {
      try {
        const tmp = FunctionPrototypeCall(desc.get, original);
        ctx.indentationLvl += 2;
        if (tmp === null) {
          str = `${s(`[${label}:`, sp)} ${s('null', 'null')}${s(']', sp)}`;
        } else if (typeof tmp === 'object') {
          str = `${s(`[${label}]`, sp)} ${formatValue(ctx, tmp, recurseTimes)}`;
        } else {
          const primitive = formatPrimitive(s, tmp, ctx);
          str = `${s(`[${label}:`, sp)} ${primitive}${s(']', sp)}`;
        }
        ctx.indentationLvl -= 2;
      } catch (err) {
        const message = `<Inspection threw (${err.message})>`;
        str = `${s(`[${label}:`, sp)} ${message}${s(']', sp)}`;
      }
    } else {
      str = ctx.stylize(`[${label}]`, sp);
    }
  } else if (desc.set !== undefined) {
    str = ctx.stylize('[Setter]', 'special');
  } else {
    str = ctx.stylize('undefined', 'undefined');
  }
  if (type === kArrayType) {
    return str;
  }
  if (typeof key === 'symbol') {
    const tmp = RegExpPrototypeSymbolReplace(
      strEscapeSequencesReplacer,
      SymbolPrototypeToString(key),
      escapeFn,
    );
    name = `[${ctx.stylize(tmp, 'symbol')}]`;
  } else if (key === '__proto__') {
    name = "['__proto__']";
  } else if (desc.enumerable === false) {
    const tmp = RegExpPrototypeSymbolReplace(
      strEscapeSequencesReplacer,
      key,
      escapeFn,
    );
    name = `[${tmp}]`;
  } else if (RegExpPrototypeExec(keyStrRegExp, key) !== null) {
    name = ctx.stylize(key, 'name');
  } else {
    name = ctx.stylize(strEscape(key), 'string');
  }
  return `${name}:${extra}${str}`;
}

function isBelowBreakLength(ctx, output, start, base) {
  // Each entry is separated by at least a comma. Thus, we start with a total
  // length of at least `output.length`. In addition, some cases have a
  // whitespace in-between each other that is added to the total as well.
  // TODO(BridgeAR): Add unicode support. Use the readline getStringWidth
  // function. Check the performance overhead and make it an opt-in in case it's
  // significant.
  let totalLength = output.length + start;
  if (totalLength + output.length > ctx.breakLength)
    return false;
  for (let i = 0; i < output.length; i++) {
    if (ctx.colors) {
      totalLength += removeColors(output[i]).length;
    } else {
      totalLength += output[i].length;
    }
    if (totalLength > ctx.breakLength) {
      return false;
    }
  }
  // Do not line up properties on the same line if `base` contains line breaks.
  return base === '' || !StringPrototypeIncludes(base, '\n');
}

function reduceToSingleString(
  ctx, output, base, braces, extrasType, recurseTimes, value) {
  if (ctx.compact !== true) {
    if (typeof ctx.compact === 'number' && ctx.compact >= 1) {
      // Memorize the original output length. In case the output is grouped,
      // prevent lining up the entries on a single line.
      const entries = output.length;
      // Group array elements together if the array contains at least six
      // separate entries.
      if (extrasType === kArrayExtrasType && entries > 6) {
        output = groupArrayElements(ctx, output, value);
      }
      // `ctx.currentDepth` is set to the most inner depth of the currently
      // inspected object part while `recurseTimes` is the actual current depth
      // that is inspected.
      //
      // Example:
      //
      // const a = { first: [ 1, 2, 3 ], second: { inner: [ 1, 2, 3 ] } }
      //
      // The deepest depth of `a` is 2 (a.second.inner) and `a.first` has a max
      // depth of 1.
      //
      // Consolidate all entries of the local most inner depth up to
      // `ctx.compact`, as long as the properties are smaller than
      // `ctx.breakLength`.
      if (ctx.currentDepth - recurseTimes < ctx.compact &&
          entries === output.length) {
        // Line up all entries on a single line in case the entries do not
        // exceed `breakLength`. Add 10 as constant to start next to all other
        // factors that may reduce `breakLength`.
        const start = output.length + ctx.indentationLvl +
                      braces[0].length + base.length + 10;
        if (isBelowBreakLength(ctx, output, start, base)) {
          const joinedOutput = join(output, ', ');
          if (!StringPrototypeIncludes(joinedOutput, '\n')) {
            return `${base ? `${base} ` : ''}${braces[0]} ${joinedOutput}` +
              ` ${braces[1]}`;
          }
        }
      }
    }
    // Line up each entry on an individual line.
    const indentation = `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`;
    return `${base ? `${base} ` : ''}${braces[0]}${indentation}  ` +
      `${join(output, `,${indentation}  `)}${indentation}${braces[1]}`;
  }
  // Line up all entries on a single line in case the entries do not exceed
  // `breakLength`.
  if (isBelowBreakLength(ctx, output, 0, base)) {
    return `${braces[0]}${base ? ` ${base}` : ''} ${join(output, ', ')} ` +
      braces[1];
  }
  const indentation = StringPrototypeRepeat(' ', ctx.indentationLvl);
  // If the opening "brace" is too large, like in the case of "Set {",
  // we need to force the first item to be on the next line or the
  // items will not line up correctly.
  const ln = base === '' && braces[0].length === 1 ?
    ' ' : `${base ? ` ${base}` : ''}\n${indentation}  `;
  // Line up each entry on an individual line.
  return `${braces[0]}${ln}${join(output, `,\n${indentation}  `)} ${braces[1]}`;
}

function hasBuiltInToString(value) {
  // Prevent triggering proxy traps.
  const getFullProxy = false;
  const proxyTarget = getProxyDetails(value, getFullProxy);
  if (proxyTarget !== undefined) {
    if (proxyTarget === null) {
      return true;
    }
    value = proxyTarget;
  }

  let hasOwnToString = ObjectPrototypeHasOwnProperty;
  let hasOwnToPrimitive = ObjectPrototypeHasOwnProperty;

  // Count objects without `toString` and `Symbol.toPrimitive` function as built-in.
  if (typeof value.toString !== 'function') {
    if (typeof value[SymbolToPrimitive] !== 'function') {
      return true;
    } else if (ObjectPrototypeHasOwnProperty(value, SymbolToPrimitive)) {
      return false;
    }
    hasOwnToString = returnFalse;
  } else if (ObjectPrototypeHasOwnProperty(value, 'toString')) {
    return false;
  } else if (typeof value[SymbolToPrimitive] !== 'function') {
    hasOwnToPrimitive = returnFalse;
  } else if (ObjectPrototypeHasOwnProperty(value, SymbolToPrimitive)) {
    return false;
  }

  // Find the object that has the `toString` property or `Symbol.toPrimitive` property
  // as own property in the prototype chain.
  let pointer = value;
  do {
    pointer = ObjectGetPrototypeOf(pointer);
  } while (!hasOwnToString(pointer, 'toString') &&
    !hasOwnToPrimitive(pointer, SymbolToPrimitive));

  // Check closer if the object is a built-in.
  const descriptor = ObjectGetOwnPropertyDescriptor(pointer, 'constructor');
  return descriptor !== undefined &&
    typeof descriptor.value === 'function' &&
    builtInObjects.has(descriptor.value.name);
}

function returnFalse() {
  return false;
}

const firstErrorLine = (error) => StringPrototypeSplit(error.message, '\n', 1)[0];
let CIRCULAR_ERROR_MESSAGE;
function tryStringify(arg) {
  try {
    return JSONStringify(arg);
  } catch (err) {
    // Populate the circular error message lazily
    if (!CIRCULAR_ERROR_MESSAGE) {
      try {
        const a = {};
        a.a = a;
        JSONStringify(a);
      } catch (circularError) {
        CIRCULAR_ERROR_MESSAGE = firstErrorLine(circularError);
      }
    }
    if (err.name === 'TypeError' &&
        firstErrorLine(err) === CIRCULAR_ERROR_MESSAGE) {
      return '[Circular]';
    }
    throw err;
  }
}

function format(...args) {
  return formatWithOptionsInternal(undefined, args);
}

function formatWithOptions(inspectOptions, ...args) {
  validateObject(inspectOptions, 'inspectOptions', kValidateObjectAllowArray);
  return formatWithOptionsInternal(inspectOptions, args);
}

function formatNumberNoColor(number, options) {
  return formatNumber(
    stylizeNoColor,
    number,
    options?.numericSeparator ?? inspectDefaultOptions.numericSeparator,
  );
}

function formatBigIntNoColor(bigint, options) {
  return formatBigInt(
    stylizeNoColor,
    bigint,
    options?.numericSeparator ?? inspectDefaultOptions.numericSeparator,
  );
}

function formatWithOptionsInternal(inspectOptions, args) {
  const first = args[0];
  let a = 0;
  let str = '';
  let join = '';

  if (typeof first === 'string') {
    if (args.length === 1) {
      return first;
    }
    let tempStr;
    let lastPos = 0;

    for (let i = 0; i < first.length - 1; i++) {
      if (StringPrototypeCharCodeAt(first, i) === 37) { // '%'
        const nextChar = StringPrototypeCharCodeAt(first, ++i);
        if (a + 1 !== args.length) {
          switch (nextChar) {
            case 115: { // 's'
              const tempArg = args[++a];
              if (typeof tempArg === 'number') {
                tempStr = formatNumberNoColor(tempArg, inspectOptions);
              } else if (typeof tempArg === 'bigint') {
                tempStr = formatBigIntNoColor(tempArg, inspectOptions);
              } else if (typeof tempArg !== 'object' ||
                         tempArg === null ||
                         !hasBuiltInToString(tempArg)) {
                tempStr = String(tempArg);
              } else {
                tempStr = inspect(tempArg, {
                  ...inspectOptions,
                  compact: 3,
                  colors: false,
                  depth: 0,
                });
              }
              break;
            }
            case 106: // 'j'
              tempStr = tryStringify(args[++a]);
              break;
            case 100: { // 'd'
              const tempNum = args[++a];
              if (typeof tempNum === 'bigint') {
                tempStr = formatBigIntNoColor(tempNum, inspectOptions);
              } else if (typeof tempNum === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberNoColor(Number(tempNum), inspectOptions);
              }
              break;
            }
            case 79: // 'O'
              tempStr = inspect(args[++a], inspectOptions);
              break;
            case 111: // 'o'
              tempStr = inspect(args[++a], {
                ...inspectOptions,
                showHidden: true,
                showProxy: true,
                depth: 4,
              });
              break;
            case 105: { // 'i'
              const tempInteger = args[++a];
              if (typeof tempInteger === 'bigint') {
                tempStr = formatBigIntNoColor(tempInteger, inspectOptions);
              } else if (typeof tempInteger === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberNoColor(
                  NumberParseInt(tempInteger), inspectOptions);
              }
              break;
            }
            case 102: { // 'f'
              const tempFloat = args[++a];
              if (typeof tempFloat === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberNoColor(
                  NumberParseFloat(tempFloat), inspectOptions);
              }
              break;
            }
            case 99: // 'c'
              a += 1;
              tempStr = '';
              break;
            case 37: // '%'
              str += StringPrototypeSlice(first, lastPos, i);
              lastPos = i + 1;
              continue;
            default: // Any other character is not a correct placeholder
              continue;
          }
          if (lastPos !== i - 1) {
            str += StringPrototypeSlice(first, lastPos, i - 1);
          }
          str += tempStr;
          lastPos = i + 1;
        } else if (nextChar === 37) {
          str += StringPrototypeSlice(first, lastPos, i);
          lastPos = i + 1;
        }
      }
    }
    if (lastPos !== 0) {
      a++;
      join = ' ';
      if (lastPos < first.length) {
        str += StringPrototypeSlice(first, lastPos);
      }
    }
  }

  while (a < args.length) {
    const value = args[a];
    str += join;
    str += typeof value !== 'string' ? inspect(value, inspectOptions) : value;
    join = ' ';
    a++;
  }
  return str;
}

function isZeroWidthCodePoint(code) {
  return code <= 0x1F || // C0 control codes
    (code >= 0x7F && code <= 0x9F) || // C1 control codes
    (code >= 0x300 && code <= 0x36F) || // Combining Diacritical Marks
    (code >= 0x200B && code <= 0x200F) || // Modifying Invisible Characters
    // Combining Diacritical Marks for Symbols
    (code >= 0x20D0 && code <= 0x20FF) ||
    (code >= 0xFE00 && code <= 0xFE0F) || // Variation Selectors
    (code >= 0xFE20 && code <= 0xFE2F) || // Combining Half Marks
    (code >= 0xE0100 && code <= 0xE01EF); // Variation Selectors
}

if (internalBinding('config').hasIntl) {
  const icu = internalBinding('icu');
  // icu.getStringWidth(string, ambiguousAsFullWidth, expandEmojiSequence)
  // Defaults: ambiguousAsFullWidth = false; expandEmojiSequence = true;
  // TODO(BridgeAR): Expose the options to the user. That is probably the
  // best thing possible at the moment, since it's difficult to know what
  // the receiving end supports.
  getStringWidth = function getStringWidth(str, removeControlChars = true) {
    let width = 0;

    if (removeControlChars) {
      str = stripVTControlCharacters(str);
    }
    for (let i = 0; i < str.length; i++) {
      // Try to avoid calling into C++ by first handling the ASCII portion of
      // the string. If it is fully ASCII, we skip the C++ part.
      const code = str.charCodeAt(i);
      if (code >= 127) {
        width += icu.getStringWidth(StringPrototypeNormalize(StringPrototypeSlice(str, i), 'NFC'));
        break;
      }
      width += code >= 32 ? 1 : 0;
    }
    return width;
  };
} else {
  /**
   * Returns the number of columns required to display the given string.
   */
  getStringWidth = function getStringWidth(str, removeControlChars = true) {
    let width = 0;

    if (removeControlChars)
      str = stripVTControlCharacters(str);
    str = StringPrototypeNormalize(str, 'NFC');
    for (const char of new SafeStringIterator(str)) {
      const code = StringPrototypeCodePointAt(char, 0);
      if (isFullWidthCodePoint(code)) {
        width += 2;
      } else if (!isZeroWidthCodePoint(code)) {
        width++;
      }
    }

    return width;
  };

  /**
   * Returns true if the character represented by a given
   * Unicode code point is full-width. Otherwise returns false.
   */
  const isFullWidthCodePoint = (code) => {
    // Code points are partially derived from:
    // https://www.unicode.org/Public/UNIDATA/EastAsianWidth.txt
    return code >= 0x1100 && (
      code <= 0x115f ||  // Hangul Jamo
      code === 0x2329 || // LEFT-POINTING ANGLE BRACKET
      code === 0x232a || // RIGHT-POINTING ANGLE BRACKET
      // CJK Radicals Supplement .. Enclosed CJK Letters and Months
      (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
      // Enclosed CJK Letters and Months .. CJK Unified Ideographs Extension A
      (code >= 0x3250 && code <= 0x4dbf) ||
      // CJK Unified Ideographs .. Yi Radicals
      (code >= 0x4e00 && code <= 0xa4c6) ||
      // Hangul Jamo Extended-A
      (code >= 0xa960 && code <= 0xa97c) ||
      // Hangul Syllables
      (code >= 0xac00 && code <= 0xd7a3) ||
      // CJK Compatibility Ideographs
      (code >= 0xf900 && code <= 0xfaff) ||
      // Vertical Forms
      (code >= 0xfe10 && code <= 0xfe19) ||
      // CJK Compatibility Forms .. Small Form Variants
      (code >= 0xfe30 && code <= 0xfe6b) ||
      // Halfwidth and Fullwidth Forms
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      // Kana Supplement
      (code >= 0x1b000 && code <= 0x1b001) ||
      // Enclosed Ideographic Supplement
      (code >= 0x1f200 && code <= 0x1f251) ||
      // Miscellaneous Symbols and Pictographs 0x1f300 - 0x1f5ff
      // Emoticons 0x1f600 - 0x1f64f
      (code >= 0x1f300 && code <= 0x1f64f) ||
      // CJK Unified Ideographs Extension B .. Tertiary Ideographic Plane
      (code >= 0x20000 && code <= 0x3fffd)
    );
  };

}

/**
 * Remove all VT control characters. Use to estimate displayed string width.
 */
function stripVTControlCharacters(str) {
  validateString(str, 'str');

  return RegExpPrototypeSymbolReplace(ansi, str, '');
}

module.exports = {
  identicalSequenceRange,
  inspect,
  inspectDefaultOptions,
  format,
  formatWithOptions,
  getStringWidth,
  stripVTControlCharacters,
  isZeroWidthCodePoint,
};

    },
  });
  return __nimbusNodeInspectExports;
}
// util.inspect, which loads Node's the first time it formats: its custom
// symbol is Node's registered one, its options and styles Node's own.
function __nimbusInspect(value, options) {
  return Reflect.apply(__nimbusNodeInspect().inspect, this, arguments);
}
Object.defineProperties(__nimbusInspect, {
  name: { value: "inspect" },
  custom: { value: Symbol.for("nodejs.util.inspect.custom"), writable: true, enumerable: true, configurable: true },
  defaultOptions: {
    get() { return __nimbusNodeInspect().inspect.defaultOptions; },
    set(options) { __nimbusNodeInspect().inspect.defaultOptions = options; },
    enumerable: true, configurable: true,
  },
  colors: { get() { return __nimbusNodeInspect().inspect.colors; }, set(value) { __nimbusNodeInspect().inspect.colors = value; }, enumerable: true, configurable: true },
  styles: { get() { return __nimbusNodeInspect().inspect.styles; }, set(value) { __nimbusNodeInspect().inspect.styles = value; }, enumerable: true, configurable: true },
});
const __utilMod = {
  inspect: __nimbusInspect,
  format: function format(...args) { return __nimbusNodeInspect().format(...args); },
  formatWithOptions: function formatWithOptions(options, ...args) { return __nimbusNodeInspect().formatWithOptions(options, ...args); },
  stripVTControlCharacters: function stripVTControlCharacters(str) { return __nimbusNodeInspect().stripVTControlCharacters(str); },
  promisify: (fn) => (...a) => new Promise((res, rej) => fn(...a, (e, r) => e ? rej(e) : res(r))),
  callbackify: (fn) => (...a) => { const cb = a.pop(); fn(...a).then(r => cb(null, r), e => cb(e)); },
  // X.5-Q: util.types polyfill expansion. The pre-X.5-Q 3-method shape
  // (isDate, isRegExp, isPromise) was insufficient for jsdom's bundled
  // undici, which dereferences isUint8Array (lib/web/fetch/util.js +
  // body.js), isArrayBuffer (lib/web/websocket/websocket.js), and
  // util.types.isProxy (lib/web/fetch/headers.js). Expanding to the
  // 17-method shape below mirrors Node.js's util.types surface for the
  // common cases; isProxy returns false (no userland Proxy detection).
  types: {
    isDate: (v) => v instanceof Date,
    isRegExp: (v) => v instanceof RegExp,
    isPromise: (v) => v instanceof Promise,
    isUint8Array: (v) => v instanceof Uint8Array,
    isArrayBuffer: (v) => v instanceof ArrayBuffer,
    isAnyArrayBuffer: (v) => v instanceof ArrayBuffer
      || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer),
    isArrayBufferView: (v) => ArrayBuffer.isView(v),
    isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
    isMap: (v) => v instanceof Map,
    isSet: (v) => v instanceof Set,
    isWeakMap: (v) => v instanceof WeakMap,
    isWeakSet: (v) => v instanceof WeakSet,
    isNativeError: (v) => v instanceof Error,
    isAsyncFunction: (v) => v && v.constructor && v.constructor.name === "AsyncFunction",
    isGeneratorFunction: (v) => v && v.constructor && v.constructor.name === "GeneratorFunction",
    isProxy: (v) => false,
    isBoxedPrimitive: (v) => v instanceof Boolean || v instanceof Number
      || v instanceof String || (typeof v === "object" && v !== null && (v.constructor === Symbol || v.constructor === BigInt)),
  },
  inherits: (c, s) => {
    // X.5-Z5 Defect-B fix: guard against null/undefined superCtor or a
    // superCtor whose .prototype is null/undefined. Without this guard,
    // Object.create(undefined.prototype, ...) and Object.create(null, ...)
    // both throw 'Object prototype may only be an Object or null: undefined'
    // — same surface as Defect A but for shim namespaces with no synthetic
    // .prototype. Mirrors the canonical inherits_browser.js fallback.
    if (s == null || s.prototype == null) return;
    c.super_ = s;
    c.prototype = Object.create(s.prototype, { constructor: { value: c, enumerable: false, writable: true, configurable: true } });
  },
  deprecate: (fn, msg) => fn,
  debuglog: () => () => {},
  isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  // util.styleText(format, text [, opts]) — Node 20.12+. Returns text
  // wrapped in ANSI escape sequences for terminal styling. Used by
  // create-vite and many modern CLIs.
  //
  // Surface: format may be a single style string or an array of style
  // strings; in either case we apply each style's open code, then the
  // text, then the closing code. The Nimbus terminal renders ANSI;
  // unrecognised formats pass through as plain text (Node's docs say
  // it throws TypeError in strict mode, but our facet code may emit
  // styled error messages even for unrecognised foreground colors
  // — choose the lenient pass-through to keep CLIs functioning).
  styleText: (format, text /*, _opts */) => {
    // ANSI lookup. Mirrors Node's util.inspect.colors keys.
    const codes = {
      reset:           [0, 0],
      bold:            [1, 22],
      italic:          [3, 23],
      underline:       [4, 24],
      strikethrough:   [9, 29],
      hidden:          [8, 28],
      dim:             [2, 22],
      overlined:       [53, 55],
      blink:           [5, 25],
      inverse:         [7, 27],
      doubleunderline: [21, 24],
      framed:          [51, 54],
      black:           [30, 39], red:    [31, 39], green:   [32, 39],
      yellow:          [33, 39], blue:   [34, 39], magenta: [35, 39],
      cyan:            [36, 39], white:  [37, 39], gray:    [90, 39],
      grey:            [90, 39],
      blackBright:     [90, 39], redBright:    [91, 39], greenBright: [92, 39],
      yellowBright:    [93, 39], blueBright:   [94, 39], magentaBright: [95, 39],
      cyanBright:      [96, 39], whiteBright:  [97, 39],
      bgBlack:         [40, 49], bgRed:        [41, 49], bgGreen: [42, 49],
      bgYellow:        [43, 49], bgBlue:       [44, 49], bgMagenta: [45, 49],
      bgCyan:          [46, 49], bgWhite:      [47, 49], bgGray: [100, 49],
      bgGrey:          [100, 49],
      bgBlackBright:   [100, 49], bgRedBright: [101, 49], bgGreenBright: [102, 49],
      bgYellowBright:  [103, 49], bgBlueBright: [104, 49], bgMagentaBright: [105, 49],
      bgCyanBright:    [106, 49], bgWhiteBright: [107, 49],
    };
    const formats = Array.isArray(format) ? format : [format];
    let opens = "";
    let closes = "";
    for (const f of formats) {
      const c = codes[f];
      if (c) {
        opens += "\x1b[" + c[0] + "m";
        closes = "\x1b[" + c[1] + "m" + closes;
      }
    }
    return opens + String(text) + closes;
  },
  // util.parseArgs({ args, options, strict, allowPositionals, allowNegative })
  // — Node 18.3+. The CLI argument parser modern npm bins reach for instead
  // of a dependency: json-server's lib/bin.js destructures it at module
  // init, so its absence crashed the bin at "parseArgs is not a function"
  // before --version could answer. Node's contract, minus the tokens
  // debugging output:
  //   - --name, --name=value, --name value for string options;
  //   - -s, -s value, -svalue, and grouped booleans -abc for shorts;
  //   - --no-name sets a boolean false when allowNegative is on;
  //   - -- ends option parsing, the rest are positionals;
  //   - strict (default true) throws Node's own error codes for an unknown
  //     option, a string option with no value, or a positional when they
  //     are not allowed; lax mode records unknown options as booleans.
  parseArgs: (config) => {
    const cfg = config || {};
    const args = Array.isArray(cfg.args) ? cfg.args.slice() : (__processMod.argv || []).slice(2);
    const options = cfg.options || {};
    const strict = cfg.strict !== false;
    const allowPositionals = cfg.allowPositionals === undefined ? !strict : !!cfg.allowPositionals;
    const allowNegative = !!cfg.allowNegative;
    const values = {};
    const positionals = [];
    const err = (code, message) => { const e = new TypeError(message); e.code = code; return e; };
    const shortToLong = {};
    for (const [name, spec] of Object.entries(options)) {
      if (!spec || (spec.type !== "string" && spec.type !== "boolean")) {
        throw err("ERR_INVALID_ARG_TYPE", "The \"options." + name + ".type\" property must be one of: 'string', 'boolean'.");
      }
      if (spec.short) shortToLong[spec.short] = name;
      if (spec.default !== undefined) values[name] = spec.default;
    }
    const store = (name, value) => {
      const spec = options[name];
      if (spec && spec.multiple) {
        if (!Array.isArray(values[name]) || (spec.default !== undefined && values[name] === spec.default)) values[name] = [];
        values[name].push(value);
      } else {
        values[name] = value;
      }
    };
    const optionValue = (name, inlineValue, next, raw) => {
      const spec = options[name];
      if (!spec) {
        if (strict) throw err("ERR_PARSE_ARGS_UNKNOWN_OPTION", "Unknown option '" + raw + "'." + (allowPositionals ? " To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"" + raw + "\"'." : ""));
        if (inlineValue !== undefined) return { value: inlineValue, consumed: 0 };
        return { value: true, consumed: 0 };
      }
      if (spec.type === "boolean") {
        if (inlineValue !== undefined && strict) throw err("ERR_PARSE_ARGS_INVALID_OPTION_VALUE", "Option '" + raw + "' does not take an argument.");
        return { value: inlineValue !== undefined ? inlineValue : true, consumed: 0 };
      }
      if (inlineValue !== undefined) return { value: inlineValue, consumed: 0 };
      if (next === undefined || (strict && next.startsWith("-") && next !== "-")) {
        if (strict) throw err("ERR_PARSE_ARGS_INVALID_OPTION_VALUE", "Option '" + raw + " <value>' argument missing");
        return { value: undefined, consumed: 0 };
      }
      return { value: next, consumed: 1 };
    };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") { positionals.push(...args.slice(i + 1)); break; }
      if (arg.startsWith("--") && arg.length > 2) {
        const eq = arg.indexOf("=");
        let name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
        const inline = eq === -1 ? undefined : arg.slice(eq + 1);
        if (allowNegative && name.startsWith("no-") && options[name.slice(3)] && options[name.slice(3)].type === "boolean") {
          store(name.slice(3), false);
          continue;
        }
        const r = optionValue(name, inline, args[i + 1], "--" + name);
        store(name, r.value);
        i += r.consumed;
        continue;
      }
      if (arg.startsWith("-") && arg.length > 1 && arg !== "-") {
        // Short: -s, -s value, -svalue (string) or grouped -abc (booleans).
        const first = arg[1];
        const long = shortToLong[first] || first;
        const spec = options[long];
        if (spec && spec.type === "string") {
          const inline = arg.length > 2 ? arg.slice(2) : undefined;
          const r = optionValue(long, inline, args[i + 1], "-" + first);
          store(long, r.value);
          i += r.consumed;
          continue;
        }
        for (const ch of arg.slice(1)) {
          const l = shortToLong[ch] || ch;
          const r = optionValue(l, undefined, undefined, "-" + ch);
          store(l, r.value);
        }
        continue;
      }
      if (!allowPositionals) {
        throw err("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL", "Unexpected argument '" + arg + "'. This command does not take positional arguments");
      }
      positionals.push(arg);
    }
    return { values, positionals };
  },
};

// ═══════════════════════════════════════════════════════════════════════
// ──  url module ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// X.5-M (M-3): lenient URL constructor for rolldown-bundled CJS packages.
//
// Rolldown/rollup-bundled CJS packages (vite v7, esbuild plugins, …)
// emit at module top-level:
//
//     const X = new URL("../../../src/node/constants.ts", import.meta.url);
//
// where the rolldown-CJS polyfill for import.meta.url evaluates to literal
// null (the bare word) in our facet (no document, no location, polyfill doesn't reach
//
// workerd's URL constructor strict-rejects null/undefined base, throwing
// "Invalid URL string." at module top-level eval — breaks require('vite').
//
// Fix: wrap globalThis.URL so null/undefined base for a string input
// defaults to "file:///" (after first trying the input as an absolute
// URL). All other URL behaviour is passthrough; instanceof checks and
// static methods (canParse, parse, createObjectURL, ...) preserved.
//
// Stage A (this commit): vite no longer throws at the URL constructor;
// it now progresses to a deeper fs-URL composition gap (vite passes URL
// instances / file:// strings to fs.readFileSync, which our fs shim
// doesn't strip) — that's out-of-charter, see X5M-retro §3.
//
// X.5-M3 (this section): when esbuild ESM-to-CJS pre-compile substitutes
// import.meta.url with undefined (its documented empty-import-meta
// warning behavior), new URL(rel, undefined) falls into the null-base
// branch below. Pre-M3 the fallback was a literal "file:///", which
// resolved every new URL("../foo", import.meta.url) to root-relative
// file:///foo — wrong for vite/dist/node/chunks/logger.js:75 et al.
//
// M3 plumbs the currently-loading module's path via globalThis.__currentModulePath
// (set+restored by __loadModule per call). When set, the fallback becomes
// "file:///" + __currentModulePath so relative URLs resolve against
// the real on-VFS module location — restoring proper import.meta.url
//
// The leniency is scoped to calls that PASSED a base. `new URL(x)` with one
// argument is Node's strict absolute-URL parse: it throws
// TypeError [ERR_INVALID_URL] for anything that is not already a URL, and
// that throw is load-bearing rather than incidental. Node's own ESM
// resolver — and every vendored copy of it, including exsolve, which is what
// `nuxt dev` resolves `@nuxt/kit` and `nuxt` with — spells the
// bare-specifier test as
//     try { resolved = new URL(specifier); } catch { packageResolve(…); }
// Swallowing the throw made `new URL("@nuxt/kit")` answer
// file:///@nuxt/kit, so moduleResolve never reached packageResolve and
// finalizeResolution stat'd /@nuxt/kit — the FILESYSTEM ROOT — instead of
// walking <from>/node_modules. Two syscalls and every bare import in the
// project was unresolvable. The bundler breakage this wrapper exists for
// (`new URL(rel, import.meta.url)` where the rolldown/esbuild polyfill
// reduced import.meta.url to null/undefined) is always a two-argument call,
// so requiring the base argument keeps that fix and restores Node's
// contract for the one-argument form. URL.canParse, which is bound
// straight off the native constructor below, already answered false for
// these strings; the constructor now agrees with it.
(() => {
  const _Orig = globalThis.URL;
  const inspectCustom = Symbol.for("nodejs.util.inspect.custom");
  // Named URL, as Node's class is: its name is what inspect and errors print.
  class URL extends _Orig {
    constructor(input, base) {
      if (arguments.length >= 2 && base == null && typeof input === "string") {
        try { super(input); return; }
        catch {
          // X.5-M3: prefer current module path when known, so
          //   new URL(rel, undefined) === new URL(rel, "file:///" + __filename)
          // matches real ESM import-meta-url resolution.
          const cur = globalThis.__currentModulePath;
          const fallback = (typeof cur === "string" && cur.length > 0)
            ? "file:///" + cur.replace(/^\/+/, "")
            : "file:///";
          super(input, fallback);
          return;
        }
      }
      super(input, base);
    }
    // Node's (lib/internal/url.js, v22.22.3), but for showHidden's internal
    // context, which workerd's URL has none of.
    [inspectCustom](depth, opts) {
      if (typeof depth === "number" && depth < 0) return this;
      let constructor = URL;
      for (let proto = this; proto; proto = Object.getPrototypeOf(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, "constructor");
        if (descriptor !== undefined && typeof descriptor.value === "function" && descriptor.value.name !== "") {
          constructor = descriptor.value;
          break;
        }
      }
      const obj = { __proto__: { constructor } };
      obj.href = this.href;
      obj.origin = this.origin;
      obj.protocol = this.protocol;
      obj.username = this.username;
      obj.password = this.password;
      obj.host = this.host;
      obj.hostname = this.hostname;
      obj.port = this.port;
      obj.pathname = this.pathname;
      obj.search = this.search;
      obj.searchParams = this.searchParams;
      obj.hash = this.hash;
      return constructor.name + " " + __utilMod.inspect(obj, opts);
    }
  }
  for (const k of Object.getOwnPropertyNames(_Orig)) {
    if (typeof _Orig[k] === "function" && !(k in URL)) {
      try { URL[k] = _Orig[k].bind(_Orig); } catch (_e) {}
    }
  }
  // NOTE: cannot reassign URL.prototype = _Orig.prototype — workerd treats
  // class.prototype as read-only. Inheritance via "extends _Orig" is enough:
  // URL instances are instanceof _Orig, and URL.prototype's __proto__ is
  // _Orig.prototype (so all native URL methods are reachable via the chain).
  globalThis.URL = URL;
  // URLSearchParams prints as Node's does (lib/internal/url.js, v22.22.3).
  Object.defineProperty(globalThis.URLSearchParams.prototype, inspectCustom, {
    value: function (recurseTimes, ctx) {
      if (typeof recurseTimes === "number" && recurseTimes < 0) return ctx.stylize("[Object]", "special");
      const separator = ", ";
      const innerOpts = { ...ctx };
      if (recurseTimes !== null) innerOpts.depth = recurseTimes - 1;
      const innerInspect = (v) => __utilMod.inspect(v, innerOpts);
      const output = [];
      for (const [name, value] of this) output.push(innerInspect(name) + " => " + innerInspect(value));
      let length = -separator.length;
      for (let i = 0; i < output.length; i++) length += output[i].replace(/\u001b\[\d\d?m/g, "").length + separator.length;
      if (length > ctx.breakLength) return this.constructor.name + " {\n  " + output.join(",\n  ") + " }";
      if (output.length) return this.constructor.name + " { " + output.join(separator) + " }";
      return this.constructor.name + " {}";
    },
    writable: true, configurable: true,
  });
})();
// The legacy API (parse/format/resolve/resolveObject/Url) and the rest of the
// module are workerd's own node:url (see core/_shared/real-node-imports.ts).
// It was imitated here over WHATWG `new URL()`, which throws for the path-only
// URL every HTTP server receives as `req.url`: `url.parse("/hello.txt")` came
// back as `{ href }` with no pathname, so node-static stat'ed
// "<root>/undefined" and answered 404 for every file.
const __realUrl = (typeof __real_url !== "undefined")
  ? (__real_url.default ?? __real_url)
  : globalThis.process.getBuiltinModule("url");
const __urlMod = {
  ...__realUrl,
  URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
  // Node's semantics: a relative path resolves against the process's cwd, a
  // trailing slash survives, and the characters the URL parser would read as
  // syntax or leave raw are percent-encoded ('%' first; the pathname setter
  // encodes '?', '#', spaces and controls such as rolldown's "\0" virtual-id
  // prefix). Prefixing "file://" instead made a relative path's first segment
  // the URL's host, which throws for "\0rolldown/runtime.js" and misnames
  // every other one.
  pathToFileURL: (p) => {
    const input = String(p);
    let resolved = __pathMod.resolve(input);
    if (input.endsWith("/") && !resolved.endsWith("/")) resolved += "/";
    const url = new URL("file:///");
    url.pathname = resolved.replace(/%/g, "%25").replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/\t/g, "%09");
    return url;
  },
};
__urlMod.URL = globalThis.URL;

// ═══════════════════════════════════════════════════════════════════════
// ──  crypto module (W3: forward to workerd's real node:crypto) ──────
// ═══════════════════════════════════════════════════════════════════════
//
// Pre-W3 this was a hand-rolled FNV-1a fake that returned a 16-byte
// FNV state repeated as a 32-byte "sha256" hash — silent correctness
// disaster (sha256("hello") = abdd62852c5bd7fc9fa116d64f0254ec × 2
// instead of 2cf24dba...).  W3 forwards to workerd's real
// node:crypto, which has been stable since CF changelog 2025-04-08.
// __real_crypto comes from the static import block at the top of the
// generated facet file (see src/_shared/real-node-imports.ts).
//
// The forward is exhaustive — Node 20 surface (createHash, createHmac,
// pbkdf2/Sync, scrypt/Sync, createCipheriv/Decipheriv, createSign/
// Verify, KeyObject, generateKeyPair/Sync, createPublic/PrivateKey,
// timingSafeEqual, randomBytes/UUID/Int/Fill, getHashes/Ciphers/Curves,
// constants, webcrypto, subtle) is all on the workerd module.
const __cryptoMod = (() => {
  const real = (typeof __real_crypto !== 'undefined') ? (__real_crypto.default ?? __real_crypto) : null;
  if (real && typeof real.createHash === 'function') return real;
  // Defensive fallback: if for some reason the static import didn't
  // materialise (e.g. compat-flag drift), surface honest-error rather
  // than silently shipping a fake hash.  Anything beyond randomBytes/
  // randomUUID throws a NIMBUS-flavoured error.
  function _unavail(name) {
    return () => {
      const e = new Error('crypto.' + name + ': workerd node:crypto not available. Check facet compat date >= 2025-04-08.');
      e.code = 'ERR_CRYPTO_UNAVAILABLE';
      throw e;
    };
  }
  return {
    randomBytes: (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return __BufferMod.from(a); },
    randomUUID: () => crypto.randomUUID(),
    randomInt: (min, max) => { if (max === undefined) { max = min; min = 0; } return min + Math.floor(Math.random() * (max - min)); },
    randomFillSync: (buf) => { crypto.getRandomValues(buf); return buf; },
    createHash: _unavail('createHash'),
    createHmac: _unavail('createHmac'),
    pbkdf2: _unavail('pbkdf2'),
    pbkdf2Sync: _unavail('pbkdf2Sync'),
    timingSafeEqual: (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; },
    constants: {},
    webcrypto: globalThis.crypto,
    subtle: globalThis.crypto?.subtle,
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  vm module (W3: hybrid — forward surface, honest-error on eval) ──
// ═══════════════════════════════════════════════════════════════════════
//
// Workerd's node:vm provides the API surface (constants, classes,
// runInContext as a function) BUT every code-running method throws
// ERR_METHOD_NOT_IMPLEMENTED at request-handler time. New Function
// is also blocked at request time. So we forward the surface (so
// jsdom's static-load checks pass) and wrap the eval methods with
// a honest Nimbus error so callers know it's the workerd block.
//
// Acceptance limitation: jsdom static-load works; jsdom HTML-script
// execution does not.  Documented in W3 retro for W3.5 follow-up
// (a parser-based vm fallback, or pre-bundle vm-using scripts at
// install time).
// ── Runtime code: the Function constructors ──
//
// A Worker generates code from strings only while its modules evaluate: at
// request time — where every program runs — `new Function(...)` and its async
// and generator siblings throw EvalError "Code generation from strings
// disallowed for this context". Each constructor here asks the native one
// first and, refused that way, hands the arguments to the launch's
// runtime-code service (core/_shared/commonjs-cell.ts, RUNTIME CODE), which
// answers from this launch's module map when an earlier launch staged the
// text, and otherwise records it for the next launch and runs it in the
// interpreter. That is the constructor a module runner evaluates with
// (Vite's SSR runner: `new AsyncFunction(...)`), reached as each kind's
// `prototype.constructor`, which is how `(async function () {}).constructor`
// finds it. A facet without the service (opencode's) keeps the native refusal.
function __nimbusIsCodegenRefusal(e) {
  return e instanceof EvalError && /Code generation from strings disallowed/.test(String(e.message));
}
// es-module-lexer decodes quoted import/export names with indirect eval and
// swallows failures. A single quoted string is data, not executable code:
// decode it without compiling, preserving native eval (including its Workers
// refusal) for everything else. No general-evaluation capability is exposed,
// and Function("null") / eval("1 + 1") feature probes remain refused.
const __nimbusDecodeStringLiteral = function decodeJavaScriptStringLiteral(source) {
  const text = source.trim();
  const quote = text[0];
  if ((quote !== '"' && quote !== "'") || text.length < 2) return undefined;
  let result = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === quote) return i === text.length - 1 ? result : undefined;
    if (c === '\n' || c === '\r') return undefined;
    if (c !== '\\') { result += c; continue; }
    if (++i >= text.length) return undefined;
    const escaped = text[i];
    switch (escaped) {
      case 'n': result += '\n'; break;
      case 'r': result += '\r'; break;
      case 't': result += '\t'; break;
      case 'b': result += '\b'; break;
      case 'f': result += '\f'; break;
      case 'v': result += '\v'; break;
      case '\r': if (text[i + 1] === '\n') i++; break;
      case '\n': case '\u2028': case '\u2029': break;
      case 'x': case 'u': {
        const braced = escaped === 'u' && text[i + 1] === '{';
        const start = i + (braced ? 2 : 1);
        const end = braced ? text.indexOf('}', start) : start + (escaped === 'x' ? 2 : 4);
        if (end <= start || end > text.length) return undefined;
        const digits = text.slice(start, end);
        if (!/^[0-9a-fA-F]+$/.test(digits)) return undefined;
        const point = Number.parseInt(digits, 16);
        if (point > 0x10ffff) return undefined;
        result += String.fromCodePoint(point);
        i = braced ? end : end - 1;
        break;
      }
      default: {
        if (escaped >= '0' && escaped <= '7') {
          // 0..3 consumes up to three octal digits; 4..7 only two.
          const end = Math.min(text.length, i + (escaped <= '3' ? 3 : 2));
          let octal = escaped;
          while (i + 1 < end && text[i + 1] >= '0' && text[i + 1] <= '7') octal += text[++i];
          result += String.fromCharCode(Number.parseInt(octal, 8));
        } else result += escaped;
      }
    }
  }
  return undefined;
};
(() => {
  const nativeEval = globalThis.eval;
  if (nativeEval.__nimbusNative) return;
  const routed = { eval(source) {
    if (typeof source === "string") {
      const value = __nimbusDecodeStringLiteral(source);
      if (value !== undefined) return value;
    }
    return Reflect.apply(nativeEval, undefined, [source]);
  } }.eval;
  Object.defineProperty(routed, "__nimbusNative", { value: nativeEval });
  globalThis.eval = routed;
})();
(() => {
  const kinds = [
    ["function", Function],
    ["async", Object.getPrototypeOf(async function () {}).constructor],
    ["generator", Object.getPrototypeOf(function* () {}).constructor],
    ["asyncGenerator", Object.getPrototypeOf(async function* () {}).constructor],
  ];
  const nativeToString = Function.prototype.toString;
  // Vite's module runner compiles each SSR module with new AsyncFunction and
  // imports its dependencies only when that module runs, so a refused module
  // hid everything it imports and every launch learned one more module.
  // Vite's SSR transform hoists a module's static imports into a generated
  // prologue, one statement per line, after "use strict" and the export
  // getters:
  //   const __vite_ssr_import_N__ = await __vite_ssr_import__("<source>"[, <metadata JSON>]);
  // Those imports are what the module would have run first, in this order.
  // This reads that prologue and stops at the first other line.
  const viteHoistedImports = (body) => {
    const found = [];
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (line === "" || line === '"use strict";' || line.startsWith("__vite_ssr_exportName__(")) continue;
      let rest = line;
      if (rest.startsWith("const __vite_ssr_import_")) {
        const bound = rest.indexOf("__ = ");
        if (bound < 0) break;
        rest = rest.slice(bound + 5);
      }
      const head = "await __vite_ssr_import__(";
      if (!rest.startsWith(head) || !rest.endsWith(");")) break;
      rest = rest.slice(head.length, -2);
      const quote = rest[0];
      if (quote !== '"' && quote !== "'") break;
      let end = 1;
      while (end < rest.length && rest[end] !== quote) end += rest[end] === "\\" ? 2 : 1;
      if (end >= rest.length) break;
      const source = __nimbusDecodeStringLiteral(rest.slice(0, end + 1));
      if (typeof source !== "string") break;
      const tail = rest.slice(end + 1).trim();
      let metadata;
      if (tail !== "") {
        if (!tail.startsWith(",")) break;
        try { metadata = JSON.parse(tail.slice(1)); } catch { break; }
      }
      found.push([source, metadata]);
    }
    return found;
  };
  for (const [kind, Native] of kinds) {
    if (Native.__nimbusNative) continue;
    const routed = function (...args) {
      try {
        return new.target === undefined ? Reflect.apply(Native, undefined, args) : Reflect.construct(Native, args, new.target);
      } catch (e) {
        const service = globalThis.__nimbusRuntimeCode;
        if (!__nimbusIsCodegenRefusal(e) || !service) throw e;
        const params = args.slice(0, -1).map(String);
        const body = args.length > 0 ? String(args[args.length - 1]) : "";
        try {
          const fn = service.compileFunction(kind, params, body);
          // A subclass's `new` (`class F extends Function`) makes an instance of the subclass.
          if (new.target !== undefined && new.target !== routed) {
            const proto = new.target.prototype;
            if (proto !== null && (typeof proto === "object" || typeof proto === "function")) Object.setPrototypeOf(fn, proto);
          }
          return fn;
        } catch (refusal) {
          const importAt = params.indexOf("__vite_ssr_import__");
          if (kind !== "async" || importAt < 0 || !refusal || refusal.code !== "ERR_NIMBUS_CODE_NEXT_LAUNCH") throw refusal;
          // The refusal is already recorded for the next launch. Before
          // failing, run the module's hoisted imports through the runner's
          // own import function, so their code is recorded in this launch.
          const imports = viteHoistedImports(body);
          return async function (...values) {
            const load = values[importAt];
            if (typeof load === "function") {
              for (const [source, metadata] of imports) {
                try { await load(source, metadata); } catch {}
              }
            }
            throw refusal;
          };
        }
      }
    };
    Object.defineProperty(routed, "name", { value: Native.name });
    Object.defineProperty(routed, "length", { value: Native.length });
    Object.defineProperty(routed, "prototype", { value: Native.prototype, writable: false });
    Object.defineProperty(routed, "__nimbusNative", { value: Native });
    Object.defineProperty(routed, "toString", { value: () => Reflect.apply(nativeToString, Native, []), configurable: true, writable: true });
    Object.setPrototypeOf(routed, Object.getPrototypeOf(Native));
    Object.defineProperty(Native.prototype, "constructor", { value: routed, writable: true, configurable: true, enumerable: false });
    if (kind === "function") globalThis.Function = routed;
  }
})();

const __vmMod = (() => {
  const real = (typeof __real_vm !== 'undefined') ? (__real_vm.default ?? __real_vm) : null;
  // What a script's function is called with, as the launch starts: the
  // program may later replace Reflect.apply or the globalThis property, and
  // native vm consults neither.
  const apply = Reflect.apply;
  const scriptThis = globalThis;
  function honestError(method, originalErr) {
    const e = new Error(
      'vm.' + method + ': workerd does not implement runtime eval. ' +
      'Pre-bundle vm-using scripts at install time, or wait for W3.5 ' +
      'parser-based fallback. (Original: ' +
      ((originalErr && originalErr.message) || 'no underlying error') + ')'
    );
    e.code = 'ERR_VM_DYNAMIC_EVAL_DISALLOWED';
    return e;
  }
  function wrapRuntimeEval(method) {
    return (...args) => {
      if (!real || typeof real[method] !== 'function') {
        throw honestError(method, null);
      }
      try { return real[method](...args); } catch (e) {
        // Workerd surfaces ERR_METHOD_NOT_IMPLEMENTED;
        // `new Function` surfaces "Code generation from strings disallowed".
        if (e && (e.code === 'ERR_METHOD_NOT_IMPLEMENTED'
                  || /not implemented|disallowed|Code generation/i.test(e.message || ''))) {
          throw honestError(method, e);
        }
        throw e;
      }
    };
  }
  return {
    constants: real?.constants ?? {},
    createContext: (sandbox, opts) => {
      if (!real || typeof real.createContext !== 'function') return sandbox || {};
      try { return real.createContext(sandbox, opts); }
      catch { return sandbox || {}; }
    },
    isContext: real?.isContext ?? ((o) => !!o),
    runInContext: wrapRuntimeEval('runInContext'),
    runInNewContext: wrapRuntimeEval('runInNewContext'),
    // jiti evaluates a parenthesized (async) CommonJS wrapper expression
    // statement, `(function (exports, require, ...) { ... });`. The service
    // stages a script that is one expression as a zero-argument function
    // returning its value (the script's completion value); the wrapper
    // itself executes only when the caller invokes it. The function is
    // called with the global object as `this`, which is a script's
    // `this` at its top level, strict or not. This is not a vm
    // context or a global-script evaluator: declarations/completion values
    // spanning statements, execution deadlines and context mutation have no
    // equivalent here and remain unsupported.
    runInThisContext: (code, options = {}) => {
      try { return wrapRuntimeEval('runInThisContext')(code, options); }
      catch (e) {
        const service = globalThis.__nimbusRuntimeCode;
        if (e?.code !== 'ERR_VM_DYNAMIC_EVAL_DISALLOWED' || !service
          || options?.timeout !== undefined || options?.breakOnSigint
          || options?.importModuleDynamically || options?.cachedData) throw e;
        return apply(service.compileExpression(String(code)), scriptThis, []);
      }
    },
    // A function of `params` and `code` is what the Function constructor
    // builds, so a refusal goes to the same runtime-code service. Context
    // extensions and a parsing context have no such form.
    compileFunction: (code, params = [], options = {}) => {
      try {
        return wrapRuntimeEval('compileFunction')(code, params, options);
      } catch (e) {
        const service = globalThis.__nimbusRuntimeCode;
        const refused = e && e.code === 'ERR_VM_DYNAMIC_EVAL_DISALLOWED';
        const plain = !options || (!options.contextExtensions?.length && !options.parsingContext);
        if (!refused || !service || !plain) throw e;
        return service.compileFunction("function", Array.from(params, String), String(code));
      }
    },
    Script: real?.Script ?? class { constructor() { throw honestError('Script', null); } },
    Module: real?.Module,
    SourceTextModule: real?.SourceTextModule,
    SyntheticModule: real?.SyntheticModule,
    measureMemory: real?.measureMemory ?? (async () => ({ total: { jsMemoryEstimate: 0 } })),
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  http2 module: Node's exports, no HTTP/2 transport ──────────────
// ═══════════════════════════════════════════════════════════════════════
//
// axios's dist/node code does `var http2 = require('http2')` at top
// level, unconditionally, and Astro's dev server asks
// `res instanceof Http2ServerResponse` of every response: the module
// loads with every name Node's has, and only opening HTTP/2 refuses.
// core/_shared/http2-module.ts, compiled once by
// scripts/bundle-facet-workers.mjs, declares createHttp2Module; the
// substrate's node-compat imports the same function.
function createHttp2Module(host) {
  const nodeError = (Base, code, message, props = {}) => Object.assign(new Base(message), { code }, props);
  const notSupported = (op) => nodeError(Error, "ERR_HTTP2_NOT_SUPPORTED", `http2.${op}: not implemented in Nimbus. Use fetch() or HTTP/1.1.`);
  const describe = (value) => {
    if (value === null) return "null";
    if (value === void 0) return "undefined";
    switch (typeof value) {
      case "bigint":
        return `type bigint (${value}n)`;
      case "number":
        if (Object.is(value, -0)) return "type number (-0)";
        return `type number (${value})`;
      case "boolean":
        return `type boolean (${value})`;
      case "symbol":
        return `type symbol (${String(value)})`;
      case "function":
        return `function ${value.name}`;
      case "string": {
        const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value;
        return shown.includes("'") ? `type string (${JSON.stringify(shown)})` : `type string ('${shown}')`;
      }
      default: {
        const ctor = Reflect.get(Object(value), "constructor");
        return typeof ctor === "function" && ctor.name ? `an instance of ${ctor.name}` : String(value);
      }
    }
  };
  const invalidArgType = (name, expected, value) => nodeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be ${expected}. Received ${describe(value)}`);
  const invalidSetting = (Base, name, actual, min, max) => nodeError(
    Base,
    "ERR_HTTP2_INVALID_SETTING_VALUE",
    `Invalid value for setting "${name}": ${String(actual)}`,
    min === void 0 ? { actual } : { actual, min, max }
  );
  const MAX_INT = 2 ** 32 - 1;
  const MAX_ADDITIONAL_SETTINGS = 10;
  const HEADER_TABLE_SIZE = 1;
  const ENABLE_PUSH = 2;
  const MAX_CONCURRENT_STREAMS = 3;
  const INITIAL_WINDOW_SIZE = 4;
  const MAX_FRAME_SIZE = 5;
  const MAX_HEADER_LIST_SIZE = 6;
  const ENABLE_CONNECT_PROTOCOL = 8;
  const NO_RFC7540_PRIORITIES = 9;
  const isObjectArg = (value) => value === void 0 || value !== null && typeof value === "object" && !Array.isArray(value);
  const withinRange = (name, value, min, max) => {
    if (value !== void 0 && (typeof value !== "number" || value < min || value > max)) {
      throw invalidSetting(RangeError, name, value, min, max);
    }
  };
  const validate = (settings) => {
    if (settings === void 0) return;
    if (!isObjectArg(settings.customSettings)) throw invalidArgType("customSettings", "an instance of Number", settings.customSettings);
    if (settings.customSettings) {
      const entries = Object.entries(settings.customSettings);
      if (entries.length > MAX_ADDITIONAL_SETTINGS) {
        throw nodeError(Error, "ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS", "Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS");
      }
      for (const [key, value] of entries) {
        withinRange("customSettings:id", Number(key), 0, 65535);
        withinRange("customSettings:value", Number(value), 0, MAX_INT);
      }
    }
    withinRange("headerTableSize", settings.headerTableSize, 0, MAX_INT);
    withinRange("initialWindowSize", settings.initialWindowSize, 0, 2 ** 31 - 1);
    withinRange("maxFrameSize", settings.maxFrameSize, 16384, 2 ** 24 - 1);
    withinRange("maxConcurrentStreams", settings.maxConcurrentStreams, 0, MAX_INT);
    withinRange("maxHeaderListSize", settings.maxHeaderListSize, 0, MAX_INT);
    withinRange("maxHeaderSize", settings.maxHeaderSize, 0, MAX_INT);
    for (const name of ["enablePush", "enableConnectProtocol"]) {
      const value = settings[name];
      if (value !== void 0 && typeof value !== "boolean") throw invalidSetting(TypeError, name, value);
    }
  };
  function getDefaultSettings() {
    const settings =   Object.create(null);
    settings.headerTableSize = 4096;
    settings.enablePush = true;
    settings.initialWindowSize = 65535;
    settings.maxFrameSize = 16384;
    settings.maxConcurrentStreams = MAX_INT;
    settings.maxHeaderListSize = settings.maxHeaderSize = 65535;
    settings.enableConnectProtocol = false;
    return settings;
  }
  function getPackedSettings(settings) {
    if (!isObjectArg(settings)) throw invalidArgType("settings", "of type object", settings);
    validate(settings);
    const given = { ...settings };
    const slots = [
      "headerTableSize",
      "enablePush",
      "initialWindowSize",
      "maxFrameSize",
      "maxConcurrentStreams",
      "maxHeaderListSize",
      "enableConnectProtocol"
    ];
    const known =   new Map();
    const custom =   new Map();
    if (typeof given.customSettings === "object") {
      for (const key in given.customSettings) {
        const value = given.customSettings[key];
        if (typeof value !== "number") continue;
        const id = Number(key);
        if (Number.isNaN(id) || id <= 0 || id > 65535) throw invalidSetting(RangeError, "Range Error", id, 0, 65535);
        if (Number.isNaN(value) || value <= 0 || value > 4294967295) throw invalidSetting(RangeError, "Range Error", value, 0, 4294967295);
        if (id < slots.length) known.set(slots[id], value);
        else {
          if (!custom.has(id) && custom.size === MAX_ADDITIONAL_SETTINGS) {
            throw nodeError(Error, "ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS", "Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS");
          }
          custom.set(id, value);
        }
      }
    }
    for (const name of ["headerTableSize", "maxConcurrentStreams", "initialWindowSize", "maxFrameSize"]) {
      const value = given[name];
      if (typeof value === "number") known.set(name, value);
    }
    if (typeof given.maxHeaderListSize === "number" || typeof given.maxHeaderSize === "number") {
      if (given.maxHeaderSize !== void 0 && given.maxHeaderSize !== given.maxHeaderListSize) {
        host.emitWarning?.("settings.maxHeaderSize overwrite settings.maxHeaderListSize");
        known.set("maxHeaderListSize", Number(given.maxHeaderSize));
      } else {
        known.set("maxHeaderListSize", Number(given.maxHeaderListSize));
      }
    }
    for (const name of ["enablePush", "enableConnectProtocol"]) {
      const value = given[name];
      if (typeof value === "boolean") known.set(name, Number(value));
    }
    const ids = {
      headerTableSize: HEADER_TABLE_SIZE,
      enablePush: ENABLE_PUSH,
      maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
      initialWindowSize: INITIAL_WINDOW_SIZE,
      maxFrameSize: MAX_FRAME_SIZE,
      maxHeaderListSize: MAX_HEADER_LIST_SIZE,
      enableConnectProtocol: ENABLE_CONNECT_PROTOCOL
    };
    const entries = [];
    for (const name of [
      "headerTableSize",
      "enablePush",
      "maxConcurrentStreams",
      "initialWindowSize",
      "maxFrameSize",
      "maxHeaderListSize",
      "enableConnectProtocol"
    ]) {
      const value = known.get(name);
      if (value !== void 0) entries.push([ids[name], value >>> 0]);
    }
    for (const [id, value] of custom) entries.push([id, value >>> 0]);
    for (const [id, value] of entries) {
      if ((id === ENABLE_PUSH || id === ENABLE_CONNECT_PROTOCOL || id === NO_RFC7540_PRIORITIES) && value > 1) return void 0;
      if (id === INITIAL_WINDOW_SIZE && value > 2 ** 31 - 1) return void 0;
      if (id === MAX_FRAME_SIZE && (value < 16384 || value > 2 ** 24 - 1)) return void 0;
    }
    const out = host.Buffer.alloc(entries.length * 6);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    entries.forEach(([id, value], i) => {
      view.setUint16(i * 6, id);
      view.setUint32(i * 6 + 2, value);
    });
    return out;
  }
  function getUnpackedSettings(buf, options = {}) {
    if (!ArrayBuffer.isView(buf) || Reflect.get(buf, "length") === void 0) {
      throw invalidArgType("buf", "an instance of Buffer or TypedArray", buf);
    }
    if (buf.length % 6 !== 0) {
      throw nodeError(RangeError, "ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH", "Packed settings length must be a multiple of six");
    }
    const settings = {};
    for (let offset = 0; offset < buf.length; offset += 6) {
      const id = buf[offset] * 2 ** 8 + buf[offset + 1];
      const value = buf[offset + 2] * 2 ** 24 + buf[offset + 3] * 2 ** 16 + buf[offset + 4] * 2 ** 8 + buf[offset + 5];
      switch (id) {
        case HEADER_TABLE_SIZE:
          settings.headerTableSize = value;
          break;
        case ENABLE_PUSH:
          settings.enablePush = value !== 0;
          break;
        case MAX_CONCURRENT_STREAMS:
          settings.maxConcurrentStreams = value;
          break;
        case INITIAL_WINDOW_SIZE:
          settings.initialWindowSize = value;
          break;
        case MAX_FRAME_SIZE:
          settings.maxFrameSize = value;
          break;
        case MAX_HEADER_LIST_SIZE:
          settings.maxHeaderListSize = settings.maxHeaderSize = value;
          break;
        case ENABLE_CONNECT_PROTOCOL:
          settings.enableConnectProtocol = value !== 0;
          break;
        default:
          (settings.customSettings ??= {})[id] = value;
      }
    }
    if (options != null && options.validate) validate(settings);
    return settings;
  }
  class ClientHttp2Session extends host.EventEmitter {
    destroyed = false;
    closed = false;
    constructor() {
      super();
      queueMicrotask(() => this.emit("error", notSupported("connect")));
    }
    request() {
      throw notSupported("request");
    }
    settings() {
    }
    close(callback) {
      this.closed = true;
      queueMicrotask(() => {
        this.emit("close");
        callback?.();
      });
    }
    destroy(error) {
      this.destroyed = true;
      if (error) this.emit("error", error);
      this.emit("close");
    }
  }
  function connect(_authority, _options, _listener) {
    return new ClientHttp2Session();
  }
  function createServer(_options, _onRequestHandler) {
    throw notSupported("createServer");
  }
  function createSecureServer(_options, _onRequestHandler) {
    throw notSupported("createSecureServer");
  }
  function performServerHandshake(_socket, _options = {}) {
    throw notSupported("performServerHandshake");
  }
  class Http2ServerRequest extends host.Readable {
    constructor(_stream, _headers, _options, _rawHeaders) {
      super();
      throw notSupported("Http2ServerRequest");
    }
  }
  class Http2ServerResponse extends host.Stream {
    constructor(_stream, _options) {
      super();
      throw notSupported("Http2ServerResponse");
    }
  }
  const constants = {
    NGHTTP2_ERR_FRAME_SIZE_ERROR: -522,
    NGHTTP2_SESSION_SERVER: 0,
    NGHTTP2_SESSION_CLIENT: 1,
    NGHTTP2_STREAM_STATE_IDLE: 1,
    NGHTTP2_STREAM_STATE_OPEN: 2,
    NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3,
    NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4,
    NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5,
    NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6,
    NGHTTP2_STREAM_STATE_CLOSED: 7,
    NGHTTP2_FLAG_NONE: 0,
    NGHTTP2_FLAG_END_STREAM: 1,
    NGHTTP2_FLAG_END_HEADERS: 4,
    NGHTTP2_FLAG_ACK: 1,
    NGHTTP2_FLAG_PADDED: 8,
    NGHTTP2_FLAG_PRIORITY: 32,
    DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096,
    DEFAULT_SETTINGS_ENABLE_PUSH: 1,
    DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS: 4294967295,
    DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535,
    DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384,
    DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535,
    DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL: 0,
    MAX_MAX_FRAME_SIZE: 16777215,
    MIN_MAX_FRAME_SIZE: 16384,
    MAX_INITIAL_WINDOW_SIZE: 2147483647,
    NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1,
    NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
    NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3,
    NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4,
    NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5,
    NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6,
    NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8,
    PADDING_STRATEGY_NONE: 0,
    PADDING_STRATEGY_ALIGNED: 1,
    PADDING_STRATEGY_MAX: 2,
    PADDING_STRATEGY_CALLBACK: 1,
    NGHTTP2_NO_ERROR: 0,
    NGHTTP2_PROTOCOL_ERROR: 1,
    NGHTTP2_INTERNAL_ERROR: 2,
    NGHTTP2_FLOW_CONTROL_ERROR: 3,
    NGHTTP2_SETTINGS_TIMEOUT: 4,
    NGHTTP2_STREAM_CLOSED: 5,
    NGHTTP2_FRAME_SIZE_ERROR: 6,
    NGHTTP2_REFUSED_STREAM: 7,
    NGHTTP2_CANCEL: 8,
    NGHTTP2_COMPRESSION_ERROR: 9,
    NGHTTP2_CONNECT_ERROR: 10,
    NGHTTP2_ENHANCE_YOUR_CALM: 11,
    NGHTTP2_INADEQUATE_SECURITY: 12,
    NGHTTP2_HTTP_1_1_REQUIRED: 13,
    NGHTTP2_DEFAULT_WEIGHT: 16,
    HTTP2_HEADER_STATUS: ":status",
    HTTP2_HEADER_METHOD: ":method",
    HTTP2_HEADER_AUTHORITY: ":authority",
    HTTP2_HEADER_SCHEME: ":scheme",
    HTTP2_HEADER_PATH: ":path",
    HTTP2_HEADER_PROTOCOL: ":protocol",
    HTTP2_HEADER_ACCEPT_ENCODING: "accept-encoding",
    HTTP2_HEADER_ACCEPT_LANGUAGE: "accept-language",
    HTTP2_HEADER_ACCEPT_RANGES: "accept-ranges",
    HTTP2_HEADER_ACCEPT: "accept",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_CREDENTIALS: "access-control-allow-credentials",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_HEADERS: "access-control-allow-headers",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_METHODS: "access-control-allow-methods",
    HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: "access-control-allow-origin",
    HTTP2_HEADER_ACCESS_CONTROL_EXPOSE_HEADERS: "access-control-expose-headers",
    HTTP2_HEADER_ACCESS_CONTROL_REQUEST_HEADERS: "access-control-request-headers",
    HTTP2_HEADER_ACCESS_CONTROL_REQUEST_METHOD: "access-control-request-method",
    HTTP2_HEADER_AGE: "age",
    HTTP2_HEADER_AUTHORIZATION: "authorization",
    HTTP2_HEADER_CACHE_CONTROL: "cache-control",
    HTTP2_HEADER_CONNECTION: "connection",
    HTTP2_HEADER_CONTENT_DISPOSITION: "content-disposition",
    HTTP2_HEADER_CONTENT_ENCODING: "content-encoding",
    HTTP2_HEADER_CONTENT_LENGTH: "content-length",
    HTTP2_HEADER_CONTENT_TYPE: "content-type",
    HTTP2_HEADER_COOKIE: "cookie",
    HTTP2_HEADER_DATE: "date",
    HTTP2_HEADER_ETAG: "etag",
    HTTP2_HEADER_FORWARDED: "forwarded",
    HTTP2_HEADER_HOST: "host",
    HTTP2_HEADER_IF_MODIFIED_SINCE: "if-modified-since",
    HTTP2_HEADER_IF_NONE_MATCH: "if-none-match",
    HTTP2_HEADER_IF_RANGE: "if-range",
    HTTP2_HEADER_LAST_MODIFIED: "last-modified",
    HTTP2_HEADER_LINK: "link",
    HTTP2_HEADER_LOCATION: "location",
    HTTP2_HEADER_RANGE: "range",
    HTTP2_HEADER_REFERER: "referer",
    HTTP2_HEADER_SERVER: "server",
    HTTP2_HEADER_SET_COOKIE: "set-cookie",
    HTTP2_HEADER_STRICT_TRANSPORT_SECURITY: "strict-transport-security",
    HTTP2_HEADER_TRANSFER_ENCODING: "transfer-encoding",
    HTTP2_HEADER_TE: "te",
    HTTP2_HEADER_UPGRADE_INSECURE_REQUESTS: "upgrade-insecure-requests",
    HTTP2_HEADER_UPGRADE: "upgrade",
    HTTP2_HEADER_USER_AGENT: "user-agent",
    HTTP2_HEADER_VARY: "vary",
    HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS: "x-content-type-options",
    HTTP2_HEADER_X_FRAME_OPTIONS: "x-frame-options",
    HTTP2_HEADER_KEEP_ALIVE: "keep-alive",
    HTTP2_HEADER_PROXY_CONNECTION: "proxy-connection",
    HTTP2_HEADER_X_XSS_PROTECTION: "x-xss-protection",
    HTTP2_HEADER_ALT_SVC: "alt-svc",
    HTTP2_HEADER_CONTENT_SECURITY_POLICY: "content-security-policy",
    HTTP2_HEADER_EARLY_DATA: "early-data",
    HTTP2_HEADER_EXPECT_CT: "expect-ct",
    HTTP2_HEADER_ORIGIN: "origin",
    HTTP2_HEADER_PURPOSE: "purpose",
    HTTP2_HEADER_TIMING_ALLOW_ORIGIN: "timing-allow-origin",
    HTTP2_HEADER_X_FORWARDED_FOR: "x-forwarded-for",
    HTTP2_HEADER_PRIORITY: "priority",
    HTTP2_HEADER_ACCEPT_CHARSET: "accept-charset",
    HTTP2_HEADER_ACCESS_CONTROL_MAX_AGE: "access-control-max-age",
    HTTP2_HEADER_ALLOW: "allow",
    HTTP2_HEADER_CONTENT_LANGUAGE: "content-language",
    HTTP2_HEADER_CONTENT_LOCATION: "content-location",
    HTTP2_HEADER_CONTENT_MD5: "content-md5",
    HTTP2_HEADER_CONTENT_RANGE: "content-range",
    HTTP2_HEADER_DNT: "dnt",
    HTTP2_HEADER_EXPECT: "expect",
    HTTP2_HEADER_EXPIRES: "expires",
    HTTP2_HEADER_FROM: "from",
    HTTP2_HEADER_IF_MATCH: "if-match",
    HTTP2_HEADER_IF_UNMODIFIED_SINCE: "if-unmodified-since",
    HTTP2_HEADER_MAX_FORWARDS: "max-forwards",
    HTTP2_HEADER_PREFER: "prefer",
    HTTP2_HEADER_PROXY_AUTHENTICATE: "proxy-authenticate",
    HTTP2_HEADER_PROXY_AUTHORIZATION: "proxy-authorization",
    HTTP2_HEADER_REFRESH: "refresh",
    HTTP2_HEADER_RETRY_AFTER: "retry-after",
    HTTP2_HEADER_TRAILER: "trailer",
    HTTP2_HEADER_TK: "tk",
    HTTP2_HEADER_VIA: "via",
    HTTP2_HEADER_WARNING: "warning",
    HTTP2_HEADER_WWW_AUTHENTICATE: "www-authenticate",
    HTTP2_HEADER_HTTP2_SETTINGS: "http2-settings",
    HTTP2_METHOD_ACL: "ACL",
    HTTP2_METHOD_BASELINE_CONTROL: "BASELINE-CONTROL",
    HTTP2_METHOD_BIND: "BIND",
    HTTP2_METHOD_CHECKIN: "CHECKIN",
    HTTP2_METHOD_CHECKOUT: "CHECKOUT",
    HTTP2_METHOD_CONNECT: "CONNECT",
    HTTP2_METHOD_COPY: "COPY",
    HTTP2_METHOD_DELETE: "DELETE",
    HTTP2_METHOD_GET: "GET",
    HTTP2_METHOD_HEAD: "HEAD",
    HTTP2_METHOD_LABEL: "LABEL",
    HTTP2_METHOD_LINK: "LINK",
    HTTP2_METHOD_LOCK: "LOCK",
    HTTP2_METHOD_MERGE: "MERGE",
    HTTP2_METHOD_MKACTIVITY: "MKACTIVITY",
    HTTP2_METHOD_MKCALENDAR: "MKCALENDAR",
    HTTP2_METHOD_MKCOL: "MKCOL",
    HTTP2_METHOD_MKREDIRECTREF: "MKREDIRECTREF",
    HTTP2_METHOD_MKWORKSPACE: "MKWORKSPACE",
    HTTP2_METHOD_MOVE: "MOVE",
    HTTP2_METHOD_OPTIONS: "OPTIONS",
    HTTP2_METHOD_ORDERPATCH: "ORDERPATCH",
    HTTP2_METHOD_PATCH: "PATCH",
    HTTP2_METHOD_POST: "POST",
    HTTP2_METHOD_PRI: "PRI",
    HTTP2_METHOD_PROPFIND: "PROPFIND",
    HTTP2_METHOD_PROPPATCH: "PROPPATCH",
    HTTP2_METHOD_PUT: "PUT",
    HTTP2_METHOD_REBIND: "REBIND",
    HTTP2_METHOD_REPORT: "REPORT",
    HTTP2_METHOD_SEARCH: "SEARCH",
    HTTP2_METHOD_TRACE: "TRACE",
    HTTP2_METHOD_UNBIND: "UNBIND",
    HTTP2_METHOD_UNCHECKOUT: "UNCHECKOUT",
    HTTP2_METHOD_UNLINK: "UNLINK",
    HTTP2_METHOD_UNLOCK: "UNLOCK",
    HTTP2_METHOD_UPDATE: "UPDATE",
    HTTP2_METHOD_UPDATEREDIRECTREF: "UPDATEREDIRECTREF",
    HTTP2_METHOD_VERSION_CONTROL: "VERSION-CONTROL",
    HTTP_STATUS_CONTINUE: 100,
    HTTP_STATUS_SWITCHING_PROTOCOLS: 101,
    HTTP_STATUS_PROCESSING: 102,
    HTTP_STATUS_EARLY_HINTS: 103,
    HTTP_STATUS_OK: 200,
    HTTP_STATUS_CREATED: 201,
    HTTP_STATUS_ACCEPTED: 202,
    HTTP_STATUS_NON_AUTHORITATIVE_INFORMATION: 203,
    HTTP_STATUS_NO_CONTENT: 204,
    HTTP_STATUS_RESET_CONTENT: 205,
    HTTP_STATUS_PARTIAL_CONTENT: 206,
    HTTP_STATUS_MULTI_STATUS: 207,
    HTTP_STATUS_ALREADY_REPORTED: 208,
    HTTP_STATUS_IM_USED: 226,
    HTTP_STATUS_MULTIPLE_CHOICES: 300,
    HTTP_STATUS_MOVED_PERMANENTLY: 301,
    HTTP_STATUS_FOUND: 302,
    HTTP_STATUS_SEE_OTHER: 303,
    HTTP_STATUS_NOT_MODIFIED: 304,
    HTTP_STATUS_USE_PROXY: 305,
    HTTP_STATUS_TEMPORARY_REDIRECT: 307,
    HTTP_STATUS_PERMANENT_REDIRECT: 308,
    HTTP_STATUS_BAD_REQUEST: 400,
    HTTP_STATUS_UNAUTHORIZED: 401,
    HTTP_STATUS_PAYMENT_REQUIRED: 402,
    HTTP_STATUS_FORBIDDEN: 403,
    HTTP_STATUS_NOT_FOUND: 404,
    HTTP_STATUS_METHOD_NOT_ALLOWED: 405,
    HTTP_STATUS_NOT_ACCEPTABLE: 406,
    HTTP_STATUS_PROXY_AUTHENTICATION_REQUIRED: 407,
    HTTP_STATUS_REQUEST_TIMEOUT: 408,
    HTTP_STATUS_CONFLICT: 409,
    HTTP_STATUS_GONE: 410,
    HTTP_STATUS_LENGTH_REQUIRED: 411,
    HTTP_STATUS_PRECONDITION_FAILED: 412,
    HTTP_STATUS_PAYLOAD_TOO_LARGE: 413,
    HTTP_STATUS_URI_TOO_LONG: 414,
    HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE: 415,
    HTTP_STATUS_RANGE_NOT_SATISFIABLE: 416,
    HTTP_STATUS_EXPECTATION_FAILED: 417,
    HTTP_STATUS_TEAPOT: 418,
    HTTP_STATUS_MISDIRECTED_REQUEST: 421,
    HTTP_STATUS_UNPROCESSABLE_ENTITY: 422,
    HTTP_STATUS_LOCKED: 423,
    HTTP_STATUS_FAILED_DEPENDENCY: 424,
    HTTP_STATUS_TOO_EARLY: 425,
    HTTP_STATUS_UPGRADE_REQUIRED: 426,
    HTTP_STATUS_PRECONDITION_REQUIRED: 428,
    HTTP_STATUS_TOO_MANY_REQUESTS: 429,
    HTTP_STATUS_REQUEST_HEADER_FIELDS_TOO_LARGE: 431,
    HTTP_STATUS_UNAVAILABLE_FOR_LEGAL_REASONS: 451,
    HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
    HTTP_STATUS_NOT_IMPLEMENTED: 501,
    HTTP_STATUS_BAD_GATEWAY: 502,
    HTTP_STATUS_SERVICE_UNAVAILABLE: 503,
    HTTP_STATUS_GATEWAY_TIMEOUT: 504,
    HTTP_STATUS_HTTP_VERSION_NOT_SUPPORTED: 505,
    HTTP_STATUS_VARIANT_ALSO_NEGOTIATES: 506,
    HTTP_STATUS_INSUFFICIENT_STORAGE: 507,
    HTTP_STATUS_LOOP_DETECTED: 508,
    HTTP_STATUS_BANDWIDTH_LIMIT_EXCEEDED: 509,
    HTTP_STATUS_NOT_EXTENDED: 510,
    HTTP_STATUS_NETWORK_AUTHENTICATION_REQUIRED: 511
  };
  return {
    connect,
    constants,
    createServer,
    createSecureServer,
    getDefaultSettings,
    getPackedSettings,
    getUnpackedSettings,
    performServerHandshake,
    sensitiveHeaders:   Symbol("sensitiveHeaders"),
    Http2ServerRequest,
    Http2ServerResponse
  };
}
const __http2Mod = createHttp2Module({
  EventEmitter: __eventsMod,
  Readable: __streamMod.Readable,
  Stream: __streamMod,
  Buffer: __BufferMod,
  emitWarning: (message) => {
    const proc = globalThis.process;
    if (proc && typeof proc.emitWarning === "function") proc.emitWarning(message);
  },
});

// ═══════════════════════════════════════════════════════════════════════
// ──  repl module (W3: forward to workerd) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ts-node imports repl. Workerd has it (stub since 2026-03-17).
const __replMod = (() => {
  const real = (typeof __real_repl !== 'undefined') ? (__real_repl.default ?? __real_repl) : null;
  if (real && typeof real.start === 'function') return real;
  // Fallback if static import didn't materialise.
  class REPLServer extends __eventsMod {
    close() { this.emit('exit'); }
    displayPrompt() {} pause() {} resume() {}
    setupHistory(p, cb) { if (cb) cb(null, this); }
    defineCommand() {}
  }
  return { start: (opts) => new REPLServer(), REPLServer, REPL_MODE_SLOPPY: 0, REPL_MODE_STRICT: 1 };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  diagnostics_channel (W3: forward to workerd) ───────────────────
// ═══════════════════════════════════════════════════════════════════════
// fastify uses Channel.runStores at request-handler time — workerd's
// real impl includes this. Forward whole module.
const __diagChannelMod = (() => {
  const real = (typeof __real_diagnostics_channel !== 'undefined') ? (__real_diagnostics_channel.default ?? __real_diagnostics_channel) : null;
  if (real && typeof real.channel === 'function') return real;
  // Fallback: tiny pure-JS impl (no runStores; fastify will fail loud).
  const channels = new Map();
  class Channel {
    constructor(name) { this.name = name; this._subs = []; }
    get hasSubscribers() { return this._subs.length > 0; }
    subscribe(fn) { this._subs.push(fn); }
    unsubscribe(fn) { const i = this._subs.indexOf(fn); if (i >= 0) { this._subs.splice(i, 1); return true; } return false; }
    publish(msg) { for (const fn of [...this._subs]) { try { fn(msg, this.name); } catch {} } }
    runStores(_store, fn, thisArg, ...args) { return fn.apply(thisArg, args); }
    bindStore() {} unbindStore() {}
  }
  function channel(name) {
    let c = channels.get(name);
    if (!c) { c = new Channel(name); channels.set(name, c); }
    return c;
  }
  return {
    channel,
    hasSubscribers: (name) => { const c = channels.get(name); return !!(c && c.hasSubscribers); },
    subscribe: (name, fn) => channel(name).subscribe(fn),
    unsubscribe: (name, fn) => channel(name).unsubscribe(fn),
    tracingChannel: (n) => ({
      start: channel('tracing:' + n + ':start'),
      end: channel('tracing:' + n + ':end'),
      asyncStart: channel('tracing:' + n + ':asyncStart'),
      asyncEnd: channel('tracing:' + n + ':asyncEnd'),
      error: channel('tracing:' + n + ':error'),
      traceSync(fn) { return fn(); },
      tracePromise(fn) { return Promise.resolve().then(fn); },
      traceCallback(fn, _pos, _ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
    }),
    Channel,
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  tls module (W3: forward to workerd, override createServer) ─────
// ═══════════════════════════════════════════════════════════════════════
const __tlsMod = (() => {
  const real = (typeof __real_tls !== 'undefined') ? (__real_tls.default ?? __real_tls) : null;
  if (!real) {
    return { connect: () => { throw new Error('tls: workerd node:tls not available'); } };
  }
  // A socket tls.connect opens holds the program until it closes or is
  // unref'd, as in Node. Held once the socket exists: arguments tls.connect
  // refuses (a bad port) throw first, and a caught throw holds nothing.
  // Opening a socket is something a second run would do again
  // (runtime/stop-replay.ts): counted before any I/O.
  const describe = (args) => {
    const first = args[0], second = args[1];
    if (first !== null && typeof first === "object") return String(first.host || first.servername || "") + ":" + String(first.port ?? "");
    return (typeof second === "string" ? second : "") + ":" + String(first ?? "");
  };
  // A run whose network goes through the session (one that can stop at a
  // read of stdin) cannot make TLS itself: workerd's outbound connect does
  // not carry TLS ("Incoming CONNECT with TLS not supported"). Its TLS
  // connections are made by the session (SupervisorRPC.connect): the
  // program's socket is plaintext to the session, named by a token the
  // session maps to the server, and the TLS session with the server is made
  // there when node:tls asks for it (its native socket's startTls). workerd's
  // own TLSSocket still runs on top, so what node:tls offers is what it
  // offers natively, and an option neither path can honour fails by name.
  const realNet = (typeof __real_net !== 'undefined') ? (__real_net.default ?? __real_net) : null;
  const tokens = new WeakMap();
  // The plaintext net.Socket each proxied native socket belongs to.
  const carriers = new WeakMap();
  // What a failed TLS session's error adds, by native socket (options.ca).
  const notes = new WeakMap();
  let startTlsPatched = false;
  const notImplemented = (option, why) => {
    const e = new Error('The ' + option + ' option is not implemented: ' + why);
    e.code = 'ERR_OPTION_NOT_IMPLEMENTED';
    return e;
  };
  const patchStartTls = (native) => {
    if (startTlsPatched || !native) return;
    startTlsPatched = true;
    const proto = Object.getPrototypeOf(native);
    const original = proto.startTls;
    Object.defineProperty(proto, 'startTls', { configurable: true, writable: true, value: function startTls(options) {
      const token = tokens.get(this);
      if (token === undefined) return Reflect.apply(original, this, arguments);
      const self = this;
      // workerd's TLSSocket has released the carrier's writer and reader and
      // takes the connection over; the carrier keeps the old handle, and
      // ending or destroying it would use the released writer (a TypeError
      // thrown outside the program's reach) or close the connection under
      // the TLS session. It lets go of it here.
      const carrier = carriers.get(this);
      if (carrier && carrier._handle && carrier._handle.socket === this) carrier._handle = null;
      const servername = options && typeof options.expectedServerHostname === 'string' ? options.expectedServerHostname : undefined;
      // Unref'd: the TLS socket holds the program while it is open (connect
      // below), and one the program destroyed holds nothing.
      const opened = Promise.resolve(self.opened).then(async (info) => {
        const answer = await __nimbusUseRpcResultUnref(
          __supervisor.netTls('upgrade', token, servername === undefined ? {} : { servername }), (result) => result);
        if (!answer || !answer.ok) throw new Error(String((answer && answer.error) || 'the TLS session could not be made') + (notes.get(self) || ''));
        return info;
      });
      opened.catch(() => {});
      return {
        opened, closed: self.closed, readable: self.readable, writable: self.writable,
        secureTransport: 'on', upgraded: false,
        close: (...a) => self.close(...a),
        startTls() { throw new TypeError('Cannot startTls on a TLS socket.'); },
      };
    } });
  };
  const proxiedConnect = (...args) => {
    // tls.connect's forms: (options[, cb]) and (port[, host][, options][, cb]).
    let options = {}, cb;
    if (args[0] !== null && typeof args[0] === 'object') { options = { ...args[0] }; cb = args[1]; }
    else {
      options.port = args[0];
      let i = 1;
      if (typeof args[i] === 'string') options.host = args[i++];
      if (args[i] !== null && typeof args[i] === 'object') Object.assign(options, args[i++]);
      cb = args[i];
    }
    const host = options.host || 'localhost';
    const port = Number(options.port);
    if (options.socket) {
      throw notImplemented('options.socket', 'a TLS session over a socket the program opened is not made in a program whose network goes through Nimbus (one started with its stdin open)');
    }
    for (const name of ['cert', 'key', 'pfx', 'passphrase']) {
      if (options[name] !== undefined) {
        throw notImplemented('options.' + name, 'Nimbus presents no client certificate');
      }
    }
    // A CA the program names is not used, as workerd's own node:tls does not
    // use it: the platform's trust store decides. A server it does not trust
    // fails the TLS session, and the error says the CA went unused.
    const note = options.ca !== undefined || options.secureContext !== undefined
      ? ' (the options.' + (options.ca !== undefined ? 'ca' : 'secureContext') + ' given is not used: Nimbus checks a server against the platform trust store only)'
      : '';
    if (!realNet) throw new Error('tls: node:net is not available');
    let token = '';
    for (const b of crypto.getRandomValues(new Uint8Array(16))) token += (b < 16 ? '0' : '') + b.toString(16);
    __nimbusReplay?.effect('tls.connect ' + host + ':' + port);
    const notice = __nimbusReplay && __nimbusReplay.afterBoundary();
    let cancelled = false;
    const registration = notice
      ? Promise.resolve(notice).then(() => cancelled ? undefined : __supervisor.netTls('open', token, { host, port }))
      : Promise.resolve(__supervisor.netTls('open', token, { host, port }));
    let raw, socket;
    const fail = (error) => {
      // Emit the precise refusal on the returned TLS socket, once. Its raw
      // carrier has not opened yet and is only cleaned up, without inventing
      // a second error or waiting for an unregistered token at the outbound.
      socket?.destroy(error);
      raw?.destroy();
    };
    registration.catch(fail);
    __nimbusCarrierOpening = true;
    __nimbusCarrierGate = notice ? registration : null;
    __nimbusCarrierFailure = fail;
    try {
      raw = realNet.connect({ host: token + '.nimbus-net.invalid', port: 1, allowHalfOpen: options.allowHalfOpen === true });
    } finally {
      __nimbusCarrierOpening = false;
      __nimbusCarrierGate = null;
      __nimbusCarrierFailure = null;
    }
    const name = () => {
      // workerd's empty-parent _start listener adopts raw._handle on this
      // same event. Its TLS socket must leave the placeholder connecting
      // state first; native TLS then emits its own connect after upgrading,
      // which releases the native Socket's existing write/end buffers.
      if (notice && socket && !socket.destroyed) socket.connecting = false;
      const native = raw._handle && raw._handle.socket;
      if (native) { tokens.set(native, token); carriers.set(native, raw); if (note) notes.set(native, note); patchStartTls(native); }
    };
    name();
    raw.once('connect', name);
    socket = real.connect({ ...options, host, port, socket: raw, servername: options.servername ?? host }, cb);
    if (notice && raw.connecting && !socket.destroyed) socket.connecting = true;
    // The returned TLS socket owns the carrier, including while its native
    // handle has not been created. Cancelling it cancels that pending work.
    const destroy = socket.destroy;
    socket.destroy = function(...args) {
      cancelled = true;
      raw.destroy();
      return Reflect.apply(destroy, this, args);
    };
    return socket;
  };
  const connect = (...args) => {
    // Under a workspace egress a TLS socket cannot be made: the egress's
    // connect carries plain TCP only, and making the session here would go
    // around it. The refusal names the limit; HTTPS by fetch is unaffected.
    if (globalThis.__nimbusEgress === true) {
      const refused = realNet ? new realNet.Socket() : null;
      const error = new Error("Nimbus: TLS sockets are not available when the workspace's network goes through an egress (a Fetcher's connect() carries plain TCP only); use fetch() or https for HTTPS");
      error.code = 'ERR_NIMBUS_EGRESS_TLS';
      if (!refused) throw error;
      queueMicrotask(() => refused.destroy(error));
      return refused;
    }
    const proxied = !!(__nimbusReplay && __nimbusReplay.outbound);
    if (!proxied) __nimbusReplay?.effect("tls.connect " + describe(args));
    const socket = proxied ? proxiedConnect(...args) : real.connect(...args);
    let closed = false;
    let hold = null;
    socket.once('close', () => { closed = true; hold?.(false); });
    hold = __nimbusHoldSocket();
    const ref = socket.ref, unref = socket.unref;
    socket.ref = function () {
      if (!closed) hold(true);
      return typeof ref === 'function' ? Reflect.apply(ref, this, arguments) : this;
    };
    socket.unref = function () {
      hold(false);
      return typeof unref === 'function' ? Reflect.apply(unref, this, arguments) : this;
    };
    return socket;
  };
  // Anything else node:tls exports that is called or constructed (a
  // TLSSocket, a server) may open a connection: counted too, all but the
  // helpers that only compute.
  const pure = { createSecureContext: true, getCiphers: true, checkServerIdentity: true, convertALPNProtocols: true };
  const counted = new Map();
  // tls.createServer in workerd would bind a real port; in a facet we want
  // routing through __portRegistry, so override that one method.
  return new Proxy(real, {
    get(t, p) {
      if (p === 'connect') return connect;
      if (p === 'createServer') {
        return () => {
          const e = new Error('tls.createServer: not supported in Nimbus facet. Use http.createServer for routing.');
          e.code = 'ERR_NET_SERVER_NOT_AVAILABLE';
          throw e;
        };
      }
      const value = t[p];
      if (typeof value !== 'function' || typeof p !== 'string' || Object.hasOwn(pure, p)) return value;
      if (!counted.has(p)) {
        counted.set(p, new Proxy(value, {
          apply(target, self, args) { __nimbusReplay?.effect('tls.' + p); return Reflect.apply(target, self, args); },
          construct(target, args, newTarget) {
            if (globalThis.__nimbusEgress === true) {
              const error = new Error("Nimbus: TLS sockets are not available when the workspace's network goes through an egress (a Fetcher's connect() carries plain TCP only); use fetch() or https for HTTPS");
              error.code = 'ERR_NIMBUS_EGRESS_TLS';
              throw error;
            }
            if (__nimbusReplay && __nimbusReplay.outbound) {
              throw notImplemented('tls.' + p, 'a TLS socket the program builds itself is not made in a program whose network goes through Nimbus (one started with its stdin open); use tls.connect');
            }
            __nimbusReplay?.effect('new tls.' + p);
            return Reflect.construct(target, args, newTarget === counted.get(p) ? target : newTarget);
          },
        }));
      }
      return counted.get(p);
    }
  });
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  async_hooks module (W3: forward to workerd) ────────────────────
// ═══════════════════════════════════════════════════════════════════════
// AsyncLocalStorage is the 90% case; workerd has it via nodejs_als
// (auto-on at compat date 2026-04-01). createHook is also present
// in workerd as a non-functional stub.
const __asyncHooksMod = (() => {
  const real = (typeof __real_async_hooks !== 'undefined') ? (__real_async_hooks.default ?? __real_async_hooks) : null;
  if (real && typeof real.AsyncLocalStorage === 'function') return real;
  // Defensive fallback.
  return {
    AsyncLocalStorage: class { run(_s, fn, ...args) { return fn(...args); } getStore() { return undefined; } enterWith() {} disable() {} exit(fn, ...args) { return fn(...args); } },
    AsyncResource: class { runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); } bind(fn) { return fn; } asyncId() { return 0; } triggerAsyncId() { return 0; } emitDestroy() {} },
    createHook: () => ({ enable() { return this; }, disable() { return this; } }),
    executionAsyncId: () => 0,
    executionAsyncResource: () => null,
    triggerAsyncId: () => 0,
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  inspector module (forward to workerd) ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// workerd's nodejs_compat exposes node:inspector (Session/console/url).
// The V8 inspector protocol isn't attachable inside a Worker, so a
// constructed Session is inert: connect()/post() resolve/no-op rather
// than driving a real debugger. Tools that import it for optional
// profiling (e.g. nuxi's lockfile timing Session) degrade cleanly.
const __inspectorMod = (() => {
  const real = (typeof __real_inspector !== 'undefined') ? (__real_inspector.default ?? __real_inspector) : null;
  if (real && typeof real.Session === 'function') return real;
  // Defensive fallback when workerd doesn't surface node:inspector.
  const noopSession = class {
    connect() {} connectToMainThread() {} disconnect() {}
    post(_method, _params, cb) { if (typeof _params === 'function') cb = _params; if (typeof cb === 'function') cb(null, {}); }
    on() { return this; } once() { return this; } removeListener() { return this; } emit() { return false; }
  };
  return {
    Session: noopSession,
    console: globalThis.console,
    url: () => undefined,
    open: () => {},
    close: () => {},
    waitForDebugger: () => {},
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  assert module ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __assertMod = Object.assign(
  (v, m) => { if (!v) { const e = new Error(m || "AssertionError"); e.code = "ERR_ASSERTION"; throw e; } },
  {
    ok: (v, m) => { if (!v) { const e = new Error(m || "The expression evaluated to a falsy value"); e.code = "ERR_ASSERTION"; throw e; } },
    equal: (a, b, m) => { if (a != b) { const e = new Error(m || __utilMod.inspect(a) + " != " + __utilMod.inspect(b)); e.code = "ERR_ASSERTION"; throw e; } },
    notEqual: (a, b, m) => { if (a == b) { const e = new Error(m || __utilMod.inspect(a) + " == " + __utilMod.inspect(b)); e.code = "ERR_ASSERTION"; throw e; } },
    strictEqual: (a, b, m) => { if (a !== b) { const e = new Error(m || __utilMod.inspect(a) + " !== " + __utilMod.inspect(b)); e.code = "ERR_ASSERTION"; throw e; } },
    notStrictEqual: (a, b, m) => { if (a === b) { const e = new Error(m || "Values are strictly equal"); e.code = "ERR_ASSERTION"; throw e; } },
    deepEqual: (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { const e = new Error(m || "deepEqual failed"); e.code = "ERR_ASSERTION"; throw e; } },
    deepStrictEqual: (a, b, m) => __assertMod.deepEqual(a, b, m),
    throws: (fn, m) => { try { fn(); } catch { return; } const e = new Error(m || "Missing expected exception"); e.code = "ERR_ASSERTION"; throw e; },
    doesNotThrow: (fn, m) => { try { fn(); } catch (ex) { const e = new Error(m || "Got unwanted exception: " + ex.message); e.code = "ERR_ASSERTION"; throw e; } },
    ifError: (v) => { if (v) throw v; },
    fail: (m) => { const e = new Error(m || "Failed"); e.code = "ERR_ASSERTION"; throw e; },
  }
);

// ═══════════════════════════════════════════════════════════════════════
// ──  querystring, string_decoder, child_process ─────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __qsMod = {
  stringify: (o, sep, eq) => Object.entries(o || {}).map(([k,v]) => encodeURIComponent(k) + (eq||"=") + encodeURIComponent(String(v))).join(sep||"&"),
  parse: (s, sep, eq) => Object.fromEntries(new URLSearchParams(s)),
  escape: encodeURIComponent,
  unescape: decodeURIComponent,
};

const __stringDecoderMod = {
  StringDecoder: class { constructor(enc) { this.enc = enc || "utf8"; this._dec = new TextDecoder(this.enc); } write(buf) { return this._dec.decode(buf, { stream: true }); } end(buf) { return buf ? this._dec.decode(buf) : ""; } },
};

// ═══════════════════════════════════════════════════════════════════════
// ──  child_process — W8 facet-mapped impl ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// Routes through __supervisor.cp{Spawn,StdinWrite,StdinEnd,ReadOutput,
// DrainOutput,Kill,Wait}. When __supervisor is unavailable (rare — the
// facet is normally instantiated with one), every API surfaces a clean
// ERR_CHILD_PROCESS_UNAVAILABLE error rather than silently returning
// success.
//
// Key differences from the pre-W8 stub:
//   1. spawn() actually spawns. Returns a ChildProcess emitter whose
//      stdio streams are real workerd Readable/Writable instances.
//   2. exec/execFile route through spawn (Node-doc semantics). The
//      callback fires (err, stdout, stderr) once the child exits.
//   3. fork() establishes a JSON-newline IPC channel via the stdin
//      queue. ChildProcess.send(msg)→cpStdinWrite of JSON.stringify(msg)+'\n'.
//      Phase 1 limit: messages are JSON, NOT v8.serialize. Buffer/Date
//      project to their JSON shapes ({type:'Buffer',data:[...]} and
//      ISO strings respectively). Documented in cp-fork-ipc.mjs probe.
//   4. spawnSync returns a result object that FILLS IN LATER: the spawn is
//      async and the fields land as the child's events fire, so a caller
//      reads status=null until it settles. `__deferred` resolves with the
//      completed result and is the contract Nimbus consumers await.
//      execSync/execFileSync cannot offer that — their Node contract is to
//      RETURN the child's stdout — so they refuse instead of lying; see
//      _refuseSyncExec below.
//   5. Live children are tracked in __cpChildren so the facet's exit-
//      time drain (see __cpDrainAllChildren below) can issue a
//      cpDrainOutput RPC for each before reportExit fires. This is
//      the BLOCKER-1 fix from W8-plan §8.5: without it, output from
//      unawaited children dies between the last 'data' poll and the
//      facet's reportExit.
const __cpChildren = new Map();   // pid → ChildProcess (for exit-time drain)
// Pids of this process's children that have exited, so process.kill can
// answer ESRCH for them as Node does (session pids are never reused). Bounded:
// the oldest are forgotten first, and a forgotten pid is an unknown one.
const __cpExitedPids = new Set();
const __CP_EXITED_PIDS_MAX = 1024;

const __childProcessMod = (() => {
  const HAS_SUPERVISOR = !!(__supervisor && typeof __supervisor.cpSpawn === "function");

  /**
   * Child stdout/stderr. Bytes, as Node's: a 'data' listener sees a Buffer
   * until the consumer calls .setEncoding(), which is how a binary protocol
   * (esbuild's service) reads its packets and how a text consumer opts into
   * text. It used to default to utf8 for the cross-spawn / husky pattern;
   * that pattern reads `String(chunk)` and works on a Buffer, and the
   * default turned every byte above 0x7f into U+FFFD for everyone else.
   * Flowing-mode resumption and encoding are the Readable base class's job —
   * see streams.ts.
   */
  function _makeReadable() {
    return new __streamMod.PassThrough();
  }

  /**
   * Create a workerd-Writable backed by cpStdinWrite RPC.
   *
   * A child's stdin is BYTES. esbuild's service protocol is binary packets,
   * and so is anything piping an image or an archive to a child. The relay
   * used to decode each chunk to a UTF-8 string here, which turned every
   * byte sequence that is not valid UTF-8 into U+FFFD — unrecoverable, and
   * measured at twice the length for a buffer covering all 256 values. The
   * queue and the RPC carry Uint8Array now; text callers encode at this
   * edge, which is the only place that knows it had text.
   */
  function _toBytes(chunk) {
    if (chunk instanceof Uint8Array) return chunk;
    if (typeof chunk === "string") return new TextEncoder().encode(chunk);
    return new TextEncoder().encode(String(chunk));
  }
  /**
   * RELEASE ahead of what the child observes this process by: its launch
   * (it reads the files this process wrote, its own script among them) and
   * what this process writes to its stdin. A synchronous
   * write is only parked; without the barrier a child spawned right after
   * `writeFileSync` could read the file before the write-back reached the
   * authority, and a child told "ready" on stdin could read the pre-write
   * bytes. Measured: a parent that wrote its child's module and spawned it
   * at once had the child fail `cannot find module` (1 run in 5).
   */
  async function _releaseToChild() {
    const release = globalThis.__nimbusVfsReleaseBarrier;
    // A write-back that fails is retained and reported at exit (the write
    // ledger's contract); the child is not the operation to blame for it.
    if (typeof release === "function") { try { await release(); } catch {} }
  }

  function _queueStdinWrite(child, data) {
    if (!child._brokerPid) {
      child._pendingStdin = child._pendingStdin || [];
      child._pendingStdin.push(data);
      return Promise.resolve();
    }
    if (!HAS_SUPERVISOR) return Promise.reject(new Error("ERR_CHILD_PROCESS_UNAVAILABLE"));
    const prior = child._stdinChain || Promise.resolve();
    const next = prior.then(_releaseToChild).then(() => _writeStdinWhenRoom(child, data));
    child._stdinChain = next.catch(() => {});
    __pendingIO.push(next.catch(() => {}));
    return next;
  }
  // A write goes to the child's queue in pieces no larger than a read takes,
  // and a piece the queue has no room for waits and goes again, as a full
  // pipe holds its writer: one write larger than the queue (256 KiB) is never
  // refused whole, and a parent writing faster than its child reads loses
  // nothing. One the child no longer reads is dropped, as before, and so is
  // one still waiting when this program has ended.
  const __NIMBUS_STDIN_PIECE_BYTES = 64 * 1024;
  async function _writeStdinWhenRoom(child, data) {
    for (let at = 0; at < data.byteLength; at += __NIMBUS_STDIN_PIECE_BYTES) {
      const piece = data.subarray(at, Math.min(data.byteLength, at + __NIMBUS_STDIN_PIECE_BYTES));
      for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
        const answer = await __nimbusUseRpcResult(__supervisor.cpStdinWrite(child._brokerPid, piece), (result) => result);
        if (!answer || (!answer.ok && !answer.full) || __nimbusProgramStopped) return;
        if (answer.ok) break;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  function _queueStdinEnd(child) {
    child._pendingStdinEnd = true;
    if (!child._brokerPid) return Promise.resolve();
    if (!HAS_SUPERVISOR) return Promise.resolve();
    const prior = child._stdinChain || Promise.resolve();
    const next = prior.then(_releaseToChild).then(() =>
      __nimbusUseRpcResult(__supervisor.cpStdinEnd(child._brokerPid), () => undefined)
    );
    child._stdinChain = next.catch(() => {});
    __pendingIO.push(next.catch(() => {}));
    return next;
  }
  function _makeWritable(child) {
    const w = new __streamMod.Writable({
      write(chunk, enc, cb) {
        _queueStdinWrite(child, _toBytes(chunk))
          .then(() => cb())
          .catch((e) => cb(e));
      },
      final(cb) {
        _queueStdinEnd(child)
          .then(() => cb())
          .catch(() => cb()); // best-effort end
      },
    });
    return w;
  }

  /** Normalize stdio config to a 3-tuple of 'pipe'|'ignore'|'inherit'. */
  function _normalizeStdio(stdio) {
    if (!stdio) return ["pipe", "pipe", "pipe"];
    if (Array.isArray(stdio)) {
      const a = stdio.slice(0, 3);
      while (a.length < 3) a.push("pipe");
      return a.map((v) => (v === "ignore" || v === "inherit" || v === "pipe") ? v : "pipe");
    }
    if (stdio === "ignore" || stdio === "inherit" || stdio === "pipe") return [stdio, stdio, stdio];
    return ["pipe", "pipe", "pipe"];
  }

  // An inherited descriptor has no public ChildProcess stream, but its
  // relay writes through the parent's stream just like the parent's own
  // writes. Ending the child closes only this relay, never the parent.
  function _inheritOutput(child, fd) {
    let ended = false;
    return {
      write(bytes) {
        if (!ended) (fd === 1 ? __processMod.stdout : __processMod.stderr).write(bytes);
      },
      end() {
        if (ended) return;
        ended = true;
        if (fd === 1) child._stdoutEnded = true;
        else child._stderrEnded = true;
        _maybeFireClose(child);
      },
    };
  }

  // Read the parent's actual stdin (seeded input or the live terminal
  // pump), not an empty spawn payload. The private relay remains absent
  // from child.stdin, and relinquishes the input when the child exits.
  function _inheritStdin(child) {
    const input = __processMod.stdin;
    let stopped = false;
    const cleanup = () => {
      stopped = true;
      input.removeListener('data', forward);
      input.removeListener('end', end);
      if (input.listenerCount('data') === 0) input.pause();
    };
    const end = () => { if (!stopped) void _queueStdinEnd(child); };
    const forward = (chunk) => {
      if (stopped) return;
      input.pause();
      const task = _queueStdinWrite(child, _toBytes(chunk)).then(() => {
        if (!stopped) input.resume();
      }, (error) => {
        if (!stopped) child.emit('error', error);
      });
      __pendingIO.push(task);
    };
    child.once('exit', cleanup);
    // Attach the byte consumer before starting the stdin pump. Bypass only
    // stdin's optional text-decoding listener wrapper: an inherited fd
    // carries its bytes, not the parent's chosen listener encoding.
    __eventsMod.prototype.on.call(input, 'data', forward);
    input.once('end', end);
    input.resume();
    if (input.readableEnded) end();
  }

  /** Build a fresh ChildProcess emitter with real streams. */
  function _makeChild(opts) {
    const stdio = _normalizeStdio((opts || {}).stdio);
    const child = new __eventsMod();
    // Published once the child has started (_markSpawned), as Node's is only
    // for a spawn that succeeded; the broker's pid for it is _brokerPid,
    // known as soon as the broker has it (pending admission, or refused).
    child.pid = undefined;
    child._brokerPid = 0;
    child._started = false;
    child.connected = false;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    // Node exposes null for inherited/ignored descriptors. The inherited
    // descriptors nevertheless have private relays to the parent.
    child.stdin  = stdio[0] === 'pipe' ? _makeWritable(child) : null;
    child.stdout = stdio[1] === 'pipe' ? _makeReadable() : null;
    child.stderr = stdio[2] === 'pipe' ? _makeReadable() : null;
    child.stdio = [child.stdin, child.stdout, child.stderr];
    child._stdioModes = stdio;
    child._stdoutSink = child.stdout || (stdio[1] === 'inherit' ? _inheritOutput(child, 1) : null);
    child._stderrSink = child.stderr || (stdio[2] === 'inherit' ? _inheritOutput(child, 2) : null);
    child._pendingKill = null;       // {signal} if kill called before pid
    child._exitFired = false;
    child._closeFired = false;
    child._stdinChain = Promise.resolve();
    child._pendingStdin = [];
    child._pendingStdinEnd = false;
    let _resolveClosePromise;
    child._closePromise = new Promise((resolve) => { _resolveClosePromise = resolve; });
    child._resolveClosePromise = _resolveClosePromise;
    child._closeTracked = false;
    const _trackCloseInterest = (event) => {
      if ((event === "close" || event === "exit") && !child._closeTracked) {
        child._closeTracked = true;
        // Keeps this process until the child closes, or until it exits:
        // Node's process.exit() does not wait for its children.
        __pendingIO.push(Promise.race([child._closePromise, __nimbusProcessExitPromise]).catch(() => {}));
      }
    };
    const _childOn = child.on.bind(child);
    const _childOnce = child.once.bind(child);
    child.on = function(event, listener) {
      _trackCloseInterest(event);
      return _childOn(event, listener);
    };
    child.addListener = child.on;
    child.once = function(event, listener) {
      _trackCloseInterest(event);
      return _childOnce(event, listener);
    };
    // Inherited streams must be drained before close too. Only ignored
    // output has no relay to wait for.
    child._stdoutEnded = stdio[1] === 'ignore';
    child._stderrEnded = stdio[2] === 'ignore';
    if (stdio[1] === 'inherit' || stdio[2] === 'inherit') _trackCloseInterest('close');
    // Listen to the underlying streams' 'end' events so 'close' fires
    // only after actual data has flushed.
    if (child.stdout) {
      child.stdout.on("end", () => { child._stdoutEnded = true; _maybeFireClose(child); });
    }
    if (child.stderr) {
      child.stderr.on("end", () => { child._stderrEnded = true; _maybeFireClose(child); });
    }

    child.kill = function(signal) {
      // Node semantics: a child that has exited has no handle to signal,
      // so kill() returns false and `killed` stays as it was. Before the
      // pid is known the kill is queued, and counts as sent.
      const sig = signal || "SIGTERM";
      if (child._exitFired) return false;
      child.killed = true;
      if (!child._brokerPid) { child._pendingKill = { signal: sig }; return true; }
      if (!HAS_SUPERVISOR) return true;
      __pendingIO.push(
        __nimbusUseRpcResult(__supervisor.cpKill(child._brokerPid, sig), () => undefined).catch(() => {}),
      );
      return true;
    };
    child.ref = function() { return child; };
    child.unref = function() { return child; };
    child.disconnect = function() {
      child.connected = false;
      try { child.emit("disconnect"); } catch {}
    };

    return child;
  }

  /**
   * Coalesce the close event: emit only after exit AND both streams
   * have ended. Once close fires, evict the child from __cpChildren so
   * a long-running parent that spawns thousands of children doesn't
   * leak ChildProcess emitters + PassThrough buffers into memory.
   */
  function _maybeFireClose(child) {
    if (child._exitFired && child._stdoutEnded && child._stderrEnded && !child._closeFired) {
      child._closeFired = true;
      globalThis.__nimbusVfsMayBeStale = true;
      try { child.emit("close", child.exitCode, child.signalCode); } catch {}
      try { child._resolveClosePromise({ code: child.exitCode, signal: child.signalCode }); } catch {}
      // Evict from the live-children map after a microtask so any
      // close listeners that re-read child state see consistent values.
      queueMicrotask(() => {
        try {
          if (child._brokerPid) {
            __cpChildren.delete(child._brokerPid);
            __cpExitedPids.add(child._brokerPid);
            if (__cpExitedPids.size > __CP_EXITED_PIDS_MAX) __cpExitedPids.delete(__cpExitedPids.values().next().value);
          }
        } catch {}
      });
    }
  }

  /**
   * Read-loop for a single fd. Long-polls cpReadOutput, pushes chunks
   * into the Readable via .push, handles closure.
   *
   * What the child printed, and that it closed the stream, is news from
   * another process, which may have written files before it printed. So a
   * reply that delivers anything takes the barrier first, and a 'data'
   * handler that reads what the child wrote reads it current. The poll sends
   * this process's ACQUIRE arguments and the reply carries the answer, so the
   * barrier costs no round trip of its own.
   */
  /**
   * One of a child's long polls (its output, its exit): ref'd work, as a
   * Node child's pipes and handle are, and counted as waiting on a child
   * (__nimbusChildOps), which is how the program's event loop tells that
   * waiting on children is all it is doing (__nimbusReportBlockedState).
   */
  async function _childPoll(promise, use) {
    globalThis.__nimbusChildOps = (globalThis.__nimbusChildOps || 0) + 1;
    try { return await __nimbusUseRpcResult(promise, use); }
    finally { globalThis.__nimbusChildOps--; }
  }

  /** A reply's news numbers, applied once its effect has been (__nimbusApplyNews). */
  function _applyNews(r) {
    if (r && Array.isArray(r.news)) globalThis.__nimbusApplyNews(r.news);
  }

  async function _runReadLoop(child, fd, stream, sinceSeqRef) {
    // Exponential backoff for idle children: start at 100ms, double up
    // to 1500ms cap. Reset to 100ms whenever a chunk arrives. Caps
    // workerd subrequest budget consumption for many concurrent
    // children — a 30-way 'concurrently' would otherwise sustain 60
    // in-flight RPCs at 250ms intervals.
    let backoff = 100;
    const BACKOFF_MAX = 1500;
    while (HAS_SUPERVISOR && child._brokerPid && !child._streamsClosed) {
      try {
        const r = await _childPoll(
          __supervisor.cpReadOutput(child._brokerPid, fd, sinceSeqRef.value, backoff, __nimbusVfsAcquireArgs()),
          (result) => result,
        );
        const chunks = r && Array.isArray(r.chunks) ? r.chunks : [];
        if (chunks.length > 0 || (r && r.closed)) await __nimbusInboundBarrier(r.acquired);
        if (chunks.length > 0) {
          backoff = 100;  // reset — child is producing
          // A child that has output has started: 'spawn' and its pid come
          // before its first byte, as in Node.
          _markSpawned(child);
          for (const c of chunks) {
            // The queue hands back bytes; a Readable given a string would
            // encode it again.
            stream.write(__BufferMod.from(c.data));
            if (typeof c.seq === "number" && c.seq > sinceSeqRef.value) {
              sinceSeqRef.value = c.seq;
            }
          }
        } else {
          backoff = Math.min(backoff * 2, BACKOFF_MAX);
        }
        if (r && r.closed) stream.end();
        _applyNews(r);
        if (r && r.closed) {
          // _stdoutEnded / _stderrEnded flag is set in the stream's
          // 'end' listener (see _makeChild) so 'close' fires AFTER
          // actual data flushes.
          break;
        }
      } catch (e) {
        // RPC failure → close the stream and bail.
        stream.end();
        break;
      }
    }
  }

  /**
   * The child started (the broker admitted it): its pid is published and
   * 'spawn' emitted, once, as Node does for a spawn that succeeded.
   */
  function _markSpawned(child) {
    if (child._started) return;
    child._started = true;
    child.pid = child._brokerPid;
    child.connected = true;
    try { child.emit("spawn"); } catch {}
  }

  /**
   * What a wait answered, applied: the child started; or it ended, by a
   * status or a signal (a child that ended is one that started, so 'spawn'
   * comes first); or its spawn failed, and it never ran. True once the
   * child is settled. Shared by the wait loop and the exit-time drain, so a
   * refusal is reported one way, whichever sees it.
   */
  /**
   * After 'exit', as Node's ChildProcess does (flushStdio): any stdio stream
   * the program has not read is resumed, so its buffered output drains, it
   * ends, and 'close' can follow. On the next turn, so an 'exit' listener
   * still has its chance to start reading. Without it a child that wrote to
   * a stream its parent never read (an error on stderr) exited and never
   * closed, and its parent, waiting for 'close', waited for good.
   */
  function _flushStdio(child) {
    queueMicrotask(() => {
      for (const stream of [child.stdout, child.stderr]) {
        // A stream a consumer owns in readable mode (a 'readable' listener,
        // an async iterator) is left to it, as Node's flushStdio leaves one
        // whose readableListening is set: resuming it would hand its next
        // chunks to no one.
        if (!stream || stream._readableState?.readableListening) continue;
        try { stream.resume(); } catch {}
      }
    });
  }

  function _applyWait(child, r) {
    // Settled already (both the wait loop and the exit-time drain can hear
    // of the same exit or refusal): nothing more to emit.
    if (child._exitFired) return true;
    if (!r) return false;
    if (r.done && r.spawnError) {
      _failSpawn(child, r.spawnError, r.exitCode);
      return true;
    }
    if (r.started || r.done) _markSpawned(child);
    if (!r.done) return false;
    // Node's pair: a status and no signal, or the signal and no status.
    child.exitCode = r.exitCode;
    child.signalCode = r.signal || null;
    child._exitFired = true;
    try { child.emit("exit", r.exitCode, r.signal || null); } catch {}
    _flushStdio(child);
    _maybeFireClose(child);
    return true;
  }

  /**
   * Wait-loop: long-poll cpWait until the child reports its start, then its
   * exit. Applied behind the barrier: a child's exit is how a parent learns
   * the files it wrote are there. Answered on the reply, as for the child's
   * output.
   */
  async function _runWaitLoop(child) {
    while (HAS_SUPERVISOR && child._brokerPid && !child._exitFired) {
      try {
        const r = await _childPoll(
          __supervisor.cpWait(child._brokerPid, 1000, __nimbusVfsAcquireArgs(), child._started),
          (result) => result,
        );
        if (r && (r.done || r.started)) await __nimbusInboundBarrier(r.acquired);
        const settled = _applyWait(child, r);
        _applyNews(r);
        if (settled) break;
      } catch (e) {
        // Couldn't wait — synthesize an error exit.
        child.exitCode = 1;
        child._exitFired = true;
        try { child.emit("exit", 1, null); } catch {}
        _flushStdio(child);
        _maybeFireClose(child);
        break;
      }
    }
  }

  /**
   * The child never ran: its spawn failed with errno `code` (EAGAIN: the
   * session had no room to start it, and never would). As Node reports a
   * failed spawn: an 'error' event named for the file and the code, no
   * 'exit', no pid, and 'close' with the negative errno as its status once
   * the streams have ended.
   */
  function _failSpawn(child, code, errno) {
    const err = new Error("spawn " + child.spawnfile + " " + code);
    err.errno = errno;
    err.code = code;
    err.syscall = "spawn " + child.spawnfile;
    err.path = child.spawnfile;
    err.spawnargs = child.spawnargs.slice(1);
    __cpChildren.delete(child._brokerPid);
    child.exitCode = errno;
    child._exitFired = true;
    try { child.emit("error", err); } catch {}
    try { child._stdoutSink && child._stdoutSink.end(); } catch {}
    try { child._stderrSink && child._stderrSink.end(); } catch {}
    _maybeFireClose(child);
  }

  /**
   * Internal spawn primitive. Always returns a ChildProcess emitter;
   * any failure (no supervisor, bad cmd) surfaces via 'error' + 'exit'
   * events, never a synchronous throw.
   */
  function _spawn(cmd, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || [];
    opts = opts || {};
    const child = _makeChild(opts);
    child.spawnfile = String(cmd);
    child.spawnargs = [String(cmd), ...args.map(String)];
    // `timeout`: ended with `killSignal` once it has run that long, as Node's spawn does.
    if (opts.timeout > 0) {
      let timer = setTimeout(() => {
        timer = null;
        child._timedOut = true;
        child.kill(opts.killSignal);
      }, opts.timeout);
      const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
      child.once("exit", clear);
      child.once("error", clear);
    }

    if (!HAS_SUPERVISOR) {
      queueMicrotask(() => {
        const err = Object.assign(new Error("ERR_CHILD_PROCESS_UNAVAILABLE"), {
          code: "ERR_CHILD_PROCESS_UNAVAILABLE", cmd,
        });
        try { child.emit("error", err); } catch {}
        child._exitFired = true;
        try { child.emit("exit", 1, null); } catch {}
        // End the streams synchronously; their 'end' listeners flip the
        // _stdoutEnded/_stderrEnded flags and trigger _maybeFireClose.
        try { child._stdoutSink && child._stdoutSink.end(); } catch {}
        try { child._stderrSink && child._stderrSink.end(); } catch {}
        _maybeFireClose(child);
      });
      return child;
    }

    // Issue cpSpawn asynchronously. Return the emitter immediately so
    // callers can attach 'data' listeners before any chunk arrives.
    __pendingIO.push((async () => {
      try {
        await _releaseToChild();
        const r = await __nimbusUseRpcResult(
          __supervisor.cpSpawn({
            command: cmd,
            args,
            env: { ...(__processMod.env || {}), ...(opts.env || {}) },
            cwd: opts.cwd || cwd || "/home/user",
            stdio: opts.stdio || ["pipe", "pipe", "pipe"],
            detached: !!opts.detached,
            shell: opts.shell || false,
          }),
          (result) => result,
        );
        // The broker has the child; it starts once it is admitted, and its
        // wait loop says so (_markSpawned), or that it was refused.
        child._brokerPid = r.childPid;
        __cpChildren.set(child._brokerPid, child);

        // Flush any stdin written before pid was known, preserving
        // write-before-end ordering for common child.stdin.write();
        // child.stdin.end() patterns. It heads the stdin chain, so what is
        // written once the pid is known goes after it, and each write waits
        // for room in the child's queue rather than being dropped. Not
        // awaited here: the child's output is not held behind a slow reader.
        const pendingStdin = child._pendingStdin ? child._pendingStdin.splice(0) : [];
        const endBeforePid = child._pendingStdinEnd === true;
        if (pendingStdin.length > 0 || endBeforePid) {
          const flushed = (async () => {
            await _releaseToChild();
            for (const d of pendingStdin) await _writeStdinWhenRoom(child, d).catch(() => {});
            if (endBeforePid) {
              await __nimbusUseRpcResult(__supervisor.cpStdinEnd(child._brokerPid), () => undefined).catch(() => {});
            }
          })();
          child._stdinChain = flushed;
          __pendingIO.push(flushed);
        }

        // Flush a queued kill if .kill() was called before pid landed.
        if (child._pendingKill) {
          const sig = child._pendingKill.signal;
          child._pendingKill = null;
          __pendingIO.push(__nimbusUseRpcResult(
            __supervisor.cpKill(child._brokerPid, sig),
            () => undefined,
          ).catch(() => {}));
        }

        // Both piped and inherited output have read loops; the latter use
        // private sinks and finish without ending the parent's streams.
        if (child._stdioModes[0] === 'inherit') _inheritStdin(child);
        else if (child._stdioModes[0] === 'ignore') await _queueStdinEnd(child);
        const stdoutSeq = { value: 0 };
        const stderrSeq = { value: 0 };
        if (child._stdoutSink) void _runReadLoop(child, 1, child._stdoutSink, stdoutSeq);
        if (child._stderrSink) void _runReadLoop(child, 2, child._stderrSink, stderrSeq);
        void _runWaitLoop(child);
      } catch (e) {
        // The broker refused the spawn with an errno (EAGAIN at the depth
        // cap): a failed spawn, reported as the session's refusal is.
        if (e && typeof e.code === "string" && typeof e.errno === "number") {
          _failSpawn(child, e.code, e.errno);
          return;
        }
        try { child.emit("error", e); } catch {}
        child._exitFired = true;
        try { child.emit("exit", 1, null); } catch {}
        try { child._stdoutSink && child._stdoutSink.end(); } catch {}
        try { child._stderrSink && child._stderrSink.end(); } catch {}
        _maybeFireClose(child);
      }
    })());

    return child;
  }

  /**
   * The callback of exec and execFile, as Node's: once, with no error when
   * the child exited 0, else an error saying how it ended (`code`, or
   * `signal` and no code; `killed` when it was killed), and the spawn's
   * own error when it never ran. `cmd` is the command line, as Node joins it.
   */
  function _execCallback(child, cmd, cb) {
    let stdout = "", stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => { stdout += String(d); });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += String(d); });
    let spawnError = null;
    let done = false;
    // Use 'close' (fires after exit AND both stdio streams ended) so all
    // chunks have landed before cb resolves.
    child.on("error", (e) => { spawnError = e; });
    child.on("close", (code, signal) => {
      if (done || !cb) return;
      done = true;
      if (spawnError) {
        spawnError.cmd = cmd;
        cb(spawnError, stdout, stderr);
      } else if (code === 0 && signal === null) {
        cb(null, stdout, stderr);
      } else {
        // stdout and stderr ride on it too, as util.promisify(exec)'s rejection carries them.
        const err = Object.assign(new Error("Command failed: " + cmd + "\n" + stderr), {
          code, killed: child.killed, signal, cmd, stdout, stderr,
        });
        cb(err, stdout, stderr);
      }
    });
  }

  /**
   * exec(cmd, opts, cb) — Node semantics: passes cmd to a shell
   * (we use 'sh -c'). Buffers stdout/stderr; cb fires once on close.
   */
  function exec(cmd, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    opts = opts || {};
    // Use sh -c so shell metacharacters work for husky/concurrently/etc.
    const child = _spawn("sh", ["-c", cmd], { ...opts, shell: true });
    _execCallback(child, String(cmd), cb);
    return child;
  }

  /**
   * execFile(file, args, opts, cb) — like exec but no shell.
   */
  function execFile(file, args, opts, cb) {
    if (typeof args === "function") { cb = args; args = []; opts = {}; }
    if (typeof opts === "function") { cb = opts; opts = {}; }
    opts = opts || {};
    args = args || [];
    const child = _spawn(file, args, { ...opts, shell: false });
    _execCallback(child, [String(file), ...args.map(String)].join(" "), cb);
    return child;
  }

  /**
   * Fake-sync spawn. Phase-1 limit: V8/Workers can't truly block JS
   * execution. We approximate "synchronous" semantics by:
   *   1. Issuing the underlying _spawn (which queues async work onto
   *      __pendingIO).
   *   2. Returning a result object that LAZILY accumulates fields as
   *      stdout/stderr/exit events fire. Callers like cross-spawn.sync
   *      that read result.status get null until the spawn settles.
   *   3. When the parent facet's main drain settles __pendingIO before
   *      reportExit (facets/manager.ts), the result object's fields are
   *      filled in by the time the supervisor sees the parent exit.
   *
   * Cross-spawn.sync's typical pattern is "const r = spawnSync(...);
   * if (r.status !== 0) throw". To make THIS work synchronously, we
   * also expose a .__deferred promise; idiomatic Nimbus consumers
   * await r.__deferred to get a fully-populated result. Probes test
   * both shapes.
   *
   * Real Node spawnSync truly blocks the event loop via libuv; matching
   * that semantic in workerd would require Atomics.wait on shared state
   * which workerd doesn't expose to userland. Phase 1 documents this.
   */
  function spawnSync(cmd, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || []; opts = opts || {};
    const child = _spawn(cmd, args, opts);
    let stdout = "", stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => { stdout += String(d); });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += String(d); });

    const result = { pid: 0, stdout: "", stderr: "", status: null, signal: null, output: [null, "", ""] };
    let _done = false;
    // A spawn that failed is the result's `error`, named for spawnSync, as Node's.
    let spawnError = null;
    child.on("error", (e) => {
      spawnError = e;
      e.syscall = "spawnSync " + child.spawnfile;
      e.message = "spawnSync " + child.spawnfile + " " + e.code;
    });
    result.__deferred = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        if (spawnError) {
          result.error = spawnError;
          result.output = null;
          result.stdout = null;
          result.stderr = null;
          result.status = null;
          _done = true;
          resolve(result);
          return;
        }
        result.pid = child.pid;
        result.stdout = stdout;
        result.stderr = stderr;
        result.status = code;
        result.signal = signal;
        result.output = [null, stdout, stderr];
        // `timeout` ended it: Node's spawnSync says so in `error` as well.
        if (child._timedOut) {
          result.error = Object.assign(new Error("spawnSync " + child.spawnfile + " ETIMEDOUT"), {
            errno: -110, code: "ETIMEDOUT", syscall: "spawnSync " + child.spawnfile,
            path: child.spawnfile, spawnargs: child.spawnargs.slice(1),
          });
        }
        _done = true;
        resolve(result);
      });
    });
    // Best-effort eager population: as 'data' events flow we already
    // mutate stdout/stderr above; once 'exit' fires we also populate
    // .status synchronously (before 'close' which fires after streams
    // drain). This narrows the window where a sync caller sees
    // status=null.
    child.on("exit", (code, signal) => {
      if (result.status === null) result.status = code;
      if (result.signal === null) result.signal = signal;
    });
    return result;
  }

  /**
   * execSync/execFileSync return the child's stdout and throw when it exits
   * non-zero — a contract that is only meaningful once the child has run to
   * completion. A facet has no synchronous I/O primitive: every path to a
   * child process is an async supervisor RPC, and JS in workerd cannot block
   * on one. readFileSync answers the same constraint by serving content that
   * was already staged into the facet, but a command's output cannot exist
   * before the command runs, so there is nothing to pre-stage.
   *
   * The pre-fix shim kicked off an async spawn and returned an empty,
   * not-yet-populated result object. Callers — which shell out precisely
   * because they need the result NOW — read a blank stdout, or run their next
   * step before the child has started, and report success. Refusing is the
   * only honest answer left.
   */
  function _refuseSyncExec(api, command) {
    const err = new Error(
      "child_process." + api + " is not supported in a Nimbus node facet: a facet " +
      "has no synchronous I/O primitive, so a child process cannot be run to completion " +
      "without yielding to the event loop. Returning early would report success for a " +
      "command that has not run. Use the asynchronous form instead — exec/execFile/spawn, " +
      "or await util.promisify(child_process.exec)(...). Command: " + command,
    );
    err.code = "ERR_NIMBUS_SYNC_CHILD_PROCESS";
    err.command = command;
    throw err;
  }

  function execSync(cmd, opts) {
    _refuseSyncExec("execSync", String(cmd));
  }

  function execFileSync(file, args, opts) {
    _refuseSyncExec(
      "execFileSync",
      [String(file), ...(Array.isArray(args) ? args.map(String) : [])].join(" "),
    );
  }

  /**
   * fork(modulePath, args, opts) — spawn a child node facet with an IPC
   * channel. IPC is JSON-newline over the stdin queue. Phase-1 limits:
   *   - Buffer → {type:'Buffer', data:[...]} (JSON.stringify projection)
   *   - Date   → ISO string
   *   - Map/Set lose all entries (become {})
   * Documented + asserted in cp-fork-ipc.mjs.
   */
  function fork(modulePath, args, opts) {
    if (args && typeof args === "object" && !Array.isArray(args)) { opts = args; args = []; }
    args = args || []; opts = opts || {};
    // The child runs the requested module with __NIMBUS_FORK_IPC=1 in env
    // so a corresponding fork-aware runtime in the child knows to listen
    // on stdin for IPC frames.
    const childEnv = { ...(__processMod.env || {}), ...(opts.env || {}), NIMBUS_FORK_IPC: "1" };
    const child = _spawn("node", [modulePath, ...args], { ...opts, env: childEnv });
    child.connected = true;
    child.send = function(msg) {
      if (!child.connected) return false;
      if (!child.stdin) return false;
      try {
        const line = JSON.stringify(msg) + "\n";
        child.stdin.write(line);
        return true;
      } catch (e) {
        return false;
      }
    };
    // 'message' events: parent listens to child.stdout newline-
    // delimited and parses each as JSON. Real Node IPC uses a side-
    // channel fd; Phase 1 multiplexes through stdout. Any well-formed
    // JSON line counts as a message — non-JSON lines are dropped
    // silently (real fork would route them to stderr-style handling).
    // No __nimbusIpc envelope: round-trip is symmetric with the
    // parent's child.send which writes raw JSON.stringify(msg)+'\n'.
    child.stdout.on("data", (d) => {
      const lines = String(d).split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try { msg = JSON.parse(trimmed); }
        catch { continue; }
        try { child.emit("message", msg); } catch {}
      }
    });
    child.on("exit", () => {
      child.connected = false;
      try { child.emit("disconnect"); } catch {}
    });
    return child;
  }

  /**
   * Exit-time drain: walk __cpChildren and issue cpDrainOutput RPCs so
   * any unawaited children's stdout lands before the facet's reportExit.
   * Called automatically by the facet's exit path AND exposed for tests.
   */
  async function __cpDrainAllChildren() {
    if (!HAS_SUPERVISOR) return;
    const drains = [];
    for (const [pid, child] of __cpChildren) {
      drains.push((async () => {
        try {
          const r = await __nimbusUseRpcResult(
            __supervisor.cpDrainOutput(pid),
            (result) => result,
          );
          // Output means it started: 'spawn' before its first byte.
          if (r && ((r.stdout && r.stdout.byteLength > 0) || (r.stderr && r.stderr.byteLength > 0))) _markSpawned(child);
          if (r && r.stdout && r.stdout.byteLength > 0 && child.stdout) {
            try { child.stdout.write(__BufferMod.from(r.stdout)); } catch {}
          }
          if (r && r.stderr && r.stderr.byteLength > 0 && child.stderr) {
            try { child.stderr.write(__BufferMod.from(r.stderr)); } catch {}
          }
          // Force-close streams so listeners receive 'end'. The 'end'
          // event listeners in _makeChild flip _stdoutEnded/_stderrEnded.
          try { child.stdout && child.stdout.end(); } catch {}
          try { child.stderr && child.stderr.end(); } catch {}
          if (!child._exitFired) {
            // No exit reported yet — wait briefly, then synthesize. A start,
            // an exit or a refused spawn the wait reports is applied as the
            // wait loop applies it (_applyWait).
            let settled = false;
            try {
              const w = await __nimbusUseRpcResult(
                __supervisor.cpWait(pid, 500, undefined, child._started),
                (result) => result,
              );
              settled = _applyWait(child, w);
              _applyNews(w);
            } catch { /* synthesized below */ }
            if (!settled) {
              child.exitCode = child.exitCode == null ? 0 : child.exitCode;
              child._exitFired = true;
              try { child.emit("exit", child.exitCode, child.signalCode); } catch {}
              _flushStdio(child);
            }
          }
          _maybeFireClose(child);
        } catch { /* best-effort */ }
      })());
    }
    await Promise.allSettled(drains);
  }

  return {
    spawn: _spawn,
    spawnSync,
    exec,
    execSync,
    execFile,
    execFileSync,
    fork,
    ChildProcess: __eventsMod,
    __cpDrainAllChildren,    // exposed for the facet exit hook + tests
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// ──  console ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// Node's Console (lib/internal/console/constructor.js), the one console:
// each method formats its arguments with util.formatWithOptions, in colour
// for a stream that is a terminal with colours (Node's shouldColorize),
// indents the line by its group and writes it through the stream's own
// write. The process's console is one over process.stdout and
// process.stderr, so what it prints is theirs: captured, streamed live,
// nothing once the program stopped. workerd's node:console has no Console
// constructor ("The Console method is not implemented"), which OpenTUI's
// console capture calls over streams of its own.
// Node's colour policy (lib/internal/tty.js getColorDepth and hasColors,
// lib/internal/util/colors.js shouldColorize, v22.22.3), for its platform
// (Nimbus is linux): FORCE_COLOR first, then NODE_DISABLE_COLORS, NO_COLOR and
// TERM=dumb, then the CI and terminal variables. Each stream decides for
// itself: a terminal's getColorDepth reads the env it is given.
const __NIMBUS_TERM_ENVS = {
  eterm: 4, cons25: 4, console: 4, cygwin: 4, dtterm: 4, gnome: 4, hurd: 4, jfbterm: 4, konsole: 4, kterm: 4,
  mlterm: 4, mosh: 24, putty: 4, st: 4, "rxvt-unicode-24bit": 24, terminator: 24, "xterm-kitty": 24,
};
const __NIMBUS_CI_ENVS = [["APPVEYOR", 8], ["BUILDKITE", 8], ["CIRCLECI", 24], ["DRONE", 8], ["GITEA_ACTIONS", 24], ["GITHUB_ACTIONS", 24], ["GITLAB_CI", 8], ["TRAVIS", 8]];
const __NIMBUS_TERM_ENVS_REG_EXP = [/ansi/, /color/, /linux/, /direct/, /^con[0-9]*x[0-9]/, /^rxvt/, /^screen/, /^xterm/, /^vt100/, /^vt220/];
let __nimbusColorWarned = false;
// The warnings Node's console and colour policy emit: process.emitWarning.
function __nimbusEmitWarning(...args) {
  return Reflect.apply(__processMod.emitWarning, __processMod, args);
}
function __nimbusWarnOnDeactivatedColors(env) {
  if (__nimbusColorWarned) return;
  let name = "";
  if (env.NODE_DISABLE_COLORS !== undefined) name = "NODE_DISABLE_COLORS";
  if (env.NO_COLOR !== undefined) {
    if (name !== "") name += "' and '";
    name += "NO_COLOR";
  }
  if (name !== "") {
    __nimbusEmitWarning("The '" + name + "' env is ignored due to the 'FORCE_COLOR' env being set.", "Warning");
    __nimbusColorWarned = true;
  }
}
function __nimbusColorDepth(env = __processMod.env) {
  const hasOwn = (name) => Object.prototype.hasOwnProperty.call(env, name);
  if (env.FORCE_COLOR !== undefined) {
    switch (env.FORCE_COLOR) {
      case "":
      case "1":
      case "true":
        __nimbusWarnOnDeactivatedColors(env);
        return 4;
      case "2":
        __nimbusWarnOnDeactivatedColors(env);
        return 8;
      case "3":
        __nimbusWarnOnDeactivatedColors(env);
        return 24;
      default:
        return 1;
    }
  }
  if (env.NODE_DISABLE_COLORS !== undefined || env.NO_COLOR !== undefined || env.TERM === "dumb") return 1;
  if (env.TMUX) return 24;
  if (hasOwn("TF_BUILD") && hasOwn("AGENT_NAME")) return 4;
  if (hasOwn("CI")) {
    for (const [name, colors] of __NIMBUS_CI_ENVS) if (hasOwn(name)) return colors;
    if (env.CI_NAME === "codeship") return 8;
    return 1;
  }
  if ("TEAMCITY_VERSION" in env) return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.exec(env.TEAMCITY_VERSION) !== null ? 4 : 1;
  switch (env.TERM_PROGRAM) {
    case "iTerm.app":
      if (!env.TERM_PROGRAM_VERSION || /^[0-2]\./.exec(env.TERM_PROGRAM_VERSION) !== null) return 8;
      return 24;
    case "HyperTerm":
    case "MacTerm":
      return 24;
    case "Apple_Terminal":
      return 8;
  }
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return 24;
  if (env.TERM) {
    if (/truecolor/.exec(env.TERM) !== null) return 24;
    if (/^xterm-256/.exec(env.TERM) !== null) return 8;
    const termEnv = env.TERM.toLowerCase();
    if (__NIMBUS_TERM_ENVS[termEnv]) return __NIMBUS_TERM_ENVS[termEnv];
    if (__NIMBUS_TERM_ENVS_REG_EXP.some((term) => term.exec(termEnv) !== null)) return 4;
  }
  if (env.COLORTERM) return 4;
  return 1;
}
function __nimbusHasColors(count, env) {
  if (env === undefined && (count === undefined || (typeof count === "object" && count !== null))) {
    env = count;
    count = 16;
  } else if (typeof count !== "number") {
    throw Object.assign(new TypeError("The \"count\" argument must be of type number." + __nimbusReceived(count)), { code: "ERR_INVALID_ARG_TYPE" });
  } else if (!Number.isInteger(count) || count < 2 || count > Number.MAX_SAFE_INTEGER) {
    const range = Number.isInteger(count) ? ">= 2 && <= 9007199254740991" : "an integer";
    throw Object.assign(new RangeError("The value of \"count\" is out of range. It must be " + range + ". Received " + __utilMod.inspect(count)), { code: "ERR_OUT_OF_RANGE" });
  }
  return count <= 2 ** __nimbusColorDepth(env);
}
function __nimbusReceived(value) {
  if (value === null || value === undefined) return " Received " + value;
  if (typeof value === "function") return " Received function " + value.name;
  if (typeof value === "object") return value.constructor?.name ? " Received an instance of " + value.constructor.name : " Received " + __utilMod.inspect(value, { depth: -1 });
  let shown = __utilMod.inspect(value, { colors: false });
  if (shown.length > 28) shown = shown.slice(0, 25) + "...";
  return " Received type " + typeof value + " (" + shown + ")";
}
function __nimbusShouldColorize(stream) {
  if (__processMod.env.FORCE_COLOR !== undefined) return __nimbusColorDepth() > 2;
  return Boolean(stream?.isTTY) && (typeof stream.getColorDepth === "function" ? stream.getColorDepth() > 2 : true);
}
// Node's formatTime (lib/internal/util/debuglog.js), for console.time.
function __nimbusFormatTime(ms) {
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (ms >= 1000) {
    if (ms >= 60000) {
      if (ms >= 3600000) {
        hours = Math.floor(ms / 3600000);
        ms = ms % 3600000;
      }
      minutes = Math.floor(ms / 60000);
      ms = ms % 60000;
    }
    seconds = ms / 1000;
  }
  if (hours !== 0 || minutes !== 0) {
    const [whole, fraction] = seconds.toFixed(3).split(".");
    const pad = (n) => String(n).padStart(2, "0");
    const res = hours !== 0 ? hours + ":" + pad(minutes) : minutes;
    return res + ":" + pad(whole) + "." + fraction + " (" + (hours !== 0 ? "h:m" : "") + "m:ss.mmm)";
  }
  if (seconds !== 0) return seconds.toFixed(3) + "s";
  return Number(ms.toFixed(3)) + "ms";
}
// Node's lib/internal/cli_table.js: the head and the columns of cell text, drawn.
function __nimbusTable(head, columns) {
  const renderRow = (row, widths) => {
    let out = "│ ";
    for (let i = 0; i < row.length; i++) {
      out += row[i] + " ".repeat(Math.ceil(widths[i] - __nimbusNodeInspect().getStringWidth(row[i])));
      if (i !== row.length - 1) out += " │ ";
    }
    return out + " │";
  };
  const rows = [];
  const widths = head.map((h) => __nimbusNodeInspect().getStringWidth(h));
  const longest = Math.max(...columns.map((column) => column.length));
  for (let i = 0; i < head.length; i++) {
    const column = columns[i];
    for (let j = 0; j < longest; j++) {
      rows[j] ??= [];
      const value = rows[j][i] = Object.prototype.hasOwnProperty.call(column, j) ? column[j] : "";
      widths[i] = Math.max(widths[i] || 0, __nimbusNodeInspect().getStringWidth(value));
    }
  }
  const divider = widths.map((w) => "─".repeat(w + 2));
  let result = "┌" + divider.join("┬") + "┐\n" + renderRow(head, widths) + "\n" + "├" + divider.join("┼") + "┤\n";
  for (const row of rows) result += renderRow(row, widths) + "\n";
  return result + "└" + divider.join("┴") + "┘";
}
class __NimbusConsole {
  #stdout;
  #stderr;
  #ignoreErrors;
  #colorMode;
  #inspectOptions;
  #groupIndentation;
  #groupIndent = "";
  #counts = new Map();
  #timers = new Map();
  constructor(options, stderr, ignoreErrors) {
    if (!options || typeof options.write === "function") options = { stdout: options, stderr, ignoreErrors };
    const { stdout: out, stderr: err = out, ignoreErrors: ignore = true, colorMode = "auto", inspectOptions, groupIndentation = 2 } = options;
    for (const [name, stream] of [["stdout", out], ["stderr", err]]) {
      if (!stream || typeof stream.write !== "function") {
        const e = new TypeError("The \"" + name + "\" argument must be an instance of a writable stream.");
        e.code = "ERR_CONSOLE_WRITABLE_STREAM";
        throw e;
      }
    }
    this.#stdout = () => out;
    this.#stderr = () => err;
    this.#ignoreErrors = ignore;
    this.#colorMode = colorMode;
    this.#inspectOptions = inspectOptions;
    this.#groupIndentation = groupIndentation;
    // Node binds every method to its console, so a method taken off it works.
    for (const key of Object.getOwnPropertyNames(__NimbusConsole.prototype)) {
      if (key !== "constructor" && typeof this[key] === "function") this[key] = this[key].bind(this);
    }
  }
  // The process's console: over whatever process.stdout and process.stderr are when it writes.
  static forProcess(stdout, stderr) {
    const console = new __NimbusConsole({ write() {} });
    console.#stdout = stdout;
    console.#stderr = stderr;
    return console;
  }
  #optionsFor(stream) {
    const color = this.#colorMode === "auto" ? __nimbusShouldColorize(stream) : this.#colorMode;
    const options = this.#inspectOptions;
    if (options) return options.colors === undefined ? { ...options, colors: color } : options;
    return color ? { colors: true } : {};
  }
  #format(stream, args) {
    // Strings with no format directive are joined as formatWithOptions
    // joins them, without loading Node's inspect for a line it never needs.
    if (args.every((arg) => typeof arg === "string") && (args.length < 2 || !args[0].includes("%"))) return args.join(" ");
    return __utilMod.formatWithOptions(this.#optionsFor(stream), ...args);
  }
  #write(stream, string) {
    const indent = this.#groupIndent;
    if (indent.length !== 0) {
      if (string.includes("\n")) string = string.replace(/\n/g, "\n" + indent);
      string = indent + string;
    }
    try {
      stream.write(string + "\n");
    } catch (e) {
      if (!this.#ignoreErrors) throw e;
    }
  }
  log(...args) { const out = this.#stdout(); this.#write(out, this.#format(out, args)); }
  info(...args) { const out = this.#stdout(); this.#write(out, this.#format(out, args)); }
  debug(...args) { const out = this.#stdout(); this.#write(out, this.#format(out, args)); }
  dirxml(...args) { const out = this.#stdout(); this.#write(out, this.#format(out, args)); }
  warn(...args) { const err = this.#stderr(); this.#write(err, this.#format(err, args)); }
  error(...args) { const err = this.#stderr(); this.#write(err, this.#format(err, args)); }
  dir(object, options) {
    const out = this.#stdout();
    this.#write(out, __utilMod.inspect(object, { customInspect: false, ...this.#optionsFor(out), ...options }));
  }
  trace(...args) {
    const err = { name: "Trace", message: this.#format(this.#stderr(), args) };
    Error.captureStackTrace(err, __NimbusConsole.prototype.trace);
    this.error(err.stack);
  }
  assert(expression, ...args) {
    if (expression) return;
    args[0] = "Assertion failed" + (args.length === 0 ? "" : ": " + args[0]);
    Reflect.apply(this.warn, this, args);
  }
  clear() {
    const out = this.#stdout();
    if (!out.isTTY || __processMod.env.TERM === "dumb") return;
    if (typeof out.cursorTo === "function") out.cursorTo(0, 0);
    if (typeof out.clearScreenDown === "function") out.clearScreenDown();
  }
  count(label = "default") {
    label = String(label);
    const count = (this.#counts.get(label) ?? 0) + 1;
    this.#counts.set(label, count);
    this.log(label + ": " + count);
  }
  countReset(label = "default") {
    label = String(label);
    if (!this.#counts.has(label)) {
      __nimbusEmitWarning("Count for '" + label + "' does not exist");
      return;
    }
    this.#counts.delete(label);
  }
  group(...data) {
    if (data.length > 0) Reflect.apply(this.log, this, data);
    this.#groupIndent += " ".repeat(this.#groupIndentation);
  }
  groupCollapsed(...data) { Reflect.apply(this.group, this, data); }
  groupEnd() {
    this.#groupIndent = this.#groupIndent.slice(0, this.#groupIndent.length - this.#groupIndentation);
  }
  time(label = "default") {
    label = String(label);
    if (this.#timers.has(label)) {
      __nimbusEmitWarning("Label '" + label + "' already exists for console.time()");
      return;
    }
    this.#timers.set(label, performance.now());
  }
  timeEnd(label = "default") {
    label = String(label);
    if (this.#timeLog("timeEnd", label, [])) this.#timers.delete(label);
  }
  timeLog(label = "default", ...data) {
    this.#timeLog("timeLog", String(label), data);
  }
  #timeLog(name, label, data) {
    const start = this.#timers.get(label);
    if (start === undefined) {
      __nimbusEmitWarning("No such label '" + label + "' for console." + name + "()");
      return false;
    }
    Reflect.apply(this.log, this, ["%s: %s", label, __nimbusFormatTime(performance.now() - start), ...data]);
    return true;
  }
  // Node's console.table and lib/internal/cli_table.js. A Map or Set
  // iterator is tabled as the object it is: Node previews one without
  // consuming it, which only its internals can.
  table(data, properties) {
    if (properties !== undefined && !Array.isArray(properties)) {
      const e = new TypeError("The \"properties\" argument must be an instance of Array.");
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    if (data === null || typeof data !== "object") return this.log(data);
    const options = this.#optionsFor(this.#stdout());
    const show = (v) => __utilMod.inspect(v, {
      depth: v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 2 ? -1 : 0,
      maxArrayLength: 3,
      breakLength: Infinity,
      ...options,
    });
    const indexes = (length) => Array.from({ length }, (_, i) => show(i));
    const render = (head, columns) => this.log(__nimbusTable(head, columns));
    if (__realUtil.types.isMap(data)) {
      const keys = [];
      const values = [];
      for (const [k, v] of data) { keys.push(show(k)); values.push(show(v)); }
      return render(["(iteration index)", "Key", "Values"], [indexes(keys.length), keys, values]);
    }
    if (__realUtil.types.isSet(data)) {
      const values = [];
      for (const v of data) values.push(show(v));
      return render(["(iteration index)", "Values"], [indexes(values.length), values]);
    }
    const map = Object.create(null);
    let hasPrimitives = false;
    const primitives = [];
    const indexKeys = Object.keys(data);
    for (let i = 0; i < indexKeys.length; i++) {
      const item = data[indexKeys[i]];
      const primitive = item === null || (typeof item !== "function" && typeof item !== "object");
      if (properties === undefined && primitive) {
        hasPrimitives = true;
        primitives[i] = show(item);
      } else {
        for (const key of properties || Object.keys(item)) {
          map[key] ??= [];
          map[key][i] = (primitive && properties) || !Object.prototype.hasOwnProperty.call(item, key) ? "" : show(item[key]);
        }
      }
    }
    const keys = Object.keys(map);
    const values = Object.values(map);
    if (hasPrimitives) {
      keys.push("Values");
      values.push(primitives);
    }
    keys.unshift("(index)");
    values.unshift(indexKeys);
    return render(keys, values);
  }
  timeStamp() {}
  profile() {}
  profileEnd() {}
}
const __consoleMod = __NimbusConsole.forProcess(() => __processMod.stdout, () => __processMod.stderr);
__consoleMod.Console = __NimbusConsole;

// ═══════════════════════════════════════════════════════════════════════
// ──  process shim ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __nimbusAttachedTty = env?.NIMBUS_ATTACHED_TTY === "1";
let __nimbusTtyColumns = Number(env && env.COLUMNS) || 80;
let __nimbusTtyRows = Number(env && env.LINES) || 24;
const __nimbusTerminalOutputStreams = [];
function __nimbusClampTerminalCoordinate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}
function __nimbusWriteControl(stream, data, cb) {
  if (stream && typeof stream.write === "function") stream.write(data);
  if (typeof cb === "function") queueMicrotask(cb);
  return true;
}
function __nimbusClearLine(stream, dir, cb) {
  const n = Number(dir);
  const mode = n < 0 ? 1 : n > 0 ? 0 : 2;
  return __nimbusWriteControl(stream, "\x1b[" + mode + "K", cb);
}
function __nimbusClearScreenDown(stream, cb) {
  return __nimbusWriteControl(stream, "\x1b[0J", cb);
}
function __nimbusCursorTo(stream, x, y, cb) {
  if (typeof y === "function") {
    cb = y;
    y = undefined;
  }
  const col = __nimbusClampTerminalCoordinate(x) + 1;
  if (y === undefined) return __nimbusWriteControl(stream, "\x1b[" + col + "G", cb);
  const row = __nimbusClampTerminalCoordinate(y) + 1;
  return __nimbusWriteControl(stream, "\x1b[" + row + ";" + col + "H", cb);
}
function __nimbusMoveCursor(stream, dx, dy, cb) {
  let out = "";
  const x = Math.trunc(Number(dx) || 0);
  const y = Math.trunc(Number(dy) || 0);
  if (x < 0) out += "\x1b[" + (-x) + "D";
  else if (x > 0) out += "\x1b[" + x + "C";
  if (y < 0) out += "\x1b[" + (-y) + "A";
  else if (y > 0) out += "\x1b[" + y + "B";
  return __nimbusWriteControl(stream, out, cb);
}
function __nimbusEmitTerminalResize() {
  for (const stream of __nimbusTerminalOutputStreams) {
    try { stream.emit("resize"); } catch {}
  }
}
// The process's live input channel, or 0 when its stdin is the launch's own
// text: the channel the launch was given (a pipe its fd 0 streams through, or
// a resident's start payload: __nimbusLiveInputPid in facets/manager.ts), else
// the child_process child its env names. The launch's own wins: a node that a
// child's script runs reads the script's stdin as the shell handed it, not the
// child's queue it inherited the name of.
function __nimbusLiveInputChannel() {
  const own = typeof __nimbusLiveInputPid === "number" ? __nimbusLiveInputPid : 0;
  return own || (env && env.NIMBUS_CP_CHILD_PID ? Number(env.NIMBUS_CP_CHILD_PID) : 0);
}
// fd 0 of a `< file` redirect is the file itself, from the redirect's
// offset (facets/manager.ts, __nimbusStdinFile): read at a position for a
// synchronous read, streamed by process.stdin.
function __nimbusStdinFileSource() {
  return typeof __nimbusStdinFile !== "undefined" && __nimbusStdinFile !== null ? __nimbusStdinFile : null;
}
// What fd 0 holds before the program reads it, taken once by process.stdin's
// first consumer or a synchronous read of fd 0, whichever comes first (the
// two share one fd in Node): the launch's own stdin text; for a live channel
// (a pipe streaming through it, facets/manager.ts _pumpStdinPipe, or a
// child_process child's), what __nimbusPrepareStdin took before the entry ran
// and what __nimbusFollowStdin has taken since; for a `< file`, the file from
// its offset. `ended` says nothing more will follow.
let __nimbusStdinTaken = false;
let __nimbusQueuedStdin = null;
// A growing fd 0: pieces as they arrive, joined when a read looks.
function __nimbusStdinBuffer() {
  return {
    parts: [], length: 0, flat: null, ended: false,
    get bytes() {
      if (this.flat === null) { this.flat = __BufferMod.concat(this.parts, this.length); this.parts = [this.flat]; }
      return this.flat;
    },
    append(piece) { this.parts.push(piece); this.length += piece.byteLength; this.flat = null; },
  };
}
function __nimbusStdinEnded() {
  // A `< file` preloaded up to the read ahead ends there only when the file
  // does; one not preloaded is read whole by path when a synchronous read
  // needs it (__nimbusTakeStdin).
  if (__nimbusStdinFileSource() !== null) return __nimbusQueuedStdin === null || __nimbusQueuedStdin.ended;
  if (!__nimbusLiveInputChannel()) return true;
  return __nimbusQueuedStdin !== null && __nimbusQueuedStdin.ended;
}
// What fd 0 held, once: `source` is what reads go on reading (the live
// buffer, still growing, for a live channel).
function __nimbusTakeStdin() {
  const ended = __nimbusStdinEnded();
  if (__nimbusStdinTaken) return { source: { bytes: __BufferMod.alloc(0) }, ended };
  __nimbusStdinTaken = true;
  if (__nimbusQueuedStdin !== null) return { source: __nimbusQueuedStdin, ended };
  const file = __nimbusStdinFileSource();
  if (file !== null) {
    // Not read before the entry ran: the file as the process's own
    // synchronous read of it. One the launch did not stage stops the run, and
    // the next run reads it ahead (FacetManager.exec); a run that cannot stop
    // answers as any unstaged read does.
    try {
      return { source: { bytes: __fsMod.readFileSync(file.path).subarray(file.offset) }, ended };
    } catch (err) {
      if (err && err.code === "EAGAIN") __nimbusStopForStdin("end", "read");
      throw err;
    }
  }
  if (__nimbusLiveInputChannel()) {
    __nimbusQueuedStdin = __nimbusStdinBuffer();
    return { source: __nimbusQueuedStdin, ended };
  }
  return { source: { bytes: __BufferMod.from(typeof stdin === "string" ? stdin : "") }, ended };
}
// The paths that name fd 0.
const __NIMBUS_STDIN_PATHS = new Set(["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);
// Synchronous reads of fd 0 (readSync, readFileSync, fs.read) share one
// position in what fd 0 held, as they do in Node, and process.stdin goes on
// from it (__nimbusStdinRemainder).
let __nimbusSyncStdin = null;
function __nimbusSyncStdinState() {
  if (__nimbusSyncStdin === null) __nimbusSyncStdin = { source: __nimbusTakeStdin().source, pos: 0 };
  return __nimbusSyncStdin;
}
// What process.stdin delivers first: what synchronous reads left of fd 0, or
// all it held when none read it. From here process.stdin reads the channel,
// and the follower hands it whatever it takes after.
function __nimbusStdinRemainder() {
  __nimbusStdinFollower?.handOver();
  if (__nimbusSyncStdin === null) return __nimbusTakeStdin().source.bytes;
  const bytes = __nimbusSyncStdin.source.bytes;
  const rest = bytes.subarray(__nimbusSyncStdin.pos);
  __nimbusSyncStdin.pos = bytes.byteLength;
  return rest;
}
// Whether a read of fd 0 could find it short of what it needs, which makes
// the run one that can stop (runtime/stop-replay.ts): a pipe or a child's
// channel not ended when the program starts, or a `< file` not read ahead.
function __nimbusStdinCanStop() {
  if (__nimbusStdinFileSource() !== null) return __nimbusQueuedStdin === null;
  return __nimbusLiveInputChannel() !== 0 && !__nimbusStdinEnded();
}
// A read of fd 0 needs input that has not arrived: `until` "end" (all of
// stdin) or "data" (any of it). Node blocks the program until its writer
// gives it. Here the run stops, and the supervisor runs the program again from
// its start once the input is there, replaying what this run drew
// (FacetManager.exec, runtime/stop-replay.ts). When it stops this never
// returns: ctx.abort ends the isolate's JavaScript, so no catch or finally of
// the program runs. It returns why the run cannot stop.
function __nimbusStopForStdin(until, syscall) {
  if (!__nimbusReplay || !__nimbusReplay.armed) return "had not started";
  // process.stdin's pump takes input off the channel as it arrives, which a
  // second run could not be handed back.
  if (__nimbusLiveStdinPump !== null) return "read process.stdin as it arrived first, which a second run could not be handed back";
  return __nimbusReplay.block(until, syscall);
}
function __nimbusSyncStdinError(api, why) {
  // The whole message before the Error is built: its stack, which is what an
  // uncaught error prints, captures the message at construction.
  const file = __nimbusStdinFileSource();
  const err = new Error(file !== null && __nimbusQueuedStdin !== null && !__nimbusQueuedStdin.ended
    ? "ERR_NIMBUS_SYNC_STDIN: stdin is a file larger than 16 MiB, and synchronous reads of it are served from its first 16 MiB only, so a large redirect is never held whole. Read process.stdin, which streams the file"
    : "ERR_NIMBUS_SYNC_STDIN: fs." + api + "(0) has to wait for stdin, which is still open. Nimbus waits by running the program again from its start once the input is there, but this program " + why + ". Read process.stdin instead: it takes the input as it arrives");
  err.code = "ERR_NIMBUS_SYNC_STDIN";
  err.syscall = "read";
  return err;
}
// A read of fd 0 into `target`: bytes copied, 0 at its end. With nothing
// there and its writer still open, the run stops until there is
// (__nimbusStopForStdin). A run after a stop returns what each of the stopped
// run's reads returned, in order, then what is there.
function __nimbusReadStdinInto(target, offset, length, syscall) {
  const state = __nimbusSyncStdinState();
  const view = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
  const at = Number.isInteger(offset) ? offset : 0;
  const room = Math.max(0, view.byteLength - at);
  const want = Math.min(Number.isInteger(length) ? length : room, room);
  if (want === 0) return 0;
  const bytes = state.source.bytes;
  const available = Math.min(want, bytes.byteLength - state.pos);
  const ended = __nimbusStdinEnded();
  const n = __nimbusReplay ? __nimbusReplay.readSome(available, ended) : (available > 0 || ended ? available : -1);
  if (n < 0) throw __nimbusSyncStdinError("readSync", __nimbusStopForStdin("data", syscall));
  if (n > 0) {
    view.set(bytes.subarray(state.pos, state.pos + n), at);
    state.pos += n;
    __nimbusStdinFollower?.consumed();
  }
  return n;
}
// A live channel's packet as fd 0 takes it: its bytes into `buffer`, its
// end, and a terminating signal ends the program as Node's default action
// does (a handler the program installed takes it instead).
function __nimbusStdinPacket(packet, buffer, beforeEntry) {
  if (packet.data && packet.data.byteLength > 0) buffer.append(__BufferMod.from(packet.data));
  if (packet.signal) {
    const sig = String(packet.signal);
    let handled = false;
    if (!beforeEntry) { try { handled = __processEvents.emit(sig); } catch {} }
    if (!handled && (sig === "SIGINT" || sig === "SIGTERM" || sig === "SIGKILL")) {
      const code = sig === "SIGINT" ? 130 : sig === "SIGKILL" ? 137 : 143;
      __nimbusReportProcessExit(code, sig);
      throw new __ProcessExit(code);
    }
  }
  if (packet.ended) buffer.ended = true;
}
// Read from the live channel before the entry runs: all of it when it has
// ended (`whole`, __nimbusStdinWhole: a run after a stop that waited for the
// end of stdin); else at least `atLeast` bytes (__nimbusStdinAtLeast: the
// stdin a run after a stop is handed back, however much that is), then what
// the channel holds now, without waiting, up to a bound (an endless writer
// refills the channel as fast as it is read).
const __NIMBUS_QUEUED_STDIN_MAX_BYTES = 1024 * 1024;
async function __nimbusTakeQueuedStdin(whole, atLeast) {
  const pid = __nimbusLiveInputChannel();
  if (!pid || !__supervisor || typeof __supervisor.cpReadStdin !== "function") return;
  const buffer = __nimbusStdinBuffer();
  let failures = 0;
  while (whole || buffer.length < atLeast + __NIMBUS_QUEUED_STDIN_MAX_BYTES) {
    const waits = whole || buffer.length < atLeast;
    let packet;
    try {
      packet = await __nimbusUseRpcResult(
        __supervisor.cpReadStdin(pid, waits ? 1000 : 0),
        (result) => result,
      );
      failures = 0;
    } catch (err) {
      // A dropped supervisor call (the session object reset, a network blip)
      // is retried as the live pump retries it, not taken as the end.
      if (++failures > 10) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (!packet) break;
    const hasData = !!(packet.data && packet.data.byteLength > 0);
    __nimbusStdinPacket(packet, buffer, true);
    if (buffer.ended) break;
    if (!waits && !hasData && !packet.signal) break;
  }
  __nimbusQueuedStdin = buffer;
}
// While the program runs, its live channel's input and end keep arriving in
// fd 0 (a long poll, never holding the program open), so a synchronous read
// finds what its writer has written by then, and its end: Node's would.
// Bounded: past __NIMBUS_QUEUED_STDIN_MAX_BYTES more it stops taking, and the
// writer waits for the reader, as a full pipe makes it. Once process.stdin
// reads the channel itself (handOver), what the follower took last is
// process.stdin's.
let __nimbusStdinFollower = null;
function __nimbusFollowStdin(pid) {
  const buffer = __nimbusQueuedStdin;
  let handedOver = false;
  let wake = null;
  const late = [];
  // What fd 0 holds that no read has taken: the follower pauses at the bound
  // and goes on as reads take it (consumed), as a pipe's writer does.
  const unread = () => buffer.length - (__nimbusSyncStdin !== null ? __nimbusSyncStdin.pos : 0);
  const follow = async () => {
    let failures = 0;
    while (!handedOver && !buffer.ended && !__nimbusProgramStopped) {
      if (unread() >= __NIMBUS_QUEUED_STDIN_MAX_BYTES) {
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
        continue;
      }
      let packet;
      try {
        // Unref'd, as process.stdin's pump is: the program is not held open
        // for a stdin it may never read.
        packet = await __nimbusUseRpcResultUnref(__supervisor.cpReadStdin(pid, 1000), (result) => result);
        failures = 0;
      } catch {
        if (++failures > 10) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (!packet) return;
      const delivers = !!(packet.data && packet.data.byteLength > 0) || packet.ended || packet.signal;
      if (handedOver) { if (delivers) late.push(packet); return; }
      try { __nimbusStdinPacket(packet, buffer, false); }
      catch (err) { if (err instanceof __ProcessExit) return; throw err; }
    }
  };
  const done = follow().catch(() => {});
  return {
    handOver() { handedOver = true; if (wake) wake(); },
    // A read took bytes: what it took is dropped once it is most of fd 0, and
    // a paused follower goes on below the bound.
    consumed() {
      const state = __nimbusSyncStdin;
      if (state !== null && state.source === buffer && state.pos > __NIMBUS_QUEUED_STDIN_MAX_BYTES && state.pos * 2 > buffer.length) {
        const rest = buffer.bytes.slice(state.pos);
        buffer.parts = [rest];
        buffer.length = rest.byteLength;
        buffer.flat = null;
        state.pos = 0;
      }
      if (wake && unread() < __NIMBUS_QUEUED_STDIN_MAX_BYTES) wake();
    },
    // What it took after the hand-over, once its last poll is in.
    async late() { await done; return late; },
  };
}
// Before the entry runs: what its synchronous reads of fd 0 have in hand.
// A live channel: what it holds (all of it when it has ended, and at least
// what a run after a stop is handed back), then the follower. A `< file` a
// run that stopped read synchronously (`syncRead`): the file from its
// offset up to the read ahead, read in ranges into one buffer; a larger file
// is never held whole, and process.stdin streams on from there. Any other
// file is read as the program reads it.
async function __nimbusPrepareStdin() {
  const file = __nimbusStdinFileSource();
  if (file !== null) {
    if (!file.syncRead) { await __nimbusUseRpcResult(__supervisor.stdinPrepared(), () => undefined); return; }
    const prepared = await __nimbusUseRpcResult(__supervisor.stdinFileRead(file.path, file.offset, 65536), (r) => r);
    const want = Math.max(0, Math.min(prepared.size - file.offset, 16777216));
    const bytes = __BufferMod.allocUnsafe(want);
    let got = 0, packet = prepared;
    while (got < want) {
      const n = Math.min(packet.data.byteLength, want - got);
      if (!n) break;
      bytes.set(packet.data.subarray(0, n), got);
      got += n;
      if (got < want) packet = await __nimbusUseRpcResult(__supervisor.stdinFileRead(file.path, file.offset + got, Math.min(65536, want - got)), (r) => r);
    }
    __nimbusQueuedStdin = { bytes: bytes.subarray(0, got), ended: file.offset + got >= prepared.size, from: file.offset + got };
    await __nimbusUseRpcResult(__supervisor.stdinPrepared(), () => undefined);
    return;
  }
  const pid = __nimbusLiveInputChannel();
  if (pid) {
    await __nimbusTakeQueuedStdin(
      typeof __nimbusStdinWhole !== "undefined" && __nimbusStdinWhole === true,
      typeof __nimbusStdinAtLeast === "number" ? __nimbusStdinAtLeast : 0,
    );
    if (__nimbusQueuedStdin !== null && !__nimbusQueuedStdin.ended) __nimbusStdinFollower = __nimbusFollowStdin(pid);
  }
}
function __makeProcessStdin() {
  const r = new __streamMod.PassThrough();
  // As in Node: readFileSync(process.stdin.fd) reads fd 0.
  r.fd = 0;
  let seeded = false;
  let encoding = null;
  r.isTTY = __nimbusAttachedTty;
  r.isRaw = false;
  r.setRawMode = function(mode) {
    r.isRaw = mode !== false;
    return r;
  };
  r.ref = function() { inputReferenced = true; if (r.readableFlowing) holdInput(true); return r; };
  r.unref = function() { inputReferenced = false; holdInput(false); return r; };
  r.setEncoding = function(enc) { encoding = enc || null; return r; };
  const liveChildPid = __nimbusLiveInputChannel();
  // The polling infrastructure is unref'd, but a program actively consuming
  // live stdin owns a referenced input handle, as in Node. Otherwise an
  // interactive child exits after its prompt, before a keystroke arrives.
  let inputReferenced = true, inputHeld = false;
  function holdInput(want) {
    const held = !!(want && liveChildPid && inputReferenced && !r.readableEnded && !r.destroyed);
    if (held === inputHeld) return;
    inputHeld = held;
    globalThis.__nimbusInputHandles = (globalThis.__nimbusInputHandles || 0) + (held ? 1 : -1);
    if (!held) globalThis.__nimbusHandleReleased?.();
  }
  __eventsMod.prototype.on.call(r, 'end', () => holdInput(false));
  __eventsMod.prototype.on.call(r, 'close', () => holdInput(false));
  if (liveChildPid) {
    try {
      globalThis.__nimbusProcessStdin = r;
      const pending = Array.isArray(globalThis.__nimbusPendingProcessInput)
        ? globalThis.__nimbusPendingProcessInput.splice(0)
        : [];
      globalThis.__nimbusPendingProcessInputBytes = 0;
      for (const chunk of pending) r.write(String(chunk));
      if (globalThis.__nimbusPendingProcessInputEnded) {
        globalThis.__nimbusPendingProcessInputEnded = false;
        queueMicrotask(() => r.end());
      }
    } catch {}
  }
  async function pumpLiveStdin() {
    let readFailures = 0;
    // What fd 0's follower took after process.stdin took the channel over
    // comes first (__nimbusFollowStdin).
    const handedOver = __nimbusStdinFollower !== null ? await __nimbusStdinFollower.late() : [];
    while (liveChildPid && !__nimbusProgramStopped && __supervisor && typeof __supervisor.cpReadStdin === "function") {
      let packet;
      try {
        // Unref'd: this long-poll runs for the whole life of an attached
        // facet, so counting it as in-flight work would mean the entry drain
        // never sees the program finish.
        packet = handedOver.length > 0 ? handedOver.shift() : await __nimbusUseRpcResultUnref(
          __supervisor.cpReadStdin(liveChildPid, 1000, __nimbusVfsAcquireArgs()),
          (result) => result,
        );
        readFailures = 0;
      } catch (pumpErr) {
        // Transient supervisor failure — e.g. the session Durable Object
        // instance was reset mid-flight ("Internal error in Durable Object
        // storage caused object to be reset"). The binding routes by DO id,
        // so the next call lands on the fresh instance; killing the pump
        // (and falsely reporting exit 1) on the first rejection turned a
        // recoverable blip into a dead TUI. Retry with a short pause and
        // give up only on persistent failure.
        readFailures++;
        if (readFailures > 10) throw pumpErr;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      // A packet that delivers anything — input, its end, a signal, a resize
      // — hands the program news from outside it, and whatever sent the news
      // may have written files first (a shell's `echo v2 > f` before the
      // keystroke, the editor's save before the signal). So it takes the
      // barrier before any handler sees it. The poll sent this process's
      // ACQUIRE arguments and the packet carries the answer, so a keystroke
      // costs no round trip of its own. An empty poll delivers nothing and
      // costs nothing.
      if (packet && (packet.resize || packet.signal || packet.ended
          || (packet.data && packet.data.byteLength > 0))) {
        await __nimbusInboundBarrier(packet.acquired);
      }
      if (packet && packet.resize) {
        __nimbusTtyColumns = Number(packet.resize.columns) || __nimbusTtyColumns;
        __nimbusTtyRows = Number(packet.resize.rows) || __nimbusTtyRows;
        __nimbusEmitTerminalResize();
        try { __processEvents.emit("SIGWINCH"); } catch {}
      }
      if (packet && packet.signal) {
        const sig = String(packet.signal);
        let handled = false;
        try { handled = __processEvents.emit(sig); } catch {}
        if (!handled && (sig === "SIGINT" || sig === "SIGTERM" || sig === "SIGKILL")) {
          const code = sig === "SIGINT" ? 130 : sig === "SIGKILL" ? 137 : 143;
          __nimbusReportProcessExit(code, sig);
          throw new __ProcessExit(code);
        }
      }
      // The queue hands back bytes; a Readable given a string would encode
      // it again.
      if (packet && packet.data && packet.data.byteLength > 0) {
        r.write(__BufferMod.from(packet.data));
      }
      if (packet && packet.ended) {
        r.end();
        break;
      }
      // Diagnostic hook (runner-installed, NIMBUS_DIAG_EXEC-gated): the pump's
      // cpReadStdin round-trip is the one I/O yield a resident facet is
      // guaranteed to keep making, so it paces the [oc-mem] sampler even when
      // facet timers starve.
      try { globalThis.__nimbusOcPumpDiag && globalThis.__nimbusOcPumpDiag(); } catch {}
    }
  }
  const seed = () => {
    if (seeded) return;
    seeded = true;
    // A `< file` streams from the file itself as the program reads: after
    // what a preload or synchronous reads left, from where that stopped.
    const file = __nimbusStdinFileSource();
    if (file !== null) {
      let from = file.offset;
      if (__nimbusSyncStdin !== null || __nimbusQueuedStdin !== null || __nimbusStdinTaken) {
        const first = __nimbusStdinRemainder();
        if (first.length > 0) r.write(first);
        if (__nimbusQueuedStdin === null || __nimbusQueuedStdin.ended) {
          queueMicrotask(() => r.end());
          return;
        }
        from = __nimbusQueuedStdin.from;
      } else {
        __nimbusStdinTaken = true;
      }
      const source = __fsMod.createReadStream(file.path, { start: from });
      source.on("error", (err) => r.destroy(err));
      source.pipe(r);
      return;
    }
    if (liveChildPid && __supervisor && typeof __supervisor.cpReadStdin === "function") {
      // What fd 0 held at the start and synchronous reads left comes first;
      // the pump reads on from there unless that was all of it.
      const first = __nimbusStdinRemainder();
      if (first.length > 0) r.write(first);
      if (__nimbusStdinEnded()) {
        queueMicrotask(() => r.end());
        return;
      }
      const pump = pumpLiveStdin().catch((e) => {
        if (e instanceof __ProcessExit) {
          if (!__nimbusProcessExitReported) {
            try { __nimbusReportProcessExit(e.code, ""); } catch {}
          }
          return;
        }
        const trace = (e && e.stack) || (e && e.message) || String(e);
        stderr += trace + "\n";
        try { __nimbusUseRpcResult(__supervisor.stderr(__nimbusOutEnc.encode(trace + "\n")), () => undefined).catch(() => {}); } catch {}
        try { __nimbusUseRpcResult(__supervisor.reportExit(1, trace + "\n"), () => undefined).catch(() => {}); } catch {}
        try { r.end(); } catch {}
      });
      __nimbusLiveStdinPump = pump;
      return;
    }
    queueMicrotask(() => {
      // A Buffer, as Node's stdin chunks are: `s += chunk` and
      // chunk.toString() read text, where a bare Uint8Array reads "104,105".
      const data = __nimbusStdinRemainder();
      if (data.length > 0) r.write(data);
      r.end();
    });
  };
  r.__nimbusStartLivePump = seed;
  const origResume = typeof r.resume === "function" ? r.resume.bind(r) : null;
  const origPause = typeof r.pause === "function" ? r.pause.bind(r) : null;
  r.resume = function() {
    seed();
    holdInput(true);
    return origResume ? origResume() : r;
  };
  r.pause = function() {
    holdInput(false);
    return origPause ? origPause() : r;
  };
  const origOn = r.on.bind(r);
  const calls = Symbol("nimbus.stdin.calls");
  function wrapDataListener(listener) {
    const wrapped = (chunk) => {
      let out = chunk;
      if (encoding && chunk instanceof Uint8Array) {
        try { out = new TextDecoder(encoding).decode(chunk); }
        catch { out = chunk; }
      }
      return listener(out);
    };
    // node:events answers listeners() with a wrapper's .listener: the
    // program's function, also through once()'s own wrapper. The function
    // this one calls is kept apart, so once()'s wrapper can remove itself.
    wrapped.listener = listener.listener ?? listener;
    wrapped[calls] = listener;
    return wrapped;
  }
  // Removal finds the wrapper of the function passed: the program's own, or
  // once()'s wrapper removing itself after it fires.
  const origRemove = r.removeListener.bind(r);
  r.removeListener = function(event, listener) {
    if (event === "data" && typeof listener === "function") {
      const raw = r.rawListeners("data");
      for (let i = raw.length - 1; i >= 0; i--) {
        const w = raw[i];
        if (w === listener || w[calls] === listener || w.listener === listener) return origRemove(event, w);
      }
    }
    return origRemove(event, listener);
  };
  r.off = r.removeListener;
  // Only a consumer starts stdin, as in Node: a 'data' or 'readable'
  // listener, resume() or read(). An 'end', 'close' or 'error' listener on
  // paused stdin receives nothing. Vite's dev server registers
  // process.stdin.on("end", closeServerAndExit); seeding on that listener
  // ended stdin at once, and every Vite dev server (Astro's included) shut
  // itself down seconds after it started.
  r.on = function(event, listener) {
    if (event === "data" || event === "readable") seed();
    if (event === "data" && typeof listener === "function") {
      const wrapped = wrapDataListener(listener);
      const ret = origOn(event, wrapped);
      try { r.resume(); } catch {}
      return ret;
    }
    return origOn(event, listener);
  };
  r.addListener = r.on;
  const origRead = r.read.bind(r);
  r.read = function(size) { seed(); return origRead(size); };
  return r;
}

function __makeProcessOutputStream(streamName) {
  const stream = new __eventsMod();
  Object.assign(stream, {
    fd: streamName === "stderr" ? 2 : 1,
    isTTY: __nimbusAttachedTty,
    writable: true,
    writableEnded: false,
    writableFinished: false,
    writableLength: 0,
    writableNeedDrain: false,
    writableHighWaterMark: 16 * 1024,
    writableObjectMode: false,
    writableCorked: 0,
    readable: false,
    destroyed: false,
    closed: false,
    errored: null,
    write(d, enc, cb) {
      if (typeof enc === "function") cb = enc;
      if (__nimbusProgramStopped) return true;
      // The reported result is text; decode the bytes at this edge only.
      const s = __nimbusOutText(streamName, __nimbusOutBytes(d, enc));
      if (streamName === "stderr") stderr += s;
      else stdout += s;
      if (typeof cb === "function") queueMicrotask(cb);
      return true;
    },
    // A terminal's colours are Node's policy; a pipe's, none.
    getColorDepth: (env) => __nimbusAttachedTty ? __nimbusColorDepth(env) : 1,
    hasColors: (count, env) => __nimbusAttachedTty ? __nimbusHasColors(count, env) : false,
    clearLine(dir, cb) { return __nimbusClearLine(stream, dir, cb); },
    clearScreenDown(cb) { return __nimbusClearScreenDown(stream, cb); },
    cursorTo(x, y, cb) { return __nimbusCursorTo(stream, x, y, cb); },
    moveCursor(dx, dy, cb) { return __nimbusMoveCursor(stream, dx, dy, cb); },
    end(d, enc, cb) {
      if (d !== undefined && typeof d !== "function") stream.write(d, enc);
      if (typeof d === "function") cb = d;
      if (typeof enc === "function") cb = enc;
      stream.writableEnded = true;
      stream.writableFinished = true;
      if (typeof cb === "function") queueMicrotask(cb);
      stream.emit("finish");
      return stream;
    },
    destroy(err) {
      stream.destroyed = true;
      stream.closed = true;
      stream.errored = err || null;
      if (err) stream.emit("error", err);
      stream.emit("close");
      return stream;
    },
    cork() { stream.writableCorked++; },
    uncork() { if (stream.writableCorked > 0) stream.writableCorked--; },
    ref() { return stream; },
    unref() { return stream; },
  });
  Object.defineProperty(stream, "columns", { enumerable: true, get() { return __nimbusTtyColumns; } });
  Object.defineProperty(stream, "rows", { enumerable: true, get() { return __nimbusTtyRows; } });
  __nimbusTerminalOutputStreams.push(stream);
  return stream;
}

function __nimbusReportProcessExit(code, reason) {
  if (__nimbusProcessExitReported) return;
  __nimbusProcessExitCode = Number(code ?? 0);
  __nimbusProgramStopped = true;
  try { if (typeof globalThis.__nimbusStopProgramTimers === "function") globalThis.__nimbusStopProgramTimers(); } catch {}
  try { if (__nimbusProcessExitResolve) __nimbusProcessExitResolve(__nimbusProcessExitCode); } catch {}
  // Generated lifecycle owners defer the terminal supervisor report until
  // their durability boundary has drained. Reporting here would retire the
  // writer capability before pending sync/append mutations can commit.
  if (
    typeof __nimbusDeferProcessExitReport !== "undefined"
    && __nimbusDeferProcessExitReport
  ) return;
  __nimbusProcessExitReported = true;
  if (__supervisor && typeof __supervisor.reportExit === "function") {
    try {
      const task = __nimbusUseRpcResult(__supervisor.reportExit(code, reason || ""), () => undefined);
      if (Array.isArray(__pendingIO) && task && typeof task.catch === "function") {
        __pendingIO.push(task.catch(() => {}));
      }
    } catch {}
  }
}

function __nimbusSignalSelf(signal) {
  const sig = String(signal || "SIGTERM");
  const handled = __processEvents.emit(sig);
  if (!handled && (sig === "SIGINT" || sig === "SIGTERM" || sig === "SIGKILL")) {
    const code = sig === "SIGINT" ? 130 : sig === "SIGKILL" ? 137 : 143;
    __nimbusReportProcessExit(code, sig);
    throw new __ProcessExit(code);
  }
  return true;
}

const __processEvents = new __eventsMod();
// Node's process.emitWarning and the 'warning' listener it installs unless
// told not to (lib/internal/process/warning.js, lib/internal/process/
// pre_execution.js setupWarningHandler, v22.22.3): the warning is an Error
// named for its type, emitted on the next tick; the listener prints
// "(node:<pid>) <Type>: <message>" to stderr, the first time with how to
// trace it. --disable-warning and --redirect-warnings are not read.
let __nimbusTraceWarningHelperShown = false;
function __nimbusOnWarning(warning) {
  if (!(warning instanceof Error)) return;
  const isDeprecation = warning.name === "DeprecationWarning";
  if (isDeprecation && __processMod.noDeprecation) return;
  const trace = __processMod.traceProcessWarnings || (isDeprecation && __processMod.traceDeprecation);
  let msg = "(node:" + __processMod.pid + ") ";
  if (warning.code) msg += "[" + warning.code + "] ";
  if (trace && warning.stack) msg += warning.stack;
  else msg += typeof warning.toString === "function" ? String(warning.toString()) : Error.prototype.toString.call(warning);
  if (typeof warning.detail === "string") msg += "\n" + warning.detail;
  if (!trace && !__nimbusTraceWarningHelperShown) {
    const flag = isDeprecation ? "--trace-deprecation" : "--trace-warnings";
    const argv0 = __pathMod.basename(__processMod.argv0 || "node", ".exe");
    msg += "\n(Use `" + argv0 + " " + flag + " ...` to show where the warning was created)";
    __nimbusTraceWarningHelperShown = true;
  }
  __consoleMod.error(msg);
}
function __nimbusProcessEmitWarning(warning, type, code, ctor) {
  if (__processMod.noDeprecation && type === "DeprecationWarning") return;
  let detail;
  if (type !== null && typeof type === "object" && !Array.isArray(type)) {
    ctor = type.ctor;
    code = type.code;
    if (typeof type.detail === "string") detail = type.detail;
    type = type.type || "Warning";
  } else if (typeof type === "function") {
    ctor = type;
    code = undefined;
    type = "Warning";
  }
  const invalid = (name, expected, value) => Object.assign(
    new TypeError("The \"" + name + "\" argument must be " + expected + "." + __nimbusReceived(value)), { code: "ERR_INVALID_ARG_TYPE" });
  if (type !== undefined && typeof type !== "string") throw invalid("type", "of type string", type);
  if (typeof code === "function") {
    ctor = code;
    code = undefined;
  } else if (code !== undefined && typeof code !== "string") {
    throw invalid("code", "of type string", code);
  }
  if (typeof warning === "string") {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    warning = new Error(warning);
    Error.stackTraceLimit = limit;
    warning.name = String(type || "Warning");
    if (code !== undefined) warning.code = code;
    if (detail !== undefined) warning.detail = detail;
    Error.captureStackTrace(warning, ctor || __processMod.emitWarning);
  } else if (!(warning instanceof Error)) {
    throw invalid("warning", "of type string or an instance of Error", warning);
  }
  if (warning.name === "DeprecationWarning") {
    if (__processMod.noDeprecation) return;
    if (__processMod.throwDeprecation) return __processMod.nextTick(() => { throw warning; });
  }
  __processMod.nextTick(() => __processEvents.emit("warning", warning));
}
let __processUmask = Number(cred.umask) & 0o777;
const __processMod = {
  argv: ["node", ...(argv || [])],
  env: env || {},
  cwd: () => cwd || "/home/user",
  chdir: (d) => { cwd = __pathMod.resolve(cwd || "/home/user", d); },
  exit: (code) => {
    exitCode = code ?? 0;
    __nimbusEmitExit(exitCode);
    __nimbusReportProcessExit(exitCode, "");
    throw new __ProcessExit(exitCode);
  },
  platform: "linux", arch: "x64",
  version: "v22.19.0", versions: {"node":"22.19.0","v8":"12.4.254.21","modules":"127"},
  features: Object.freeze({
    inspector: false,
    debug: false,
    uv: false,
    ipv6: true,
    tls_alpn: true,
    tls_sni: true,
    tls_ocsp: false,
    tls: true,
    openssl_is_boringssl: true,
  }),
  getBuiltinModule: (specifier) => {
    const key = String(specifier).replace(/^node:/, "");
    return Object.prototype.hasOwnProperty.call(builtins, key) ? builtins[key] : undefined;
  },
  execPath: "/usr/local/bin/node",
  execArgv: [],
  // The pid belongs to the supervisor, not to the host isolate. A constant 1
  // made every new Vinext process claim its predecessor's stale lock.
  get pid() { return typeof __nimbusProcessId === "number" ? __nimbusProcessId : Number(env?.NIMBUS_CP_CHILD_PID || 1); },
  ppid: 0, title: "node",
  stdout: __makeProcessOutputStream("stdout"),
  stderr: __makeProcessOutputStream("stderr"),
  stdin: __makeProcessStdin(),
  hrtime: Object.assign(
    (prev) => { const n = Date.now(); const s = Math.floor(n / 1000); const ns = (n % 1000) * 1e6; if (!prev) return [s, ns]; return [s - prev[0], ns - prev[1]]; },
    { bigint: () => BigInt(Date.now()) * 1000000n }
  ),
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  emitWarning: __nimbusProcessEmitWarning,
  on: (name, listener) => { __processEvents.on(name, listener); return __processMod; },
  addListener: (name, listener) => { __processEvents.on(name, listener); return __processMod; },
  prependListener: (name, listener) => { __processEvents.prependListener(name, listener); return __processMod; },
  once: (name, listener) => { __processEvents.once(name, listener); return __processMod; },
  off: (name, listener) => { __processEvents.removeListener(name, listener); return __processMod; },
  removeListener: (name, listener) => { __processEvents.removeListener(name, listener); return __processMod; },
  removeAllListeners: (name) => { __processEvents.removeAllListeners(name); return __processMod; },
  emit: (name, ...args) => __processEvents.emit(name, ...args),
  listeners: (name) => __processEvents.listeners(name),
  rawListeners: (name) => __processEvents.rawListeners(name),
  listenerCount: (name) => __processEvents.listenerCount(name),
  eventNames: () => __processEvents.eventNames(),
  setMaxListeners: (n) => { __processEvents.setMaxListeners(n); return __processMod; },
  getMaxListeners: () => __processEvents.getMaxListeners(),
  uptime: () => 0,
  kill: (pid, signal) => {
    const n = Number(pid);
    if (n === __processMod.pid || n === 0) {
      if (signal === 0) return true; // existence probe, never deliver SIGTERM
      return __nimbusSignalSelf(signal === undefined ? "SIGTERM" : signal);
    }
    // This process's own children are signalled through their handle, as
    // tree-kill and similar helpers expect of process.kill(childPid).
    const child = __cpChildren.get(n);
    if (child !== undefined && !child._exitFired) {
      if (signal === 0) return true;
      child.kill(signal === undefined ? "SIGTERM" : signal);
      return true;
    }
    if (child !== undefined || __cpExitedPids.has(n)) {
      const gone = new Error("kill ESRCH");
      gone.code = "ESRCH";
      gone.errno = -3;
      gone.syscall = "kill";
      throw gone;
    }
    // Node's process.kill throws on failure; returning false falsely told
    // Vinext/Astro lockfile probes that every stale pid was still alive.
    // There is no synchronous cross-isolate process table or signal syscall.
    // Do not invent ESRCH for a pid we cannot inspect: report ENOSYS honestly.
    const error = new Error("kill: synchronous cross-isolate process signalling is unavailable; use the owning child-process handle");
    error.code = "ENOSYS";
    error.syscall = "kill";
    throw error;
  },
  getuid: () => Number(cred.uid),
  geteuid: () => Number(cred.uid),
  getgid: () => Number(cred.gid),
  getegid: () => Number(cred.gid),
  getgroups: () => Array.from(cred.groups, Number),
  umask: (mask) => {
    const previous = __processUmask;
    if (mask === undefined) return previous;
    const next = typeof mask === "string" ? parseInt(mask, 8) : Number(mask);
    if (!Number.isInteger(next) || next < 0 || next > 0o777) {
      const error = new TypeError("The value of mask is out of range");
      error.code = "ERR_INVALID_ARG_VALUE";
      throw error;
    }
    __processUmask = next;
    if (__supervisor && typeof __supervisor.setUmask === "function") {
      const task = __nimbusUseRpcResult(__supervisor.setUmask(next), () => undefined);
      if (Array.isArray(__pendingIO)) __pendingIO.push(task);
    }
    return previous;
  },
  // process.binding is a deprecated internal API some bundled legacy
  // packages still read at module init (e.g. minipass, bundled by degit
  // → create-cloudflare, does process.binding('fs') for FS constants).
  // Surface the constants those callers need; reject unknown bindings
  // with the same shape Node uses so anything else fails loudly.
  binding: (name) => {
    if (name === "fs") return { constants: __constantsMod };
    if (name === "constants") {
      return { fs: __constantsMod, os: { errno: __constantsMod, signals: __constantsMod }, crypto: {} };
    }
    const err = new Error("No such module: " + name);
    err.code = "ERR_UNKNOWN_BUILTIN_MODULE";
    throw err;
  },
};
// The 'warning' listener Node installs (setupWarningHandler), unless warnings are off.
if (__processMod.env.NODE_NO_WARNINGS !== "1" && !String(__processMod.env.NODE_OPTIONS || "").split(/\s+/).includes("--no-warnings")) {
  __processEvents.on("warning", __nimbusOnWarning);
}
// Node's process reads as one: Object.prototype.toString gives "[object
// process]", which axios (utils.kindOf) and others test to pick their Node
// paths (axios: its http adapter rather than its fetch one). As Node defines
// it: an own property, writable, not enumerable, not configurable.
Object.defineProperty(__processMod, Symbol.toStringTag, { value: "process", writable: true, enumerable: false, configurable: false });

function __nimbusRuntimeErrorTrace(error) {
  if (error && typeof error === "object") {
    return error.stack || error.message || String(error);
  }
  return String(error);
}

function __nimbusFailUnhandledAsync(error, kind) {
  if (error instanceof __ProcessExit) {
    __nimbusReportProcessExit(error.code, "");
    return;
  }
  const label = kind === "rejection"
    ? "Unhandled promise rejection: "
    : "Uncaught exception: ";
  const line = label + __nimbusRuntimeErrorTrace(error) + "\n";
  stderr += line;
  if (__supervisor && typeof __supervisor.stderr === "function") {
    try { __nimbusUseRpcResult(__supervisor.stderr(__nimbusOutEnc.encode(line)), () => undefined).catch(() => {}); } catch {}
  }
  __nimbusReportProcessExit(1, line);
}

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("unhandledrejection", (event) => {
    const reason = event && typeof event === "object" && "reason" in event ? event.reason : event;
    const promise = event && typeof event === "object" && "promise" in event ? event.promise : undefined;
    let handled = false;
    try { handled = __processEvents.emit("unhandledRejection", reason, promise); } catch {}
    if (!handled) __nimbusFailUnhandledAsync(reason, "rejection");
    try { event.preventDefault?.(); } catch {}
  });
  globalThis.addEventListener("error", (event) => {
    __nimbusUncaughtException(event && typeof event === "object" && "error" in event ? event.error : event);
    try { event.preventDefault?.(); } catch {}
  });
}

// An exception no code caught: the process's 'uncaughtException' listeners
// have it, or it ends the program.
function __nimbusUncaughtException(error) {
  let handled = false;
  try { handled = __processEvents.emit("uncaughtException", error); } catch {}
  if (!handled) __nimbusFailUnhandledAsync(error, "exception");
}

// ═══════════════════════════════════════════════════════════════════════
// ──  Builtins initialization (MUST come before require) ─────────────
// ═══════════════════════════════════════════════════════════════════════
const builtins = {};
builtins.fs = __fsMod;
builtins.path = __pathMod;
builtins.os = __osMod;
// framework-fixes-F1 (2026-05-12): 'node:constants' (legacy 'constants').
// Pre-fix require('node:constants') threw "Cannot find module" because
// the table didn't include it. create-next-app touches
// constants.UV_FS_O_FILEMAP at module init; that crash blocked the entire
// scaffold flow. See __constantsMod definition above for the full shape.
builtins.constants = __constantsMod;
// Also register under the 'node:'-prefixed key. __requireFrom (this
// file ~line 2900) has a fast-path strip but the explicit registration
// matches the dns/promises + util/types convention.
builtins["node:constants"] = __constantsMod;
builtins.events = __eventsMod;
builtins.stream = __streamMod;
// X.5-R: real Node's `require('stream')` re-exports EventEmitter
// (verified: `require('stream').EventEmitter === require('events').EventEmitter`
// in Node 20). Older CJS code reads EE off the stream module instead of
// events — e.g., @redis/client/dist/lib/client/cache.js:301:
// `class ClientSideCacheProvider extends stream_1.EventEmitter {}` where
// `stream_1 = require("stream")`. Without this re-export, `stream_1.EventEmitter`
// is undefined and `class … extends undefined` throws "Class extends value
// Idempotent guard so a future streams.ts revision that already exposes
// EventEmitter doesn't get clobbered.
if (!__streamMod.EventEmitter) __streamMod.EventEmitter = __eventsMod;
builtins.buffer = __bufferModule;
builtins.util = __utilMod;
builtins.url = __urlMod;
builtins.crypto = __cryptoMod;
builtins.assert = __assertMod;
builtins.querystring = __qsMod;
builtins.string_decoder = __stringDecoderMod;
// node:sqlite (sql.js-backed). Dual-registered like node:fs/promises; the
// resolver strips the node: prefix but the explicit key matches the
// constants/util-types convention. The engine boots lazily and
// synchronously on the first DatabaseSync open (sqlite-shim.ts __getSQL) —
// the ~48 MiB boot must not be paid by processes that never open a DB.
builtins.sqlite = __sqliteMod;
builtins["node:sqlite"] = __sqliteMod;
builtins.child_process = __childProcessMod;
builtins.process = __processMod;
builtins.console = __consoleMod;

const __nativeHttpResponse = globalThis.Response;
const __nativeHttpRequest = globalThis.Request;
const __nativeSplitHeaderFields = new Set(["host", "content-type", "user-agent", "referer", "authorization",
  "proxy-authorization", "if-modified-since", "if-unmodified-since", "from", "location", "max-forwards"]);
Object.defineProperty(builtins, "http", {
  configurable: true, enumerable: true,
  get() {
    const http = typeof __real_http !== "undefined"
      ? (__real_http.default ?? __real_http) : globalThis.process.getBuiltinModule("http");
    const net = typeof __real_net !== "undefined"
      ? (__real_net.default ?? __real_net) : globalThis.process.getBuiltinModule("net");
    const ports = globalThis.__portRegistry ??= new Map();
    const pendingListeners = globalThis.__nimbusPendingHttpListeners ??= new Set();
    const context = { ports, get supervisor() { return __supervisor; }, get pending() { return __pendingIO; } };
    // Native clients keep consuming their IncomingMessage after fetch has
    // returned headers. Their close event is the end of the exchange (EOF,
    // body error or cancellation), not the request-body finish event.
    // https.get/request use this same ClientRequest class; prototype hooks
    // cover named ESM imports and direct construction too. No response/error
    // listeners are installed, preserving native auto-drain and error rules.
    // workerd src/node/internal/internal_http_client.ts #handleFetchResponse
    // and #emitClose, v1.20260926.1.
    const clientProto = http.ClientRequest.prototype;
    const clientPatch = Symbol.for("nimbus.native-http.client-lifetime");
    if (!clientProto[clientPatch]) {
      const inFlight = new WeakSet();
      const end = clientProto.end, emit = clientProto.emit;
      const release = request => {
        if (inFlight.delete(request)) { globalThis.__nimbusPendingOps--; globalThis.__nimbusHandleReleased?.(); }
      };
      Object.defineProperty(clientProto, clientPatch, { value: true });
      clientProto.end = function () {
        const started = !this.destroyed && !inFlight.has(this);
        // A request is something a second run would send again
        // (runtime/stop-replay.ts): counted before it leaves.
        // `__nimbusReplay` is the shims' own; this source also runs without them.
        // A read is recorded by the session when the run's network goes through
        // it (fetch carries it there); anything else is counted.
        if (started && typeof __nimbusReplay !== "undefined" && __nimbusReplay
          && (!__nimbusReplay.outbound || !/^(GET|HEAD)$/i.test(String(this.method || "GET")))) {
          __nimbusReplay.effect("http " + String(this.method || "GET") + " " + String(this.host || "") + String(this.path || ""));
        }
        if (started) {
          inFlight.add(this);
          globalThis.__nimbusPendingOps = (globalThis.__nimbusPendingOps || 0) + 1;
        }
        try { return Reflect.apply(end, this, arguments); }
        catch (error) { if (started) release(this); throw error; }
      };
      clientProto.emit = function (event) {
        if (event === "close" && this.destroyed) release(this);
        return Reflect.apply(emit, this, arguments);
      };
    }
    const patchKey = Symbol.for("nimbus.native-http.patch");
    if (!http.Server.prototype[patchKey]) {
      const proto = http.Server.prototype;
      // workerd v1.20260926.1 _storeHeader calls headers.hasOwnProperty:
      // https://github.com/cloudflare/workerd/blob/v1.20260926.1/src/node/internal/internal_http_outgoing.ts
      // Node also accepts null-prototype dictionaries (effect-platform uses
      // them). Use the native progressive header API, without copying or
      // mutating the caller map.
      const responseProto = http.ServerResponse.prototype;
      const responsePatch = Symbol.for("nimbus.native-http.response-headers");
      if (!responseProto[responsePatch]) {
        const writeHead = responseProto.writeHead;
        Object.defineProperty(responseProto, responsePatch, { value: true });
        responseProto.writeHead = function (status, reason, headers) {
          const fields = typeof reason === "object" && reason !== null ? reason : headers;
          if (fields && !Array.isArray(fields) && (Object.getPrototypeOf(fields) !== Object.prototype || Object.hasOwn(fields, "hasOwnProperty"))) {
            for (const name in fields) if (Object.hasOwn(fields, name)) this.setHeader(name, fields[name]);
            return Reflect.apply(writeHead, this, typeof reason === "string" ? [status, reason] : [status]);
          }
          return Reflect.apply(writeHead, this, arguments);
        };
      }
      const listen = proto.listen, close = proto.close, ref = proto.ref, unref = proto.unref, emit = proto.emit;
      // An HTTP exchange keeps its process alive until it completes, as its
      // connection does in Node, whether or not the server is still listening
      // (a bound port is counted on its own): from 'request' until the response
      // closes, finished or destroyed (the client went away, the header
      // deadline passed). The response alone decides, as Node ties the
      // exchange to it: a request body the handler never reads never ends
      // here (workerd does not dump one), so it must not hold the process.
      // One of the held connections __nimbusLiveHandles counts, never startup
      // work: a response still streaming at boot (SSE, an HMR poll) does not
      // hold a resident's boot answer.
      const holdExchange = (response) => {
        if (typeof response.once !== "function") return;
        response.once("close", () => {
          globalThis.__nimbusOpenSockets--;
          globalThis.__nimbusHandleReleased?.();
        });
        globalThis.__nimbusOpenSockets = (globalThis.__nimbusOpenSockets || 0) + 1;
      };
      proto.emit = function (event, incoming, response) {
        if (event === "request" && incoming && response) holdExchange(response);
        return Reflect.apply(emit, this, arguments);
      };
      // Keep RPC capabilities inside this closure, not on globals or server
      // properties visible to guest code. The setter refreshes the context
      // when an isolate is reused, without revealing its current value.
      let activeContext = context;
      const owners = new WeakMap();
      Object.defineProperty(proto, patchKey, { value: next => { activeContext = next; } });
      proto.listen = function (...args) {
        const ctx = activeContext;
        const [options, callback] = net._normalizeArgs(args);
        if (this.listening || owners.get(this)?.pending) {
          const err = new Error("Listen method has been called more than once without closing.");
          err.code = "ERR_SERVER_ALREADY_LISTEN";
          throw err;
        }
        const state = { ctx, pending: false, cancelled: false, port: null };
        owners.set(this, state);
        const requested = options.port === undefined ? 0 : Number(options.port);
        const allocationSettled = () => {
          state.pending = false;
          // A cancelled allocation can settle after this server relistens.
          // Only the current owner can retire its pending-listen handle.
          if (owners.get(this) === state && pendingListeners.delete(this)) globalThis.__nimbusHandleReleased?.();
        };
        const releaseAllocation = () => {
          // An explicit relisten may have taken this same number while the
          // cancelled allocation reply was in flight. That live binding now
          // owns the reservation; retiring the old request must not remove it.
          if (state.port !== null && !ctx.ports.has(state.port)) {
            ctx.pending.push(Promise.resolve(ctx.supervisor.unregisterPort(state.port)));
          }
        };
        const start = (port) => {
          allocationSettled();
          if (state.cancelled) {
            releaseAllocation();
            return;
          }
          try {
            // Native listen validates the arguments and binds the native port.
            // An EADDRINUSE from workerd is synchronous; Node emits it instead.
            Reflect.apply(listen, this, [{ ...options, port }, ...(callback ? [callback] : [])]);
            state.port = Number(this.address()?.port ?? port);
            ctx.ports.set(state.port, this);
            ctx.pending.push(Promise.resolve(ctx.supervisor.registerPort(state.port)));
          } catch (e) {
            if (requested === 0) releaseAllocation();
            if (e && e.code === "EADDRINUSE") { queueMicrotask(() => this.emit("error", e)); return; }
            throw e;
          }
        };
        if (requested === 0) {
          state.pending = true;
          pendingListeners.add(this);
          let allocation;
          try { allocation = ctx.supervisor.allocatePort(); }
          catch (error) { allocationSettled(); throw error; }
          const task = Promise.resolve(allocation).then(port => {
            state.port = port;
            start(port);
          }, error => { allocationSettled(); if (!state.cancelled) this.emit("error", error); });
          ctx.pending.push(task);
        } else start(options.port);
        return this;
      };
      proto.close = function (callback) {
        const state = owners.get(this);
        if (state) {
          state.cancelled = true;
          if (state.pending) {
            state.pending = false;
            owners.delete(this);
            pendingListeners.delete(this);
            globalThis.__nimbusHandleReleased?.();
            if (callback) this.once("close", callback);
            queueMicrotask(() => this.emit("close"));
            return this;
          }
          if (state.port !== null && state.ctx.ports.get(state.port) === this) {
            state.ctx.ports.delete(state.port);
            state.ctx.pending.push(Promise.resolve(state.ctx.supervisor.unregisterPort(state.port)));
            globalThis.__nimbusHandleReleased?.();
          }
        }
        return Reflect.apply(close, this, callback ? [callback] : []);
      };
      proto.ref = function () { this.__nimbusUnrefed = false; return Reflect.apply(ref, this, []); };
      proto.unref = function () {
        this.__nimbusUnrefed = true;
        globalThis.__nimbusHandleReleased?.();
        return Reflect.apply(unref, this, []);
      };
    } else http.Server.prototype[patchKey](context);
    globalThis.__nimbusServeHttp = async (request) => {
      const port = Number(request.headers.get("X-Nimbus-Port") || 0);
      const server = port ? ports.get(port) : ports.values().next().value;
      if (!server) return new __nativeHttpResponse("Nimbus: no HTTP server is listening in this process", { status: 502 });
      let acquired;
      try { acquired = JSON.parse(request.headers.get("X-Nimbus-Vfs-Acquired") || "null"); } catch {}
      await __nimbusInboundBarrier(acquired);
      const headers = new Headers(request.headers);
      headers.delete("X-Nimbus-Vfs-Acquired");
      const controller = new AbortController();
      const inbound = new __nativeHttpRequest(request, { headers, signal: AbortSignal.any([request.signal, controller.signal]) });
      let detach = () => {};
      let timer;
      let nativeResponse;
      const captureResponse = (incoming, response) => {
        nativeResponse = response;
        // workerd's #toReqRes keeps only the text before the first unquoted
        // comma of these fields (splitHeaderValue, meant to pick the first of
        // fetch-joined duplicates), so a guest saw "If-Modified-Since: Tue"
        // and "(KHTML" of a Chrome User-Agent. The edge has already joined any
        // duplicates here, so the full value is Node's value.
        // workerd v1.20260926.1 src/node/internal/internal_http_server.ts
        // multipleForbiddenHeaders and #toReqRes.
        const raw = incoming.rawHeaders;
        for (let i = 0; i + 1 < raw.length; i += 2) {
          const name = String(raw[i]).toLowerCase();
          if (!__nativeSplitHeaderFields.has(name)) continue;
          const full = inbound.headers.get(name);
          if (full === null || full === raw[i + 1]) continue;
          raw[i + 1] = full;
          incoming.headers[name] = full;
        }
      };
      const dispatch = async () => {
        // effect-platform binds first and attaches its request handler later.
        // Do not let the native server silently drop that first request.
        if (server.listenerCount("request") === 0) {
          const ready = Promise.withResolvers();
          const added = (event) => { if (event === "request") queueMicrotask(ready.resolve); };
          const closed = () => ready.resolve();
          detach = () => { server.removeListener("newListener", added); server.removeListener("close", closed); };
          server.on("newListener", added);
          server.once("close", closed);
          await ready.promise;
          detach();
        }
        if (!server.listening) return new __nativeHttpResponse("Nimbus: HTTP server closed", { status: 502 });
        // workerd emits request synchronously inside handleAsNodeRequest
        // (internal_http_server.ts #onRequest), before its response promise.
        server.prependOnceListener("request", captureResponse);
        return __nimbusHandleAsNodeRequest(Number(server.address().port), inbound);
      };
      const deadline = Promise.withResolvers();
      timer = setTimeout(() => {
        deadline.resolve(new __nativeHttpResponse("Nimbus: HTTP handler sent no response headers in time", { status: 504 }));
        detach();
        nativeResponse?.destroy();
        controller.abort();
      }, Number(globalThis.__nimbusHttpHeaderTimeoutMs) || 30000);
      try {
        return await Promise.race([dispatch(), deadline.promise]);
      } finally { clearTimeout(timer); detach(); server.removeListener("request", captureResponse); }
    };
    Object.defineProperty(builtins, "http", { value: http, writable: true, enumerable: true, configurable: true });
    return http;
  },
});
Object.defineProperty(builtins, "https", {
  configurable: true, enumerable: true,
  get() {
    // Install the shared HTTP Server prototype bridge before native HTTPS is
    // used; workerd's HTTPS server is the HTTP server (TLS ends at ingress).
    void builtins.http;
    const https = typeof __real_https !== "undefined"
      ? (__real_https.default ?? __real_https) : globalThis.process.getBuiltinModule("https");
    Object.defineProperty(builtins, "https", { value: https, writable: true, enumerable: true, configurable: true });
    return https;
  },
});


// ═══════════════════════════════════════════════════════════════════════
// ──  WebSocket upgrades over http(s).request (runtime/node-ws-upgrade.ts)
// ═══════════════════════════════════════════════════════════════════════
(() => {
  const patched = Symbol.for("nimbus.websocket-upgrade");
  /** RFC 6455 section 1.3: what the server appends to the client's key. */
  const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };
  /** UTF-8, validated: text that is not fails the connection (RFC 6455 section 8.1). */
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  /** Node's AbortError, for a request its signal aborted. */
  const abortError = (reason) => Object.assign(new Error("The operation was aborted", { cause: reason }), { name: "AbortError", code: "ABORT_ERR" });

  /** A request's headers as Node takes them (an object, or the flat raw array), as [name, value] pairs. */
  function headerPairs(headers) {
    const pairs = [];
    if (!headers) return pairs;
    if (Array.isArray(headers)) {
      for (let i = 0; i + 1 < headers.length; i += 2) pairs.push([String(headers[i]), String(headers[i + 1])]);
      return pairs;
    }
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      for (const one of Array.isArray(value) ? value : [value]) pairs.push([name, String(one)]);
    }
    return pairs;
  }

  /** http.request's arguments, (url[, options][, callback]) or (options[, callback]), as options and a callback. */
  function requestArgs(args) {
    let [input, options, callback] = args;
    if (typeof input === "string" || input instanceof URL) {
      const url = new URL(String(input));
      if (typeof options === "function") { callback = options; options = undefined; }
      const fromUrl = {
        protocol: url.protocol,
        hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        auth: url.username ? decodeURIComponent(url.username) + ":" + decodeURIComponent(url.password) : undefined,
      };
      return { options: { ...fromUrl, ...(options || {}) }, callback };
    }
    return { options: { ...(input || {}) }, callback: typeof options === "function" ? options : callback };
  }

  function isWebSocketUpgrade(options) {
    return headerPairs(options.headers).some(([name, value]) =>
      name.toLowerCase() === "upgrade" && value.trim().toLowerCase() === "websocket");
  }

  /** A response, as Node's http client hands one over: its body already here, or none. */
  class IncomingMessage extends __streamMod.Readable {
    _read() {}
  }

  /** A response head as Node's IncomingMessage has it: headers by lowercased name (set-cookie a list), and raw. Its body is pushed by the caller. */
  function incoming(status, statusText, pairs) {
    const res = new IncomingMessage();
    res.statusCode = status;
    res.statusMessage = statusText;
    res.httpVersion = "1.1";
    res.httpVersionMajor = 1;
    res.httpVersionMinor = 1;
    res.headers = {};
    res.rawHeaders = [];
    for (const [name, value] of pairs) {
      const key = name.toLowerCase();
      res.rawHeaders.push(name, value);
      if (key === "set-cookie") (res.headers[key] ||= []).push(value);
      else res.headers[key] = res.headers[key] === undefined ? value : res.headers[key] + ", " + value;
    }
    res.trailers = {};
    res.rawTrailers = [];
    res.complete = false;
    return res;
  }

  /** One unmasked frame, as a server writes it (RFC 6455 section 5.2). */
  function frame(opcode, payload) {
    const length = payload.length;
    const head = length < 126 ? 2 : length < 65536 ? 4 : 10;
    const out = Buffer.alloc(head + length);
    out[0] = 0x80 | opcode;
    if (length < 126) {
      out[1] = length;
    } else if (length < 65536) {
      out[1] = 126;
      out.writeUInt16BE(length, 2);
    } else {
      out[1] = 127;
      out.writeUInt32BE(Math.floor(length / 0x100000000), 2);
      out.writeUInt32BE(length >>> 0, 6);
    }
    payload.copy(out, head);
    return out;
  }

  /** A close frame's payload: its code and reason, or nothing (1005: no status was given). */
  function closePayload(code, reason) {
    if (code === undefined || code === 1005) return Buffer.alloc(0);
    const text = Buffer.from(String(reason || ""), "utf8");
    const out = Buffer.alloc(2 + text.length);
    out.writeUInt16BE(code, 0);
    text.copy(out, 2);
    return out;
  }

  /** A frame the client should not have sent: the connection fails with `closeCode` (1002, or 1007 for text that is not UTF-8). */
  function protocolError(message, closeCode = 1002) {
    return Object.assign(new Error("Nimbus: WebSocket protocol error from the client: " + message), { code: "ERR_NIMBUS_WEBSOCKET_PROTOCOL", closeCode });
  }

  /** `bytes` as UTF-8 text, or the connection fails with 1007. */
  function text(bytes) {
    try { return utf8.decode(bytes); }
    catch { throw protocolError("text that is not UTF-8", 1007); }
  }

  /** ws's isValidStatusCode: a close code a peer may send. */
  const sendableCloseCode = (code) => (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);

  /**
   * The upgraded connection, as the client holds it: a Duplex whose writes
   * are the client's frames and whose reads are the server's, over the
   * relayed socket.
   */
  class WebSocketBridge extends __streamMod.Duplex {
    constructor(relay) {
      super();
      this._relay = relay;
      this._pending = Buffer.alloc(0);
      this._fragments = null;
      /** The close payload the client sent, echoed when the relay's close follows it. */
      this._clientClose = null;
      this._ended = false;
      /** The connection failed: nothing more the client writes is read. */
      this._failed = false;
      this.remoteAddress = undefined;
      relay.addEventListener("message", (event) => {
        const data = event.data;
        this._deliver(typeof data === "string"
          ? frame(OPCODE.text, Buffer.from(data, "utf8"))
          : frame(OPCODE.binary, Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)));
      });
      relay.addEventListener("close", (event) => {
        if (this._ended) return;
        // No close frame: the connection was lost (1006), as a socket that drops.
        if (event.code === 1006 && this._clientClose === null) {
          this._ended = true;
          this.push(null);
          this.destroy();
          return;
        }
        this._deliver(frame(OPCODE.close, this._clientClose ?? closePayload(event.code, event.reason)));
        this._ended = true;
        this.push(null);
      });
    }

    _deliver(bytes) {
      if (!this._ended) this.push(bytes);
    }

    _read() {}

    _write(chunk, encoding, callback) {
      if (this._failed) {
        callback();
        return;
      }
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
      this._pending = this._pending.length > 0 ? Buffer.concat([this._pending, bytes]) : bytes;
      try {
        this._parse();
      } catch (error) {
        if (!(error && typeof error.closeCode === "number")) {
          callback(error);
          return;
        }
        this._fail(error.closeCode);
      }
      callback();
    }

    /** Fail the connection as a server does: a close frame with `code`, the client's stream ended, the relayed socket closed. */
    _fail(code) {
      this._failed = true;
      this._pending = Buffer.alloc(0);
      if (this._ended) return;
      this._deliver(frame(OPCODE.close, closePayload(code, "")));
      this._ended = true;
      this.push(null);
      if (this._relay.readyState < 2) this._relay.close(code);
    }

    _final(callback) {
      // The client ended its side: the connection is over once the server's is.
      if (!this._ended) {
        this._ended = true;
        this.push(null);
        if (this._relay.readyState < 2) this._relay.close(1000);
      }
      callback();
    }

    destroy(error) {
      if (this._relay.readyState < 2) this._relay.close(1001, "the client's socket was destroyed");
      return super.destroy(error);
    }

    _parse() {
      for (;;) {
        const pending = this._pending;
        if (pending.length < 2) return;
        const first = pending[0], second = pending[1];
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          length = pending.readUInt32BE(2) * 0x100000000 + pending.readUInt32BE(6);
          offset = 10;
        }
        const masked = (second & 0x80) !== 0;
        const maskAt = offset;
        if (masked) offset += 4;
        if (pending.length < offset + length) return;
        const payload = Buffer.from(pending.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= pending[maskAt + (i & 3)];
        this._pending = pending.subarray(offset + length);
        if ((first & 0x70) !== 0) throw protocolError("reserved bits set, and no extension was negotiated");
        if (!masked) throw protocolError("an unmasked frame (RFC 6455 section 5.1)");
        this._frame((first & 0x80) !== 0, first & 0x0f, payload);
      }
    }

    _frame(fin, opcode, payload) {
      switch (opcode) {
        case OPCODE.continuation:
          if (this._fragments === null) throw protocolError("a continuation frame with no message to continue");
          this._fragments.parts.push(payload);
          if (fin) {
            const { type, parts } = this._fragments;
            this._fragments = null;
            this._send(type, Buffer.concat(parts));
          }
          return;
        case OPCODE.text:
        case OPCODE.binary:
          if (this._fragments !== null) throw protocolError("a new message inside a fragmented one");
          if (fin) this._send(opcode, payload);
          else this._fragments = { type: opcode, parts: [payload] };
          return;
        case OPCODE.close: {
          if (payload.length === 1) throw protocolError("a close frame of one byte");
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
          if (code !== undefined && !sendableCloseCode(code)) throw protocolError("close code " + code);
          const reason = payload.length > 2 ? text(payload.subarray(2)) : "";
          this._clientClose = payload;
          if (this._relay.readyState < 2) {
            if (code === undefined) this._relay.close();
            else this._relay.close(code, reason);
          }
          return;
        }
        case OPCODE.ping:
          this._deliver(frame(OPCODE.pong, payload));
          return;
        case OPCODE.pong:
          return;
        default:
          throw protocolError("opcode " + opcode);
      }
    }

    _send(opcode, payload) {
      const message = opcode === OPCODE.text ? text(payload) : new Uint8Array(payload);
      if (this._relay.readyState === 1) this._relay.send(message);
    }

    // net.Socket's tuning, which a relayed socket has no use for.
    setTimeout(ms, callback) { if (callback) this.once("timeout", callback); return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { return this; }
    unref() { return this; }
  }

  /** A ClientRequest carrying `Upgrade: websocket`: answered over a relayed socket. */
  class UpgradeRequest extends __eventsMod {
    constructor(options, secure, callback) {
      super();
      this.method = String(options.method || "GET").toUpperCase();
      this.path = options.path || "/";
      this.host = options.hostname || options.host || "localhost";
      this.protocol = secure ? "https:" : "http:";
      this.aborted = false;
      this.destroyed = false;
      this.finished = false;
      this.reusedSocket = false;
      this.socket = null;
      this._secure = secure;
      this._port = options.port ? Number(options.port) : (options.defaultPort ? Number(options.defaultPort) : undefined);
      this._headers = new Map();
      for (const [name, value] of headerPairs(options.headers)) {
        const entry = this._headers.get(name.toLowerCase());
        if (entry) entry.values.push(value);
        else this._headers.set(name.toLowerCase(), { name, values: [value] });
      }
      if (options.auth && !this._headers.has("authorization")) {
        this.setHeader("Authorization", "Basic " + Buffer.from(String(options.auth)).toString("base64"));
      }
      this._timeoutMs = options.timeout;
      this._relay = null;
      this._refusal = null;
      this._response = null;
      this._closed = false;
      if (callback) this.once("response", callback);
      // Node's addAbortSignal: aborted already, the request fails on the next turn; else when it aborts, until the request closes.
      this._signal = options.signal;
      this._onAbort = () => this.destroy(abortError(this._signal.reason));
      if (this._signal) {
        if (this._signal.aborted) queueMicrotask(this._onAbort);
        else this._signal.addEventListener("abort", this._onAbort, { once: true });
      }
    }

    setHeader(name, value) {
      this._headers.set(String(name).toLowerCase(), { name: String(name), values: (Array.isArray(value) ? value : [value]).map(String) });
      return this;
    }
    getHeader(name) {
      const entry = this._headers.get(String(name).toLowerCase());
      if (!entry) return undefined;
      return entry.values.length === 1 ? entry.values[0] : entry.values;
    }
    hasHeader(name) { return this._headers.has(String(name).toLowerCase()); }
    removeHeader(name) { this._headers.delete(String(name).toLowerCase()); }
    getHeaders() {
      return Object.fromEntries([...this._headers].map(([key, entry]) => [key, entry.values.length === 1 ? entry.values[0] : entry.values]));
    }
    getHeaderNames() { return [...this._headers.keys()]; }
    setTimeout(ms, callback) {
      this._timeoutMs = ms;
      if (callback) this.once("timeout", callback);
      return this;
    }
    setNoDelay() { return this; }
    setSocketKeepAlive() { return this; }
    flushHeaders() {}

    write(chunk, encoding, callback) {
      if (typeof encoding === "function") callback = encoding;
      if (chunk !== undefined && chunk !== null && chunk.length > 0) {
        this.destroy(Object.assign(new Error("Nimbus: a WebSocket upgrade request carries no body"), { code: "ERR_NIMBUS_WEBSOCKET_UPGRADE_BODY" }));
        return false;
      }
      if (callback) queueMicrotask(callback);
      return true;
    }

    end(chunk, encoding, callback) {
      if (typeof chunk === "function") { callback = chunk; chunk = undefined; }
      if (typeof encoding === "function") callback = encoding;
      if (chunk !== undefined && chunk !== null && chunk.length > 0) {
        this.write(chunk);
        return this;
      }
      if (this.finished) return this;
      this.finished = true;
      if (callback) this.once("finish", callback);
      queueMicrotask(() => {
        if (this.destroyed) return;
        this.emit("finish");
        this._open();
      });
      return this;
    }

    abort() {
      if (this.aborted || this.destroyed) return;
      this.aborted = true;
      this._close(undefined, true);
    }

    destroy(error) {
      if (this.destroyed) return this;
      this._close(error, false);
      return this;
    }

    _close(error, aborted) {
      this.destroyed = true;
      clearTimeout(this._timer);
      if (this._relay && this._relay.readyState < 2) this._relay.close(1001, "the request was aborted");
      if (this._refusal) this._refusal.cancel();
      if (this._response && !this._response.readableEnded) this._response.destroy(error);
      queueMicrotask(() => {
        if (aborted) this.emit("abort");
        if (error) this.emit("error", error);
        // Node's request closes when its socket has, a turn later than its error.
        setTimeout(() => this._emitClose(), 0);
      });
    }

    /** 'close', once: the request is over, and its signal no longer reaches it. */
    _emitClose() {
      if (this._closed) return;
      this._closed = true;
      if (this._signal) this._signal.removeEventListener("abort", this._onAbort);
      this.emit("close");
    }

    _open() {
      if (this.destroyed) return;
      const host = this.host.includes(":") ? "[" + this.host + "]" : this.host;
      const port = this._port && this._port !== (this._secure ? 443 : 80) ? ":" + this._port : "";
      const url = (this._secure ? "wss://" : "ws://") + host + port + this.path;
      const key = this.getHeader("sec-websocket-key");
      const offered = this.getHeader("sec-websocket-protocol");
      const protocols = offered === undefined ? []
        : String(offered).split(",").map((one) => one.trim()).filter((one) => one.length > 0);
      const headers = [...this._headers.values()].flatMap(({ name, values }) => values.map((value) => [name, value]));
      let relay;
      try {
        // A refusal's body is wanted: the 'response' a client gets carries it.
        relay = new __NimbusRelayedWebSocket(url, { protocols, headers, [__NIMBUS_WS_REFUSAL_BODY]: true });
      } catch (error) {
        this.destroy(error);
        return;
      }
      this._relay = relay;
      if (this._timeoutMs > 0) this._timer = setTimeout(() => this.emit("timeout"), this._timeoutMs);
      relay.addEventListener("open", () => {
        clearTimeout(this._timer);
        if (this.destroyed) return;
        this._upgraded(relay, key);
      });
      relay.addEventListener("error", (event) => {
        clearTimeout(this._timer);
        if (this.destroyed || this.socket) return;
        const handshake = relay[__NIMBUS_WS_HANDSHAKE];
        if (handshake && handshake.status !== 101) {
          this._refused(handshake);
          return;
        }
        this.destroy(Object.assign(new Error(event.message || "WebSocket connection failed"), { code: "ECONNREFUSED" }));
      });
    }

    _upgraded(relay, key) {
      const handshake = relay[__NIMBUS_WS_HANDSHAKE] || { headers: [] };
      // This hop's handshake, as a server answers the client's: the
      // destination's headers but those of its own hop's handshake.
      const pairs = handshake.headers.filter(([name]) => !/^(sec-websocket-accept|sec-websocket-extensions|sec-websocket-protocol|upgrade|connection)$/i.test(name));
      pairs.unshift(["Upgrade", "websocket"], ["Connection", "Upgrade"]);
      if (key !== undefined) {
        pairs.push(["Sec-WebSocket-Accept", __cryptoMod.createHash("sha1").update(String(key) + ACCEPT_GUID).digest("base64")]);
      }
      if (relay.protocol) pairs.push(["Sec-WebSocket-Protocol", relay.protocol]);
      const res = incoming(101, "Switching Protocols", pairs);
      res.complete = true;
      res.push(null);
      const socket = new WebSocketBridge(relay);
      // The socket is the client's now: closing the request no longer closes it.
      this._relay = null;
      this.socket = socket;
      if (this.listenerCount("upgrade") === 0) {
        // Node closes an upgraded connection nobody took.
        socket.destroy();
      } else {
        this.emit("upgrade", res, socket, Buffer.alloc(0));
      }
      // Node's request closes once it has handed its socket over.
      this.destroyed = true;
      this._emitClose();
    }

    /** The destination's refusal, as Node's client hands a response over: at once, its body as it comes. */
    _refused(handshake) {
      const res = incoming(handshake.status, handshake.statusText || "", handshake.headers || []);
      this._refusal = handshake;
      this._response = res;
      // A body nobody reads any more is not read from the relay either.
      res.once("close", () => handshake.cancel());
      res.once("end", () => queueMicrotask(() => this._emitClose()));
      handshake.read((bytes) => res.push(Buffer.from(bytes)), (complete) => {
        // Complete only as the destination ended it: the relay bounds it by bytes and by time.
        res.complete = complete;
        res.push(null);
      });
      if (this.listenerCount("response") === 0) {
        // Node dumps a response nobody listens for.
        res.resume();
        return;
      }
      this.emit("response", res);
    }
  }

  /** `module`'s request and get, answering a WebSocket upgrade here and anything else as before. */
  function install(module, secure) {
    if (!module || module[patched]) return module;
    const request = module.request;
    const get = module.get;
    module.request = function request_(...args) {
      const { options, callback } = requestArgs(args);
      if (!isWebSocketUpgrade(options)) return Reflect.apply(request, this, args);
      return new UpgradeRequest(options, options.protocol ? options.protocol === "https:" : secure, callback);
    };
    module.get = function get_(...args) {
      const { options, callback } = requestArgs(args);
      if (!isWebSocketUpgrade(options)) return Reflect.apply(get, this, args);
      const upgrade = new UpgradeRequest(options, options.protocol ? options.protocol === "https:" : secure, callback);
      upgrade.end();
      return upgrade;
    };
    Object.defineProperty(module, patched, { value: true });
    return module;
  }

  // Over the native modules (native-http.ts): each, the first time it is
  // required, with its upgrades answered here. ESM imports of node:http and
  // node:https are the same module objects.
  for (const [name, secure] of [["http", false], ["https", true]]) {
    const native = Object.getOwnPropertyDescriptor(builtins, name);
    Object.defineProperty(builtins, name, {
      configurable: true, enumerable: true,
      get() {
        const module = install(native.get ? native.get.call(builtins) : native.value, secure);
        Object.defineProperty(builtins, name, { value: module, writable: true, enumerable: true, configurable: true });
        return module;
      },
    });
  }
})();

// W3 — net.Socket honest-error mode.
//
// Pre-W3 behaviour: `new net.Socket().connect(443, 'example.com')`
// immediately fired the 'connect' event without any I/O — silent lie.
// Anything attempting raw TCP from a facet (pg, mysql2, redis wire
// protocols) thought it succeeded but produced no I/O.
//
// W3 behaviour: connect() emits 'error' with code
// ERR_NET_SOCKET_NOT_AVAILABLE so callers fail loud.  W8 will route
// raw outbound TCP through supervisor RPC.
builtins.net = (() => {
  class Socket extends __eventsMod {
    constructor() {
      super();
      this.connecting = false;
      this.destroyed = false;
      // Honest: we cannot send/receive bytes from a facet today.
      this.writable = false;
      this.readable = false;
      this.remoteAddress = null;
      this.remotePort = null;
      this.localAddress = "0.0.0.0";
      this.localPort = 0;
    }
    connect(port, host, cb) {
      if (typeof host === "function") { cb = host; host = "127.0.0.1"; }
      // Opening a socket is something a second run would do again
      // (runtime/stop-replay.ts), however it ends.
      __nimbusReplay?.effect("net.connect " + String(host || "127.0.0.1") + ":" + String(port));
      this.remoteAddress = host || "127.0.0.1";
      this.remotePort = port;
      const self = this;
      queueMicrotask(() => {
        const err = new Error(
          "net.Socket: outbound TCP from Nimbus facet not yet supported. " +
          "Use fetch() for HTTP/HTTPS. (W8 will route via supervisor RPC.)"
        );
        err.code = "ERR_NET_SOCKET_NOT_AVAILABLE";
        self.destroyed = true;
        self.emit("error", err);
        if (cb) cb(err);
      });
      return this;
    }
    write() { return false; }
    end(data, enc, cb) {
      if (typeof data === "function") { cb = data; data = undefined; }
      const self = this;
      queueMicrotask(() => { self.emit("end"); self.emit("close"); if (cb) cb(); });
      return this;
    }
    destroy(err) { this.destroyed = true; if (err) this.emit("error", err); this.emit("close"); return this; }
    setEncoding() { return this; }
    setTimeout() { return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { return this; }
    unref() { return this; }
    address() { return null; }
  }
  return {
    Socket,
    get Server() { return builtins.http.Server; },
    createServer: (o, h) => { if (typeof o === "function") { h = o; } return builtins.http.createServer(h); },
    createConnection: (p, h, cb) => new Socket().connect(p, h, cb),
    connect: (p, h, cb) => new Socket().connect(p, h, cb),
    isIP: (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : 0,
    isIPv4: (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s),
    isIPv6: () => false,
  };
})();
// dgram (UDP) — workerd has no UDP sockets. Some packages require it at
// module init (dns2's server/udp.js, bundled by create-cloudflare) but
// never open a UDP server during scaffolding. Expose the API surface so
// module init succeeds; bind/send surface an honest error only if used.
builtins.dgram = (() => {
  class Socket extends __eventsMod {
    constructor(opts) { super(); this.type = (opts && opts.type) || (typeof opts === "string" ? opts : "udp4"); }
    bind(_port, _addr, cb) {
      const err = new Error("UDP sockets are not supported in this runtime");
      err.code = "ERR_SOCKET_BAD_PORT";
      queueMicrotask(() => this.emit("error", err));
      if (typeof cb === "function") queueMicrotask(cb);
      return this;
    }
    send(_msg, ...args) {
      const cb = args.find((a) => typeof a === "function");
      const err = new Error("UDP sockets are not supported in this runtime");
      if (cb) queueMicrotask(() => cb(err)); else queueMicrotask(() => this.emit("error", err));
    }
    address() { return { address: "0.0.0.0", port: 0, family: this.type === "udp6" ? "IPv6" : "IPv4" }; }
    close(cb) { queueMicrotask(() => { this.emit("close"); if (typeof cb === "function") cb(); }); return this; }
    setBroadcast() {} setTTL() {} setMulticastTTL() {} addMembership() {} dropMembership() {}
    ref() { return this; } unref() { return this; }
  }
  return { Socket, createSocket: (opts, cb) => { const s = new Socket(opts); if (typeof cb === "function") s.on("message", cb); return s; } };
})();
builtins.dns = (() => {
  async function _doh(h, t) { try { const r = await fetch("https://cloudflare-dns.com/dns-query?name="+encodeURIComponent(h)+"&type="+(t||"A"),{headers:{"Accept":"application/dns-json"}}); const d = await r.json(); return (d.Answer||[]).map(a=>a.data).filter(Boolean); } catch { return []; } }
  return { resolve: (h,t,cb) => { if (typeof t==="function"){cb=t;t="A";} _doh(h,t).then(a=>cb(null,a.length?a:["127.0.0.1"])).catch(e=>cb(e)); }, resolve4: (h,cb) => _doh(h,"A").then(a=>cb(null,a.length?a:["127.0.0.1"])).catch(e=>cb(e)), resolve6: (h,cb) => _doh(h,"AAAA").then(a=>cb(null,a)).catch(e=>cb(e)), lookup: (h,o,cb) => { if(typeof o==="function"){cb=o;} if(h==="localhost"){cb(null,"127.0.0.1",4);return;} _doh(h,"A").then(a=>cb(null,a[0]||"127.0.0.1",4)).catch(e=>cb(e)); }, promises: { resolve: (h,t) => _doh(h,t||"A"), resolve4: (h) => _doh(h,"A"), lookup: async(h) => { if(h==="localhost") return {address:"127.0.0.1",family:4}; const a=await _doh(h,"A"); return {address:a[0]||"127.0.0.1",family:4}; } } };
})();
builtins.tty = {
  isatty: () => __nimbusAttachedTty,
  ReadStream: class extends __streamMod.Readable {
    constructor() { super(); this.isTTY = __nimbusAttachedTty; this.isRaw = false; }
    setRawMode(mode) { this.isRaw = mode !== false; return this; }
  },
  WriteStream: class extends __streamMod.Writable {
    constructor() { super(); this.isTTY = __nimbusAttachedTty; }
    get columns() { return __nimbusTtyColumns; }
    get rows() { return __nimbusTtyRows; }
    getColorDepth(env) { return __nimbusColorDepth(env); }
    hasColors(count, env) { return __nimbusHasColors(count, env); }
    clearLine(dir, cb) { return __nimbusClearLine(this, dir, cb); }
    clearScreenDown(cb) { return __nimbusClearScreenDown(this, cb); }
    cursorTo(x, y, cb) { return __nimbusCursorTo(this, x, y, cb); }
    moveCursor(dx, dy, cb) { return __nimbusMoveCursor(this, dx, dy, cb); }
    getWindowSize() { return [this.columns, this.rows]; }
  },
};
// builtinModules is the node CORE list. The table also carries the npm
// packages the facet provides itself (FACET_PROVIDED_PACKAGES), which are not
// core and must not be reported as such — a package that sniffs this list
// would otherwise conclude e.g. undici ships with node.
const __nimbusFacetProvidedPackages = new Set(["undici"]);
// node:module. In Node `require('module')` IS the Module constructor, its
// statics the module API, and `Module.Module` the same function: loaders
// such as jiti (Nuxt's nuxt.config, c12) build a module by hand —
// `new Module(filename)`, then `paths`, `require`, and `_compile` — so
// the constructor has to exist with Node's shape. `_compile` turns source
// text into code: through the runtime-code service when the launch carries
// one (a module written after launch is staged for the next launch there),
// otherwise with Node's own wrapper through the Function constructor, which
// works while modules evaluate and whose refusal at request time names the
// file honestly.
function __NodeModule(id = "", parent) {
  if (!new.target) throw new TypeError("Class constructor Module cannot be invoked without 'new'");
  this.id = String(id);
  this.path = __pathMod.dirname(this.id || ".");
  this.exports = {};
  this.filename = null;
  this.loaded = false;
  this.children = [];
  this.paths = [];
  Object.defineProperty(this, "parent", { value: parent, writable: true, configurable: true, enumerable: false });
  if (parent && Array.isArray(parent.children)) parent.children.push(this);
}
__NodeModule.prototype.require = function require(request) {
  if (typeof request !== "string" || request === "") {
    const e = new TypeError('The "id" argument must be of type string. Received ' + (request === "" ? "''" : typeof request));
    e.code = request === "" ? "ERR_INVALID_ARG_VALUE" : "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  return __requireFrom(request, __pathMod.dirname(this.filename || this.id || (cwd || "/home/user") + "/[module]").replace(/^\/+/, ""));
};
__NodeModule.prototype._compile = function _compile(content, filename) {
  const file = String(filename ?? this.filename ?? this.id);
  const dir = __pathMod.dirname(file);
  const text = String(content).replace(/^#!.*/, "");
  const service = globalThis.__nimbusRuntimeCode;
  let wrapper;
  if (service && typeof service.compileModule === "function") {
    wrapper = service.compileModule(file, text);
  } else {
    try {
      wrapper = Function("exports", "require", "module", "__filename", "__dirname", text);
    } catch (e) {
      if (__nimbusIsCodegenRefusal(e)) {
        const err = new Error("Nimbus: Module._compile(" + file + "): a Worker compiles code only while a launch's modules load, and this text arrived after launch.");
        err.code = "ERR_NIMBUS_CODE_NEXT_LAUNCH";
        throw err;
      }
      throw e;
    }
  }
  const moduleRequire = (request) => this.require(request);
  moduleRequire.resolve = (request) => __NodeModule._resolveFilename(request, this);
  moduleRequire.cache = __moduleCache;
  moduleRequire.main = __require.main;
  return wrapper.call(this.exports, this.exports, moduleRequire, this, file, dir);
};
Object.defineProperty(__NodeModule, "builtinModules", {
  get() { return Object.keys(builtins).filter((n) => !__nimbusFacetProvidedPackages.has(n)); },
  enumerable: true, configurable: true,
});
__NodeModule.createRequire = (specifier) => __makeRequire(__requireBaseDir(specifier));
__NodeModule.isBuiltin = (specifier) => Object.hasOwn(builtins, String(specifier).replace(/^node:/, '')) && !__nimbusFacetProvidedPackages.has(String(specifier).replace(/^node:/, ''));
// Node 22.1's on-disk compile cache. There is no disk to cache into and
// nothing to compile ahead: callers (pi's CLI entry calls it
// unconditionally) get Node's own answer for a cache that is off.
__NodeModule.enableCompileCache = () => ({ status: 3, message: 'compile cache is not available in this runtime' });
__NodeModule.getCompileCacheDir = () => undefined;
__NodeModule.flushCompileCache = () => {};
__NodeModule.constants = { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } };
__NodeModule.wrapper = ["(function (exports, require, module, __filename, __dirname) { ", "\n});"];
__NodeModule.wrap = (script) => __NodeModule.wrapper[0] + script + __NodeModule.wrapper[1];
__NodeModule._extensions = { ".js": () => {}, ".json": () => {}, ".node": () => {} };
__NodeModule._cache = {};
__NodeModule.globalPaths = [];
// Node's lookup path list: every ancestor's node_modules, nearest first,
// never a node_modules/node_modules.
__NodeModule._nodeModulePaths = (from) => {
  const resolved = __pathMod.resolve(String(from));
  if (resolved === "/") return ["/node_modules"];
  const paths = [];
  const parts = resolved.split("/");
  for (let i = parts.length; i > 0; i--) {
    if (parts[i - 1] === "node_modules") continue;
    const dir = parts.slice(0, i).join("/");
    paths.push((dir || "") + "/node_modules");
  }
  return paths;
};
__NodeModule._resolveFilename = (request, parent) => {
  const id = String(request).replace(/^node:/, "");
  if (Object.hasOwn(builtins, id) && !__nimbusFacetProvidedPackages.has(id)) return String(request);
  const from = parent && (parent.filename || parent.id)
    ? __pathMod.dirname(parent.filename || parent.id)
    : (cwd || "/home/user");
  const resolved = __resolveFrom(String(request), from.replace(/^\/+/, ""));
  if (!resolved) {
    const e = new Error("Cannot find module '" + request + "'");
    e.code = "MODULE_NOT_FOUND";
    throw e;
  }
  return "/" + String(resolved).replace(/^\/+/, "");
};
__NodeModule._load = (request, parent) => (parent instanceof __NodeModule ? parent.require(request) : __require(request));
__NodeModule.Module = __NodeModule;
Object.defineProperty(__NodeModule, "name", { value: "Module" });
builtins.module = __NodeModule;
// Bind to globalThis: workerd's timer globals throw "Illegal invocation"
// when called with a receiver other than globalThis (i.e. as
// timers.setInterval(...)), which clack's spinner — used by
// create-cloudflare — triggers.
builtins.timers = { setTimeout: globalThis.setTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis), setImmediate: (fn,...a) => globalThis.setTimeout(fn,0,...a), clearImmediate: globalThis.clearTimeout.bind(globalThis) };
// ──  zlib ───────────────────────────────────────────────────────────
//
// Two runtimes, one surface:
//   1. Facet templates prepend the static import block
//      (_shared/real-node-imports.ts), which carries workerd's native
//      node:zlib — complete at the production compat date: every *Sync
//      variant, brotli/zstd, crc32, constants, and real streaming create*
//      factories. Forward verbatim: results are the host realm's own Buffer
//      instances, and __BufferMod.isBuffer recognizes that brand (see the
//      Buffer shim), so Buffer checks stay truthful without copying every
//      result or intercepting stream chunks.
//   2. Scopes without the import block keep the CompressionStream fallback.
//      It is async-only by nature; the sync names refuse with an honest,
//      actionable error instead of pretending.
builtins.zlib = (() => {
  const __real = (typeof __real_zlib !== "undefined") ? (__real_zlib.default ?? __real_zlib) : null;
  if (__real && typeof __real.gzipSync === "function") {
    const mod = {};
    // Constants, lookup tables, crc32, and the stream factories/classes pass
    // through bound to the native module (capitalized names are classes —
    // binding would strip their prototype and break `new`).
    for (const k of Object.keys(__real)) {
      const v = __real[k];
      mod[k] = (typeof v === "function" && /^[a-z]/.test(k)) ? v.bind(__real) : v;
    }
    if (__real.promises) mod.promises = __real.promises;
    mod.default = mod;
    return mod;
  }
  function _c(i,a) { return new Response(new Blob([i]).stream().pipeThrough(new CompressionStream(a))).arrayBuffer().then(ab=>__BufferMod.from(new Uint8Array(ab))); }
  // Decompression is driven by hand rather than piped: feeding and draining
  // run together, because a write only completes while somebody reads.
  async function _d(i,a) {
    const codec = _openCodec("decompress", a);
    const chunks = [];
    let failure = null;
    const record = (reason) => { if (!failure) failure = { reason }; };
    const drain = (async () => {
      for (;;) {
        const next = await codec.reader.read();
        if (next.done) return;
        chunks.push(next.value);
      }
    })().catch(record);
    const feed = (async () => {
      await codec.writer.write(i);
      await codec.writer.close();
    })().catch(record);
    await Promise.all([drain, feed]);
    if (failure) throw _decompressFailure(failure.reason);
    return __BufferMod.from(_concat(chunks));
  }
  function _syncRefusal(name, asyncName) {
    const e = new Error("zlib." + name + ": synchronous compression is not available on this runtime (no native node:zlib in scope). Use the async zlib." + asyncName + "(data, callback) form.");
    e.code = "ERR_ZLIB_SYNC_UNAVAILABLE";
    throw e;
  }
  // Node accepts strings, ArrayBuffers, and any ArrayBufferView; one funnel
  // yields a byte-addressed Uint8Array over the caller's own region —
  // byteOffset/byteLength preserved, element values never reinterpreted.
  function _u8(d) {
    if (typeof d === "string") return new TextEncoder().encode(d);
    if (d instanceof Uint8Array) return d;
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    return new Uint8Array(d);
  }
  // Node splits decompression failures two ways, and the engine's own
  // failure is the only thing that can tell them apart: an input that ran
  // out is Z_BUF_ERROR / errno -5, everything else — bad header, bad block,
  // and a checksum or length trailer that only fails once the member is
  // complete — is Z_DATA_ERROR / errno -3. Which side of a write or close
  // the failure lands on says nothing about that, so it is not consulted.
  function _zdata(e) {
    const err = new Error(e instanceof Error && e.message ? e.message : String(e));
    err.code = "Z_DATA_ERROR";
    err.errno = -3;
    err.cause = e;
    return err;
  }
  function _zbuf(e) {
    const err = new Error("unexpected end of file");
    err.code = "Z_BUF_ERROR";
    err.errno = -5;
    if (e != null) err.cause = e;
    return err;
  }
  function _isUnexpectedEnd(e) {
    const m = e instanceof Error && typeof e.message === "string" ? e.message : String(e);
    return /unexpected end|end of (?:file|input|stream)|premature|truncated|\bEOF\b/i.test(m);
  }
  function _decompressFailure(e) { return _isUnexpectedEnd(e) ? _zbuf(e) : _zdata(e); }
  function _destroyedWrite() {
    const e = new Error("Cannot call write after a stream was destroyed");
    e.code = "ERR_STREAM_DESTROYED";
    return e;
  }
  // Node throws synchronously rather than deferring a callback that is not
  // there; this surface has no promise form to fall back on.
  function _invalidCallback(v) {
    const got = v === undefined ? "undefined"
      : v === null ? "null"
      : typeof v === "object" ? "an instance of " + ((v.constructor && v.constructor.name) || "Object")
      : "type " + typeof v + " (" + String(v) + ")";
    const e = new TypeError('The "callback" argument must be of type function. Received ' + got);
    e.code = "ERR_INVALID_ARG_TYPE";
    return e;
  }
  // Node's Unzip contract sniffs the wrapper itself: gzip magic or zlib.
  function _isGzip(u8) { return u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b; }
  function _concat(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  function _process(mode, fmt, input) {
    const algo = mode === "compress" ? fmt : (fmt || (_isGzip(input) ? "gzip" : "deflate"));
    return mode === "compress" ? _c(input, algo) : _d(input, algo);
  }
  function _async(mode, fmt) {
    return (d, o, cb) => {
      const callback = typeof o === "function" ? o : cb;
      if (typeof callback !== "function") throw _invalidCallback(callback);
      // Two arms, not .then().catch(): a callback that throws on success must
      // not be handed its own exception as a second, failed invocation.
      _process(mode, fmt, _u8(d)).then(
        (r) => callback(null, r),
        (e) => callback(e instanceof Error ? e : new Error(String(e))),
      );
    };
  }
  // Live codec per Transform lifetime: every write feeds one real
  // CompressionStream/DecompressionStream writer (its queue serializes
  // ordering; the write promise settles before the callback), a reader pump
  // relays output as it is produced instead of accumulating the payload,
  // and flush closes the writer then awaits full drain before completing.
  // Chunks are copied so later caller mutations cannot reach the codec, and
  // createUnzip holds copies only until two bytes decide the wrapper.
  function _openCodec(openMode, openAlgo) {
    const cs = openMode === "compress" ? new CompressionStream(openAlgo) : new DecompressionStream(openAlgo);
    return { writer: cs.writable.getWriter(), reader: cs.readable.getReader() };
  }
  // The legacy Readable has no resume notification, so room below the
  // high-water mark is observed by yielding to the task queue until the
  // consumer drains or the stream is destroyed.
  async function _drainRoom(stream) {
    while (
      stream._readableState &&
      !stream._readableState.destroyed &&
      stream.readableLength >= stream._readableState.highWaterMark
    ) {
      await new Promise((tick) => setTimeout(tick, 0));
    }
    // True when the wait ended because the stream went away, not because
    // the consumer made room.
    return !!(stream._readableState && stream._readableState.destroyed);
  }
  function _streamFactory(factoryMode, fmt) {
    return () => {
      let writer = null;
      let reader = null;
      let drained = Promise.resolve();
      let pumpFailure = null;
      let algo = fmt;
      let held = [];
      let heldLen = 0;
      let destroyed = false;
      const t = new __streamMod.Transform({
        transform: async (chunk, _enc, cb) => {
          try {
            if (destroyed) return cb(_destroyedWrite());
            const bytes = _u8(chunk).slice();
            let feed = bytes;
            if (!writer) {
              if (fmt === null && heldLen + bytes.length < 2) {
                held.push(bytes);
                heldLen += bytes.length;
                return cb();
              }
              if (heldLen > 0) feed = _concat([...held, bytes]);
              held = [];
              heldLen = 0;
              if (fmt === null) algo = _isGzip(feed) ? "gzip" : "deflate";
              start();
            }
            await writer.write(feed);
            cb();
          } catch (e) {
            cb(destroyed ? _destroyedWrite() : factoryMode === "decompress" ? _decompressFailure(e) : e);
          }
        },
        flush: async (cb) => {
          try {
            if (destroyed) return cb(_destroyedWrite());
            if (!writer) {
              if (factoryMode !== "compress") {
                // Nothing was ever fed: the input ended before a member
                // began, which is Node's unexpected-end buffer error rather
                // than corrupt data. No codec is invented to hide it.
                return cb(_zbuf(null));
              }
              start();
            }
            await writer.close();
            await drained;
            cb(pumpFailure);
          } catch (e) {
            if (pumpFailure) return cb(pumpFailure);
            if (destroyed) return cb(_destroyedWrite());
            cb(factoryMode === "decompress" ? _decompressFailure(e) : e);
          }
        },
      });
      // Every destroy exit fires 'close' on the custom Transform — even when
      // the pump sits parked inside reader.read() on truncated input that can
      // never decode. Waking there is immediate: cancel settles the parked
      // read, abort fails queued writes, and writes arriving after destroy
      // report ERR_STREAM_DESTROYED instead of silent acceptance.
      t.on("close", () => {
        destroyed = true;
        _releaseCodec();
      });
      // One cleanup path for every destroy exit: cancel the readable side,
      // abort the writable side, and stop the pump.
      function _releaseCodec() {
        if (reader) reader.cancel().catch(() => {});
        if (writer) writer.abort().catch(() => {});
      }
      function start() {
        const opened = _openCodec(factoryMode, algo);
        writer = opened.writer;
        reader = opened.reader;
        drained = (async () => {
          try {
            for (;;) {
              // A destroy can land while a read is in flight; check on both
              // sides so nothing buffers after the stream went away.
              if (destroyed) return _releaseCodec();
              const next = await reader.read();
              if (destroyed) return _releaseCodec();
              if (next.done) {
                return;
              }
              // Backpressure: once push reports pressure, park the pump and
              // do not read again until the consumer drains below the
              // high-water mark. The pending writer.write promise then holds
              // the transform callback, so producer writes stop resolving
              // instead of accumulating. A destroy while parked releases the
              // codec through the close hook above.
              if (!t.push(__BufferMod.from(next.value))) {
                if (await _drainRoom(t)) return _releaseCodec();
              }
            }
          } catch (e) {
            pumpFailure = factoryMode === "decompress"
              ? _decompressFailure(e)
              : (e instanceof Error ? e : new Error(String(e)));
          }
        })();
      }
      return t;
    };
  }
  return {
    gzip: _async("compress", "gzip"),
    gunzip: _async("decompress", "gzip"),
    deflate: _async("compress", "deflate"),
    inflate: _async("decompress", "deflate"),
    deflateRaw: _async("compress", "deflate-raw"),
    inflateRaw: _async("decompress", "deflate-raw"),
    unzip: _async("decompress", null),
    gzipSync: (d, o) => _syncRefusal("gzipSync", "gzip"),
    gunzipSync: (d, o) => _syncRefusal("gunzipSync", "gunzip"),
    deflateSync: (d, o) => _syncRefusal("deflateSync", "deflate"),
    inflateSync: (d, o) => _syncRefusal("inflateSync", "inflate"),
    deflateRawSync: (d, o) => _syncRefusal("deflateRawSync", "deflateRaw"),
    inflateRawSync: (d, o) => _syncRefusal("inflateRawSync", "inflateRaw"),
    unzipSync: (d, o) => _syncRefusal("unzipSync", "unzip"),
    createGzip: _streamFactory("compress", "gzip"),
    createGunzip: _streamFactory("decompress", "gzip"),
    createDeflate: _streamFactory("compress", "deflate"),
    createInflate: _streamFactory("decompress", "deflate"),
    createDeflateRaw: _streamFactory("compress", "deflate-raw"),
    createInflateRaw: _streamFactory("decompress", "deflate-raw"),
    createUnzip: _streamFactory("decompress", null),
    constants: { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1 },
  };
})();
builtins.readline = (() => {
  function emitKeypressEvents(stream) {
    if (!stream || stream.__nimbusKeypressEvents) return;
    stream.__nimbusKeypressEvents = true;
    stream.on("data", (chunk) => {
      const text = chunk instanceof Uint8Array
        ? new TextDecoder("utf-8").decode(chunk)
        : String(chunk);
      for (let i = 0; i < text.length; i++) {
        let str = text[i];
        let key = { sequence: str, name: str, ctrl: false, meta: false, shift: false };
        if (str === "\x1b" && text[i + 1] === "[") {
          const code = text[i + 2];
          if (code === "A" || code === "B" || code === "C" || code === "D") {
            i += 2;
            str = "\x1b[" + code;
            key = {
              sequence: str,
              name: code === "A" ? "up" : code === "B" ? "down" : code === "C" ? "right" : "left",
              ctrl: false,
              meta: false,
              shift: false,
            };
          }
        } else if (str === "\x03") {
          key = { sequence: str, name: "c", ctrl: true, meta: false, shift: false };
        } else if (str === "\x7f" || str === "\b") {
          key = { sequence: str, name: "backspace", ctrl: false, meta: false, shift: false };
        } else if (str === "\r" || str === "\n") {
          key = { sequence: str, name: "enter", ctrl: false, meta: false, shift: false };
        }
        stream.emit("keypress", str, key);
      }
    });
  }
  function createInterface(opts) {
    const inp = typeof opts === "object" && opts ? opts : { input: opts };
    const input = inp.input || __processMod.stdin;
    const output = inp.output || __processMod.stdout;
    const rl = new __eventsMod();
    let closed = false;
    let promptText = inp.prompt || "> ";
    let buffer = "";
    const pending = [];
    const queued = [];
    function pushLine(line) {
      if (closed) return;
      rl.emit("line", line);
      const waiter = pending.shift();
      if (waiter) waiter({ value: line, done: false });
      else queued.push(line);
    }
    function handleInputText(text) {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "\r" || ch === "\n") {
          if (ch === "\r" && text[i + 1] === "\n") i++;
          const line = buffer;
          buffer = "";
          pushLine(line);
          continue;
        }
        if (ch === "\x7f" || ch === "\b") {
          if (buffer.length > 0) buffer = buffer.slice(0, -1);
          continue;
        }
        if (ch === "\x03") {
          rl.emit("SIGINT");
          continue;
        }
        buffer += ch;
      }
    }
    function onData(chunk) {
      const text = chunk instanceof Uint8Array
        ? new TextDecoder("utf-8").decode(chunk)
        : String(chunk);
      handleInputText(text);
    }
    function onEnd() {
      if (buffer) {
        const tail = buffer;
        buffer = "";
        pushLine(tail);
      }
      rl.close();
    }
    try {
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("close", onEnd);
      if (typeof input.resume === "function") input.resume();
    } catch {}
    rl.close = () => {
      if (closed) return;
      closed = true;
      try { input.removeListener?.("data", onData); } catch {}
      try { input.removeListener?.("end", onEnd); } catch {}
      try { input.removeListener?.("close", onEnd); } catch {}
      for (const waiter of pending.splice(0)) waiter({ value: undefined, done: true });
      rl.emit("close");
    };
    rl.question = (q, o, cb) => {
      if (typeof o === "function") cb = o;
      if (output && typeof output.write === "function") output.write(q);
      const onLine = (line) => {
        rl.removeListener("line", onLine);
        if (typeof cb === "function") cb(line);
      };
      rl.on("line", onLine);
    };
    rl.prompt = () => { if (output && typeof output.write === "function") output.write(promptText); };
    rl.setPrompt = (p) => { promptText = String(p); return rl; };
    rl.getPrompt = () => promptText;
    rl.pause = () => { try { input.pause?.(); } catch {} return rl; };
    rl.resume = () => { try { input.resume?.(); } catch {} return rl; };
    rl.write = (data) => { onData(data); return rl; };
    rl[Symbol.asyncIterator] = async function*() {
      while (!closed) {
        if (queued.length > 0) {
          yield queued.shift();
          continue;
        }
        const next = await new Promise((resolve) => pending.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    };
    return rl;
  }
  function clearLine(stream, dir, cb) { return __nimbusClearLine(stream, dir, cb); }
  function clearScreenDown(stream, cb) { return __nimbusClearScreenDown(stream, cb); }
  function cursorTo(stream, x, y, cb) { return __nimbusCursorTo(stream, x, y, cb); }
  function moveCursor(stream, dx, dy, cb) { return __nimbusMoveCursor(stream, dx, dy, cb); }
  const promises = {
    createInterface(opts) {
      const iface = createInterface(opts);
      const originalQuestion = iface.question.bind(iface);
      iface.question = (query, options) => new Promise((resolve) => {
        void options;
        originalQuestion(query, (answer) => resolve(answer));
      });
      return iface;
    },
  };
  return {
    createInterface,
    Interface: __eventsMod,
    clearLine,
    clearScreenDown,
    cursorTo,
    moveCursor,
    emitKeypressEvents,
    promises,
  };
})();
builtins.perf_hooks = { performance: globalThis.performance || { now:()=>Date.now(), mark:()=>{}, measure:()=>{}, getEntriesByName:()=>[], clearMarks:()=>{}, clearMeasures:()=>{} } };
// X.5-Z5 §3 follow-on: minimal v8 stub for jiti (used transitively by
// @tailwindcss/vite). jiti reads v8.startupSnapshot.isBuildingSnapshot()
// to decide whether to skip JIT compilation; workerd never builds v8
// snapshots, so 'false' is the correct answer. Other v8 introspection
// APIs (cachedDataVersionTag, getHeapStatistics, etc.) return inert
// values that satisfy the shape contract without offering real data.
builtins.v8 = {
  startupSnapshot: {
    isBuildingSnapshot: () => false,
    addSerializeCallback: () => {},
    addDeserializeCallback: () => {},
    setDeserializeMainFunction: () => {},
    setDeserializeData: () => {},
  },
  cachedDataVersionTag: () => 0,
  getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0, malloced_memory: 0 }),
  getHeapSpaceStatistics: () => [],
  setFlagsFromString: () => {},
  serialize: (v) => __BufferMod.from(JSON.stringify(v)),
  deserialize: (b) => JSON.parse(__BufferMod.from(b).toString()),
  writeHeapSnapshot: () => "",
};
const __workerThreadsUntransferable = new WeakSet();
const __workerThreadsUncloneable = new WeakSet();
builtins.worker_threads = {
  isMainThread: true,
  parentPort: null,
  workerData: null,
  threadId: 0,
  SHARE_ENV: Symbol.for("nodejs.worker_threads.SHARE_ENV"),
  Worker: class extends __eventsMod {
    constructor() { super(); }
    terminate() { return Promise.resolve(0); }
    postMessage() {}
  },
  MessageChannel: globalThis.MessageChannel,
  MessagePort: globalThis.MessagePort,
  BroadcastChannel: globalThis.BroadcastChannel,
  receiveMessageOnPort: () => undefined,
  markAsUntransferable(value) {
    if (value && (typeof value === "object" || typeof value === "function")) {
      __workerThreadsUntransferable.add(value);
    }
  },
  isMarkedAsUntransferable(value) {
    return !!(value && (typeof value === "object" || typeof value === "function") &&
      __workerThreadsUntransferable.has(value));
  },
  markAsUncloneable(value) {
    if (value && (typeof value === "object" || typeof value === "function")) {
      __workerThreadsUncloneable.add(value);
    }
  },
};

// ── W3 additions: builtins forwarded/shimmed for axios/jsdom/fastify/
//                 puppeteer-core/ts-node + Node 20 surface completeness.
builtins.vm = __vmMod;
builtins.http2 = __http2Mod;
builtins.repl = __replMod;
builtins.diagnostics_channel = __diagChannelMod;
builtins.tls = __tlsMod;
builtins.async_hooks = __asyncHooksMod;
builtins.inspector = __inspectorMod;
// node:inspector/promises — the promisified Session surface. workerd
// exposes it natively; fall back to a Promise-shaped wrapper otherwise.
builtins["inspector/promises"] = (() => {
  const real = (typeof __real_inspector !== 'undefined') ? (__real_inspector.default ?? __real_inspector) : null;
  if (real && real.promises && typeof real.promises.Session === 'function') return real.promises;
  return {
    Session: class { connect() {} disconnect() {} post(_m, _p) { return Promise.resolve({}); } on() { return this; } },
    console: __inspectorMod.console, url: __inspectorMod.url,
    open: __inspectorMod.open, close: __inspectorMod.close, waitForDebugger: __inspectorMod.waitForDebugger,
  };
})();
builtins["node:inspector/promises"] = builtins["inspector/promises"];
// Subpath-style require() — the shim's __requireFrom strips a 'node:'
// prefix to look up bare names, so we expose both bare and prefixed
// keys explicitly for grep-friendliness and to handle any future call
// site that bypasses the strip path.
builtins["fs/promises"] = __fsMod.promises;
builtins["node:fs/promises"] = __fsMod.promises;
builtins["readline/promises"] = builtins.readline.promises;
builtins["node:readline/promises"] = builtins.readline.promises;

// stream/promises — promise-wrapped versions of pipeline + finished.
// Surfaced by sv (svelte CLI, the new replacement for create-svelte
// v6.x) at /tmp/.npx-cache/node_modules/sv/dist/bin.mjs — it imports
// 'node:stream/promises' for promise-style pipeline composition.
// signal-exit, gulp's vinyl streams, tar-fs, and many node-only build
// scripts use this subpath too.
//
// Real Node's stream/promises wraps the callback-style pipeline/
// finished from 'stream' into Promise-returning variants. The
// __streamMod above already ships pipeline() and finished() in their
// callback form (src/runtime/streams.ts:339/361); the promise wrapper
// is a thin shim that returns a Promise resolving on success +
// rejecting on the callback's err arg.
builtins["stream/promises"] = (() => {
  const promisifyOp = (op) => (...args) => new Promise((res, rej) => {
    // op signature: op(...streamsOrTarget, callback)
    op(...args, (err, value) => {
      if (err) rej(err);
      else res(value);
    });
  });
  return {
    pipeline: promisifyOp(__streamMod.pipeline),
    finished: promisifyOp(__streamMod.finished),
  };
})();
builtins["node:stream/promises"] = builtins["stream/promises"];

// stream/consumers — Promise-returning helpers that drain a Readable.
// Node 16.7+. Used by undici, tar-stream, multiple "consume the whole
// body" patterns. Each helper takes a readable stream and returns a
// Promise<Buffer | string | object | array>.
builtins["stream/consumers"] = (() => {
  function readAll(stream) {
    return new Promise((res, rej) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => res(chunks));
      stream.on('error', rej);
    });
  }
  return {
    buffer: async (stream) => {
      const chunks = await readAll(stream);
      // Concat Buffers / Uint8Arrays / strings.
      if (chunks.length === 0) return __BufferMod.alloc(0);
      if (typeof chunks[0] === 'string') {
        return __BufferMod.from(chunks.join(''));
      }
      return __BufferMod.concat(chunks);
    },
    text: async (stream) => {
      const chunks = await readAll(stream);
      if (chunks.length === 0) return '';
      if (typeof chunks[0] === 'string') return chunks.join('');
      return __BufferMod.concat(chunks).toString('utf8');
    },
    json: async (stream) => {
      const chunks = await readAll(stream);
      const text = typeof chunks[0] === 'string'
        ? chunks.join('')
        : __BufferMod.concat(chunks).toString('utf8');
      return JSON.parse(text);
    },
    arrayBuffer: async (stream) => {
      const chunks = await readAll(stream);
      const buf = __BufferMod.concat(chunks);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    blob: async () => {
      throw new Error('stream/consumers.blob not implemented');
    },
  };
})();
builtins["node:stream/consumers"] = builtins["stream/consumers"];

// stream/web — Web Streams API namespace. Node 17+. Userland CLIs
// occasionally pull `ReadableStream` from here for portability. The
// platform exposes these globals already; we just re-export them.
builtins["stream/web"] = {
  ReadableStream: globalThis.ReadableStream,
  WritableStream: globalThis.WritableStream,
  TransformStream: globalThis.TransformStream,
  ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
  CountQueuingStrategy: globalThis.CountQueuingStrategy,
  ReadableStreamDefaultReader: globalThis.ReadableStreamDefaultReader,
  ReadableStreamDefaultController: globalThis.ReadableStreamDefaultController,
  WritableStreamDefaultWriter: globalThis.WritableStreamDefaultWriter,
};
builtins["node:stream/web"] = builtins["stream/web"];
builtins["timers/promises"] = (() => {
  return {
    setTimeout: (ms, value) => new Promise(res => setTimeout(() => res(value), ms || 0)),
    setImmediate: (value) => new Promise(res => queueMicrotask(() => res(value))),
    setInterval: async function* (ms, value) {
      while (true) { await new Promise(r => setTimeout(r, ms || 0)); yield value; }
    },
  };
})();
builtins["node:timers/promises"] = builtins["timers/promises"];

// X.5-M (M-2): dns/promises subpath registration for redis.
// @redis/client/dist/lib/client does require('dns/promises') to do
// hostname → IP resolution. Pre-fix the only exposure was
// builtins.dns.promises (an object property of the parent dns shim);
// __requireFrom matches keys exactly, so 'dns/promises' missed.
// Mirror the timers/promises pattern above. builtins.dns.promises is
// already a complete object (DoH-backed lookup/resolve/resolve4) —
// re-exposing it as a subpath builtin is a 2-line registration.
builtins["dns/promises"] = builtins.dns.promises;
builtins["node:dns/promises"] = builtins["dns/promises"];

// X.5-Q: util/types subpath registration for jsdom's bundled undici.
// undici@7.x calls require('node:util/types').{isUint8Array,isArrayBuffer}
// directly from lib/web/fetch/util.js + body.js + websocket/websocket.js.
// __requireFrom matches keys exactly; pre-fix the only exposure was
// builtins.util.types (object property of parent util shim), so the
// subpath missed. Mirror the dns/promises (M-2) pattern. The
// builtins.util.types object is the X.5-Q-expanded 17-method polyfill
// (see line 707), sufficient for undici@7.25.0 + undici@8.2.0.
builtins["util/types"] = builtins.util.types;
builtins["node:util/types"] = builtins["util/types"];

// undici (npm, not node core) — Nimbus provides it instead of node_modules.
// __requireFrom checks this table BEFORE resolving, so this wins over any
// installed copy, and esbuild lowers every ESM import of "undici" into the
// same require. Rationale for shadowing it at all: runtime/undici-shim.ts.
// No "node:undici" alias — it is not a node builtin, and the prefetch walker
// skips it via the same FACET_PROVIDED_PACKAGES list.
builtins.undici = __undiciMod;

// ═══════════════════════════════════════════════════════════════════════
// ──  require() — full Node.js module resolution ─────────────────────
// ═══════════════════════════════════════════════════════════════════════
const __moduleCache = new Map();
// A module cell's evaluation when it completes later (top-level await), by
// its evaluation key: what an import of it waits for.
const __moduleEvaluations = new Map();
// package → why the package ABI policy says it cannot run here (wasm-swap-registry.ts).
const __nimbusAbiAdvisories = new Map([["sharp","Native libvips bindings; not portable to Workers. … try: no Workers-compatible target — render server-side or use Cloudflare Images. For the wasm32 build see @img/sharp-wasm32 entry below."],["sqlite3","Native sqlite3 .node binding. … try: better-sqlite3-wasm (untested by Nimbus) or sql.js once wasm asset loading is available."],["better-sqlite3","Native sqlite .node binding. … try: better-sqlite3-wasm (untested by Nimbus) or @libsql/client if its subpath exports resolve in your project."],["canvas","Native Cairo bindings. … try: canvaskit-wasm (Skia -> WASM, canvas-API-compatible, ~7MB; untested by Nimbus) or @resvg/resvg-wasm for SVG."],["sodium-native","Native libsodium. … try: tweetnacl (pure JS, untested by Nimbus) or libsodium-wrappers (WASM, untested by Nimbus)."],["node-pty","PTY syscalls unavailable in workerd. … try: no Workers-compatible target — use the Nimbus built-in shell."],["robotjs","Desktop automation; sandboxed Workers cannot access OS UI. … try: no Workers-compatible target."],["electron","Embedded Chromium runtime; not applicable to Workers. … try: no Workers-compatible target."],["bcrypt","Native bcrypt; pure-JS bcryptjs has an equivalent sync API but the require() name differs and Nimbus does not yet support npm aliases. … try: change `require(\"bcrypt\")` to `require(\"bcryptjs\")`, then `npm install bcryptjs`. APIs are sync-compatible."],["argon2","Native Argon2 C bindings. … try: hash-wasm for argon2d, argon2i, and argon2id."],["node-sass","Native libsass; deprecated upstream. … try: sass (dart-sass, pure JS)."],["grpc","Deprecated native gRPC. … try: @grpc/grpc-js (pure JS, untested end-to-end in Nimbus)."],["@swc/core","Native Rust SWC. … try: @swc/wasm-web for transform/parse only; it does not provide the native Plugin API."],["prisma","Native query engine; not portable to Workers in this configuration. … try: @prisma/adapter-d1 (Prisma official Workers adapter, untested by Nimbus), or migrate to drizzle-orm + @libsql/client (untested by Nimbus)."],["@prisma/client","Same as `prisma` (native query engine). … try: @prisma/adapter-d1 (untested by Nimbus), or drizzle-orm + @libsql/client (untested)."],["puppeteer","Bundled Chromium binary (~150 MB). … try: no Workers-compatible target for the bundled binary — use puppeteer-core + Cloudflare Browser Rendering (untested by Nimbus)."],["playwright","Bundled browsers (~300 MB). … try: no Workers-compatible target for bundled browsers — use @playwright/test against a remote browser endpoint (untested by Nimbus)."],["sql.js","Installs but fails at runtime because dist/sql-wasm.wasm is not available to the runtime loader. … try: For SQL in Workers, consider Cloudflare D1 or @libsql/client."],["@swc/wasm-web","Installs but fails at runtime because its generated code path depends on workerd-blocked dynamic code generation. … try: For ESM transforms consider esbuild-wasm."],["@img/sharp-wasm32","WASM build of sharp; package is wasm32-cpu-only and libvips initThreads() requires pthread support unavailable in Workers. … try: wasm-vips may work for simple pipelines; for complex pipelines, render server-side and ship pixels."],["@napi-rs/canvas","Native bindings only (linux-x64-gnu/musl, darwin-arm64/x64, android-arm64, linux-arm64-gnu/musl, win32-x64-msvc, linux-arm-gnueabihf). No WASM build published. … try: canvaskit-wasm (Skia -> WASM, canvas-API-compatible, ~7MB; untested by Nimbus) or @resvg/resvg-wasm for SVG."],["@napi-rs/canvas-wasm32-wasi","@napi-rs/canvas does not publish a wasm32-wasi variant on npm (404). The @napi-rs/canvas project ships only native bindings. No WASM/WASI build exists. … try: canvaskit-wasm (Skia -> WASM, canvas-API-compatible; untested by Nimbus) or @resvg/resvg-wasm for SVG."],["@tailwindcss/oxide","Native Rust Tailwind v4 oxide engine; ships only platform-specific .node bindings plus a wasm32-wasi shard. workerd has no node:wasi, and bare native bindings cannot dlopen. … try: no Workers-compatible target — Tailwind v3 (`tailwindcss@^3`) is pure JS and works in Workers (untested by Nimbus). Tailwind v4 inherently requires the Rust oxide engine."]]);

// An ES module's scope binds none of CommonJS's names (module-format.ts
// ES_MODULE_UNBOUND_NAMES): a lowered ES module reads, calls and assigns each
// of them through this object's accessors, which throw the ReferenceError V8
// throws for a name bound nowhere, from the module's own frame. `typeof` of
// one is lowered to 'undefined', as V8's is.
const __nimbusCommonJSGlobalLike = ["exports","require","module","__filename","__dirname"];
Object.defineProperty(globalThis, "__nimbusEsmScope", { configurable: true, value: Object.freeze(Object.create(null, Object.fromEntries(
  __nimbusCommonJSGlobalLike.map((name) => {
    const unbound = function () {
      const error = new ReferenceError(name + " is not defined");
      Error.captureStackTrace(error, unbound);
      throw error;
    };
    return [name, { get: unbound, set: unbound }];
  }),
))) });

// The errors __nimbusExplainCommonJSGlobalLike has explained.
const __nimbusExplained = new WeakSet();
function __nimbusIsCommonJSGlobalLikeError(e) {
  return e !== null && typeof e === "object" && (__nimbusExplained.has(e)
    || (e.name === "ReferenceError" && __nimbusCommonJSGlobalLike.some((name) => e.message === name + " is not defined")));
}

// Node's explainCommonJSGlobalLikeNotDefinedError (lib/internal/modules/esm/
// module_job.js, v22.22.3): what a ReferenceError for a CommonJS name says
// once it escapes the evaluation of an ES module job the loader ran: a
// program's ES entry, an import(), a require() of an ES module. `url` and
// `hasTopLevelAwait` are the job's module's. Thrown anywhere else (in a
// callback, or caught inside the module) it says what V8 says.
function __nimbusExplainCommonJSGlobalLike(e, url, hasTopLevelAwait) {
  if (e?.name === "ReferenceError" && __nimbusCommonJSGlobalLike.some((name) => e.message === name + " is not defined")) {
    __nimbusExplained.add(e);
    // The stack Node's error prints was formatted after this, with the
    // message as it ends; one formatted already leads with it too.
    const header = e.name + ": " + e.message;
    const stack = e.stack;
    if (hasTopLevelAwait) {
      e.message = "Cannot determine intended module format because both require() and top-level await are present. If the code is intended to be CommonJS, wrap await in an async function. If the code is intended to be an ES module, replace require() with import.";
      e.code = "ERR_AMBIGUOUS_MODULE_SYNTAX";
    } else {
      e.message += " in ES module scope";
      if (e.message.startsWith("require ")) e.message += ", you can use import instead";
      const packageConfig = url.startsWith("file://") && /\.js(\?[^#]*)?(#.*)?$/.exec(url) !== null
        && __esmResolver.packageScopeSync(url);
      if (packageConfig.type === "module") {
        e.message += "\nThis file is being treated as an ES module because it has a '.js' file extension and '"
          + packageConfig.pjsonPath + "' contains \"type\": \"module\". To treat it as a CommonJS script, rename it to use the '.cjs' file extension.";
      }
    }
    if (typeof stack === "string" && stack.startsWith(header)) e.stack = e.name + ": " + e.message + stack.slice(header.length);
  }
}

/**
 * Direct VFS bundle access for module resolution.
 * These bypass the fs shim's _resolve() (which prepends cwd)
 * because resolver paths are already in VFS format (no leading /).
 */
function __readFileOr(path, fallback) {
  const k = path.replace(/^\/+/, "");
  // binary-fs: bundle/writes cells may be Uint8Array; module-resolution
  // callers (package.json parse, source compile) want strings. Decode
  // bytes lossily — same as Node's Buffer.toString('utf8').
  function _coerceStr(v) {
    if (typeof v === "string") return v;
    if (v instanceof Uint8Array) {
      try { return new TextDecoder().decode(v); } catch { return fallback; }
    }
    return fallback;
  }
  if (__vfsBundle && k in __vfsBundle) return _coerceStr(__vfsBundle[k]);
  if (__vfsWrites && k in __vfsWrites) return _coerceStr(__vfsWrites[k]);
  // Fallback: try through fs shim (handles _resolve for user-facing paths)
  try { return __fsMod.readFileSync("/" + k, "utf8"); } catch { return fallback; }
}
function __fileExists(path) {
  const k = path.replace(/^\/+/, "");
  // The namespace answers exactly (vfs/facet-resident-store.ts), except on a
  // mounted directory the launch did not list: asked only when the namespace
  // holds such a directory, statSync's refusal says so, and resolution
  // reports it rather than "Cannot find module".
  if (__fsMod.existsSync("/" + k)) return true;
  if (typeof __nsUnknown === "function" && __nsUnknown(k, true, false) !== null) __fsMod.statSync("/" + k);
  return false;
}
// W3.5 Fix A: strict-file membership probe. __fileExists also returns true for
// directories (it has to — __resolveNodeModule and __resolveImportsField call
// it to check whether a node_modules/<pkg> directory exists). __resolveFile's
// empty-extension probe needs the inverse: "is this an actual file?" — so the
// loop falls through to /index.js when "base" is a directory rather than
// short-circuiting and returning the directory path (which __loadModule then
// can't read, throwing "Cannot read module: <dir>"). See W3 retro §S3 for
// the fastify ret/dist/types failure.
function __pathIsFile(path) {
  const k = path.replace(/^\/+/, "");
  const st = __fsMod.statSync("/" + k, { throwIfNoEntry: false });
  return !!st && st.isFile();
}
function __resolveFile(base) {
  // Mirrors Node's LOAD_AS_FILE + LOAD_AS_DIRECTORY (require_2 spec):
  //
  //   1. LOAD_AS_FILE -- try base, base.js, base.mjs, base.cjs, base.json
  //      as a regular file. The empty-ext probe uses __pathIsFile (not
  //      __fileExists) so a directory at "base" does NOT short-circuit
  //      here; it falls through to the LOAD_AS_DIRECTORY block below.
  //      See W3.5-plan.md §1 Failure 1.
  //
  //   2. LOAD_AS_DIRECTORY -- if "base" resolves to a directory:
  //      a. If <base>/package.json has a "main" field -- recurse on it.
  //         (Bug class C, audit 2026-05-11: this branch was missing,
  //          so require("./mod") where mod/package.json#main="entry.js"
  //          and no mod/index.js -- "Cannot find module ./mod".)
  //      b. Else fall through to <base>/index.{js,cjs,mjs,json}.
  //
  // Must mirror the install-time pre-bundler at require-resolver.ts:
  // resolveFile so prefetch + runtime agree on which file a given
  // require() will load.
  const fileExts = ["", ".js", ".mjs", ".cjs", ".json"];
  for (const ext of fileExts) {
    const cand = base + ext;
    if (ext === "") {
      if (__pathIsFile(cand)) return cand;
      continue;
    }
    if (__fileExists(cand)) return cand;
  }
  // LOAD_AS_DIRECTORY: prefer package.json#main over index.*
  const pkgJsonPath = base.replace(/\/+$/, "") + "/package.json";
  if (__pathIsFile(pkgJsonPath)) {
    let pkg = null;
    try { pkg = JSON.parse(__readFileOr(pkgJsonPath, "null")); } catch { /* fall through */ }
    if (pkg && typeof pkg.main === "string" && pkg.main.length > 0) {
      const mainStripped = pkg.main.replace(/^\.\/+/, "").replace(/^\/+/, "");
      // Normalize so a parent-relative main (e.g. web-streams-polyfill's
      // ponyfill/package.json declaring main "../dist/ponyfill") collapses
      // its ".." segments instead of probing a literal "dir/../dist" path
      // that __fileExists never matches.
      const mainBase = __vfsNormalizePath(base.replace(/\/+$/, "") + "/" + mainStripped).replace(/^\/+/, "");
      // Recurse: main itself may be a directory (e.g. main: "lib") or
      // a file without extension. Guard against pkg.main === "." which
      // would re-enter this same base and stack-overflow.
      if (mainBase !== base && mainBase !== base.replace(/\/+$/, "")) {
        const resolved = __resolveFile(mainBase);
        if (resolved) return resolved;
      }
    }
  }
  const indexExts = ["/index.js", "/index.cjs", "/index.mjs", "/index.json"];
  for (const ext of indexExts) {
    const cand = base + ext;
    if (__fileExists(cand)) return cand;
  }
  // TypeScript sources, probed only once every candidate above has missed, so
  // the specifiers whose resolution changes are exactly those that resolve to
  // nothing today. Must agree with the prefetch resolver or a file is shipped
  // that this cannot find; both come from src/_shared/typescript-specifiers.ts
  // and tests/unit/typescript-specifier-resolution.mjs compares them.
  const baseTrim = base.replace(/\/+$/, "");
  for (const cand of typescriptFallbackCandidates(baseTrim)) {
    if (__pathIsFile(cand)) return cand;
  }
  for (const ext of TYPESCRIPT_INDEX_CANDIDATES) {
    const cand = baseTrim + ext;
    if (__pathIsFile(cand)) return cand;
  }
  return null;
}

// ── Resolution and credential rules, compiled from @nimbus-sh/core ──────
// _shared/node-shim-resolution.ts (NODE_SHIM_RESOLUTION_PREAMBLE). Declares
// resolveExports, resolvePackageEntry, packageSelfReferenceSubpath,
// DEFAULT_ESM_CONDITIONS, DEFAULT_CJS_CONDITIONS, typescriptFallbackCandidates,
// TYPESCRIPT_INDEX_CANDIDATES and presentedCredential (a function declaration,
// so the fetch patch above can call it).
var DEFAULT_ESM_CONDITIONS = ["import", "module", "browser", "default"];
var DEFAULT_CJS_CONDITIONS = ["require", "node", "default"];
function resolveExports(exportsField, subpath = ".", conditions = DEFAULT_ESM_CONDITIONS) {
  if (exportsField === void 0 || exportsField === null) return null;
  if (typeof exportsField === "string") {
    return subpath === "." ? exportsField : null;
  }
  if (Array.isArray(exportsField)) {
    for (const item of exportsField) {
      const r = resolveExports(item, subpath, conditions);
      if (r) return r;
    }
    return null;
  }
  if (typeof exportsField !== "object") return null;
  const keys = Object.keys(exportsField);
  if (keys.length === 0) return null;
  const isSubpathMap = keys[0].startsWith(".") || keys[0].startsWith("#");
  if (isSubpathMap) {
    if (subpath in exportsField) {
      const target = exportsField[subpath];
      if (target === null) return null;
      return resolveConditionValue(target, conditions);
    }
    const wildcardKeys = keys.filter((k) => k.includes("*")).sort((a, b) => b.length - a.length);
    for (const pattern of wildcardKeys) {
      const target = exportsField[pattern];
      const starIdx = pattern.indexOf("*");
      const prefix = pattern.slice(0, starIdx);
      const suffix = pattern.slice(starIdx + 1);
      if (subpath.startsWith(prefix) && (suffix ? subpath.endsWith(suffix) : true) && subpath.length >= prefix.length + suffix.length) {
        if (target === null) return null;
        const matched = subpath.slice(
          prefix.length,
          suffix ? subpath.length - suffix.length : void 0
        );
        const resolved = resolveConditionValue(target, conditions);
        if (resolved) return resolved.split("*").join(matched);
      }
    }
    return null;
  }
  if (subpath !== ".") return null;
  return resolveConditionValue(exportsField, conditions);
}
function resolveConditionValue(target, conditions) {
  if (target === null || target === void 0) return null;
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const r = resolveConditionValue(item, conditions);
      if (r) return r;
    }
    return null;
  }
  if (typeof target !== "object") return null;
  for (const cond of conditions) {
    if (cond in target) {
      const r = resolveConditionValue(target[cond], conditions);
      if (r) return r;
    }
  }
  if (!conditions.includes("default") && "default" in target) {
    return resolveConditionValue(target.default, conditions);
  }
  return null;
}
function resolvePackageEntry(pkg, subpath = ".", conditions = DEFAULT_ESM_CONDITIONS) {
  if (pkg.exports !== void 0 && pkg.exports !== null) {
    const entry = resolveExports(pkg.exports, subpath, conditions);
    if (entry) return entry;
    return null;
  }
  if (subpath === ".") {
    if (conditions.includes("module") && pkg.module) return pkg.module;
    if (pkg.main) return pkg.main;
    return null;
  }
  return subpath;
}
function packageSelfReferenceSubpath(pkg, specifier) {
  if (!pkg || typeof pkg.name !== "string" || pkg.name.length === 0) return null;
  if (pkg.exports === void 0 || pkg.exports === null) return null;
  if (specifier === pkg.name) return ".";
  if (!specifier.startsWith(`${pkg.name}/`)) return null;
  return `.${specifier.slice(pkg.name.length)}`;
}

var NON_MAPPING_EXTENSION = /\.(ts|tsx|mts|cts|json|node|cjs)$/;
function typescriptFallbackCandidates(base) {
  if (NON_MAPPING_EXTENSION.test(base)) return [];
  if (base.endsWith(".mjs")) return [base.slice(0, -4) + ".mts"];
  if (base.endsWith(".js")) {
    const stem = base.slice(0, -3);
    return [stem + ".ts", stem + ".tsx"];
  }
  return [base + ".ts", base + ".tsx"];
}
var TYPESCRIPT_INDEX_CANDIDATES = ["/index.ts", "/index.tsx"];

function presentedCredential(value) {
  const trimmed = value.trim();
  return /^bearer\s+/i.test(trimmed) ? trimmed.replace(/^bearer\s+/i, "") : trimmed;
}

/** Conditions for runtime CJS resolution (user-shell node). */
const __NIMBUS_CJS_CONDITIONS = ["require", "node", "default"];

/**
 * Read and parse a package.json from VFS. Returns null on miss/parse-fail.
 */
function __readPkgJson(pkgDir) {
  const s = __readFileOr(pkgDir + "/package.json", null);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Resolve a single subpath inside an installed package (pkgDir).
 *   - subpath: '.' for root entry, './foo' for explicit subpath, etc.
 *   - Honours pkg.exports (subpath maps, wildcards, conditions).
 *   - Falls back to module/main for root, raw subpath probing otherwise.
 *   - Final filesystem probe via __resolveFile (extension list).
 *
 * Returns a VFS-relative path to the resolved file, or null.
 */
function __resolvePkgSubpath(pkgDir, pkg, subpath) {
  if (!pkg) pkg = __readPkgJson(pkgDir);
  if (!pkg) {
    // No package.json — try direct probe
    if (subpath === ".") return __resolveFile(pkgDir + "/index");
    return __resolveFile(pkgDir + "/" + subpath.replace(/^\.\/+/, ""));
  }
  let entry = resolvePackageEntry(pkg, subpath, __NIMBUS_CJS_CONDITIONS);
  // X.5-F R3: ESM-condition fallback for pure-ESM packages whose
  // dist/.mjs files were transformed to CJS
  // by transformEsmInBundle (facets/manager.ts). Without this,
  // packages like nuxt — whose exports map only contains
  // {types, import} for the root subpath — return null from the CJS
  // walk and dead-end with "Cannot find module 'nuxt'" even though
  // dist/index.mjs is in the bundle and runnable as CJS. We only fall
  // back when the package actually declares an exports map (so we
  // don't shadow legit "package not installed" misses).
  if (entry == null && pkg.exports != null) {
    entry = resolvePackageEntry(pkg, subpath, DEFAULT_ESM_CONDITIONS);
  }
  if (entry != null) {
    // Strip leading ./ from the resolver result
    const stripped = entry.replace(/^\.\/+/, "");
    const resolved = __resolveFile(pkgDir + "/" + stripped);
    if (resolved) return resolved;
    // W2.6a D2: exports/main yielded a target but the file doesn't exist
    // in the bundle (capped out, or the package mis-declares its main).
    // Fall through to the direct-probe path so we get index.js when the
    // declared entry is missing. Without this fallback, packages whose
    // exports point at a file evicted by the content cap return null and
    // the require chain dead-ends with "Cannot find module" — even though
    // a perfectly good index.js sits next to it.
  }
  // Fallback: probe the directory for a usable entry. This catches
  //   (a) exports map yielded null (forbidden / no condition matched)
  //   (b) exports map yielded a path whose file isn't on disk
  //   (c) main yielded a path whose file isn't on disk
  if (subpath === ".") {
    // Try main again under the extension-list resolver, then fall through
    // to /index probing. The shared resolvePackageEntry already prefers
    // exports → module → main, so re-probing main here only triggers when
    // entry was null OR entry's file was missing.
    if (typeof pkg.main === 'string') {
      const mainStripped = pkg.main.replace(/^\.\/+/, "");
      const r = __resolveFile(pkgDir + "/" + mainStripped);
      if (r) return r;
    }
    return __resolveFile(pkgDir + "/index");
  }
  const rel = subpath.replace(/^\.\/+/, "");
  return __resolveFile(pkgDir + "/" + rel);
}


/**
 * Resolve a bare specifier (e.g. "react", "@scope/pkg", "pkg/sub/path")
 * by walking up node_modules from fromDir. Returns the resolved file or null.
 */
function __resolveNodeModule(name, fromDir) {
  // Split into pkgName + subpath
  let pkgName, subpath;
  if (name.startsWith("@")) {
    const parts = name.split("/");
    if (parts.length < 2) return null;
    pkgName = parts.slice(0, 2).join("/");
    subpath = parts.length > 2 ? "./" + parts.slice(2).join("/") : ".";
  } else {
    const slashIdx = name.indexOf("/");
    if (slashIdx > 0) {
      pkgName = name.substring(0, slashIdx);
      subpath = "./" + name.substring(slashIdx + 1);
    } else {
      pkgName = name;
      subpath = ".";
    }
  }

  // Walk up directories looking for node_modules/<pkgName>.
  // Audit §3.7 (P7 fastify case): the prior loop was right, but the
  // visited-set keyed on dir-with-leading-slash-stripped while node_modules
  // existence checks used the same form, so iteration COULD terminate early
  // when hitting "" (empty string) at the root. Explicit termination on
  // empty string + always-also-check root node_modules covers both.
  let dir = (fromDir || "").replace(/^\/+/, "");
  const visited = new Set();
  while (true) {
    if (visited.has(dir)) break;
    visited.add(dir);
    const nmDir = (dir ? dir + "/" : "") + "node_modules/" + pkgName;
    if (__fileExists(nmDir)) {
      const resolved = __resolvePkgSubpath(nmDir, null, subpath);
      if (resolved) return resolved;
    }
    if (!dir) break;
    const lastSlash = dir.lastIndexOf("/");
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : "";
  }
  return null;
}

/**
 * Node's "package scope" of a directory (readPackageScope): the nearest
 * enclosing package.json, walking up from fromDir. The FIRST package.json
 * found is the scope, even when it lacks the field the caller wants — the
 * imports field and the self-reference rule both belong to the importing
 * module's own package, never to an ancestor past it. The walk never
 * crosses a node_modules directory: a file that sits directly under one
 * belongs to no package, not to the project above it. Returns { dir, pkg }
 * (pkg null when the file is unparseable) or null when no package.json
 * encloses fromDir.
 */
function __nearestPackageScope(fromDir) {
  let dir = (fromDir || "").replace(/^\/+/, "");
  while (true) {
    if (dir === "node_modules" || dir.endsWith("/node_modules")) return null;
    const pkgJsonPath = (dir ? dir + "/" : "") + "package.json";
    if (__fileExists(pkgJsonPath)) {
      return { dir, pkg: __readPkgJson(dir) };
    }
    if (!dir) return null;
    const lastSlash = dir.lastIndexOf("/");
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : "";
  }
}

/**
 * Resolve a #name imports-field specifier from the nearest enclosing
 * package.json. Returns the resolved file or null.
 */
function __resolveImportsField(name, fromDir) {
  // First package.json wins, even if no imports field (Node spec: imports
  // field of the importing module's package).
  const scope = __nearestPackageScope(fromDir);
  if (!scope || !scope.pkg || !scope.pkg.imports) return null;
  const dir = scope.dir;
  const target = resolveExports(scope.pkg.imports, name, __NIMBUS_CJS_CONDITIONS);
  if (!target) return null;
  // Imports targets are relative to the package root (dir)
  if (target.startsWith("./")) {
    return __resolveFile((dir ? dir + "/" : "") + target.slice(2));
  }
  if (target.startsWith("/")) {
    return __resolveFile(target.slice(1));
  }
  // Bare specifier — re-resolve as a node_module from this dir
  return __resolveNodeModule(target, dir);
}

/**
 * Node's LOAD_PACKAGE_SELF: a bare specifier naming the enclosing package
 * itself (`require('<its-name>')`, `require('<its-name>/sub')`) resolves
 * through that package's own `exports` map — only when the nearest
 * package.json has `exports` AND its `name` matches, and only through
 * `exports` (no main/index probing: a subpath the map does not expose is
 * not exported). Sits between the imports-field branch and the
 * node_modules walk, where Node puts it. Returns the resolved file or null.
 *
 * Conditions are the ones the node_modules walk uses for the same
 * require: the runtime's CJS set first, the ESM set when the map exposes
 * the subpath only under `import` (dynamic import() is lowered onto this
 * require chain, see __resolvePkgSubpath).
 *
 * Tri-state, as in Node: null when the rule does not apply (the caller
 * walks node_modules); { resolved: null } when the enclosing package claims
 * the name but its map does not expose the subpath or the target is
 * missing — Node throws ERR_PACKAGE_PATH_NOT_EXPORTED / MODULE_NOT_FOUND
 * there and never consults node_modules, so neither does the caller.
 */
function __resolvePackageSelf(name, fromDir) {
  const scope = __nearestPackageScope(fromDir);
  if (!scope || !scope.pkg) return null;
  const subpath = packageSelfReferenceSubpath(scope.pkg, name);
  if (subpath === null) return null;
  let entry = resolveExports(scope.pkg.exports, subpath, __NIMBUS_CJS_CONDITIONS);
  if (entry == null) entry = resolveExports(scope.pkg.exports, subpath, DEFAULT_ESM_CONDITIONS);
  if (entry == null) return { resolved: null };
  return { resolved: __resolveFile((scope.dir ? scope.dir + "/" : "") + entry.replace(/^\.\/+/, "")) };
}

function __exportsTarget(mod) {
  const value = mod.exports;
  if (value && (typeof value === "object" || typeof value === "function")) return value;
  return Object(value);
}

function __isTdzExportRead(error) {
  const message = error && typeof error.message === "string"
    ? error.message
    : String(error);
  return message.includes("before initialization") ||
    message.includes("Cannot read properties of undefined (reading");
}

function __makeLoadingExports(mod) {
  return new Proxy({}, {
    get(_target, prop) {
      try {
        return Reflect.get(__exportsTarget(mod), prop);
      } catch (error) {
        if (__isTdzExportRead(error)) return undefined;
        throw error;
      }
    },
    set(_target, prop, value) {
      if (!mod.exports || (typeof mod.exports !== "object" && typeof mod.exports !== "function")) {
        mod.exports = {};
      }
      return Reflect.set(mod.exports, prop, value);
    },
    has(_target, prop) {
      return Reflect.has(__exportsTarget(mod), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(__exportsTarget(mod));
    },
    getOwnPropertyDescriptor(_target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(__exportsTarget(mod), prop);
      return desc ? { ...desc, configurable: true } : undefined;
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(__exportsTarget(mod));
    },
  });
}

/**
 * Load and execute a JS/JSON module from VFS.
 * Returns the module.exports value.
 *
 * A JS module is one of the launch's module cells: the guest's registry
 * compiles it the first time it is required (core/_shared/commonjs-cell.ts),
 * and this calls the wrapper function it exports with the scoped require.
 * Nothing here compiles source: request-time code generation is not
 * available in a Worker, so a file the launch did not map cannot run.
 */
// import.meta of the module file at `filename`, evaluated as `url`: an
// entry script's or a loaded module's. It lives on the module, not in source
// text, so the five CommonJS arguments stay as they are, and
// import.meta.resolve keeps its parent even when extracted and called later.
// The registry's own import.meta cannot serve: its module URLs all live
// under file:///bundle/, never at the file's own path. dirname and filename
// name the file, without the URL's query or fragment.
function __nimbusFileImportMeta(filename, url = builtins.url.pathToFileURL(filename).href) {
  return Object.assign(Object.create(null), {
    dirname: __pathMod.dirname(filename),
    filename,
    url,
    resolve: (specifier) => globalThis.__nimbusImportMetaResolve(specifier, url),
  });
}

// `required`: loaded by a require() call, not by an ES module's static
// import, which the lowering makes a call of the module's own require.
function __loadModule(resolvedPath, evaluationKey = resolvedPath, required = true) {
  if (globalThis.__nimbusProfileStaged) globalThis.__nimbusProfileStaged.delete(String(resolvedPath).replace(/^\/+/, ""));
  if (__moduleCache.has(evaluationKey)) return __moduleCache.get(evaluationKey);

  const mod = { exports: {} };
  __moduleCache.set(evaluationKey, __makeLoadingExports(mod));

  // JSON
  if (resolvedPath.endsWith(".json")) {
    const code = __readFileOr(resolvedPath, null);
    if (code === null) throw new Error("Cannot read module: " + resolvedPath);
    mod.exports = JSON.parse(code);
    __moduleCache.set(evaluationKey, mod.exports);
    return mod.exports;
  }

  // JS — the cell's wrapper, called with a scoped require
  const modDir = resolvedPath.includes("/") ? resolvedPath.substring(0, resolvedPath.lastIndexOf("/")) : ".";
  // A lowered ES module calls its require for its static imports only: it
  // has no require of its own (module-format.ts ES_MODULE_UNBOUND_NAMES).
  const esModule = __nimbusModuleCellIsEsModule(resolvedPath.replace(/^\/+/, ""));
  const scopedRequire = (id) => __requireFrom(id, modDir, !esModule);
  scopedRequire.resolve = (id) => {
    const r = __resolveFrom(id, modDir);
    if (!r) throw new Error("Cannot resolve '" + id + "'");
    return r;
  };
  scopedRequire.cache = __moduleCache;
  scopedRequire.main = __require.main;
  mod.require = scopedRequire;

  // X.5-M3: thread currently-loading module path through globalThis so the
  // URL shim null-base fallback (in node-shims url module) can compose
  // relative URLs against the real module location — synthesizing
  // import.meta.url semantics for ESM that esbuild CJS-emit reduced to
  // const import_meta = {}. Save+restore for recursive __loadModule.
  const __prevModulePath = globalThis.__currentModulePath;
  globalThis.__currentModulePath = resolvedPath;
  const moduleUrl = evaluationKey.startsWith("file:")
    ? evaluationKey : builtins.url.pathToFileURL("/" + resolvedPath).href;
  Object.defineProperty(mod, "__nimbusImportMeta", { value: __nimbusFileImportMeta("/" + resolvedPath, moduleUrl) });
  try {
    const normalizedPath = resolvedPath.replace(/^\/+/, "");
    let cell = __nimbusModuleCell(normalizedPath);
    if (!cell) {
      // Not in the launch's map: written after it started, or not reached by
      // its closure. Kept apart from the read ledger, which settles reads. By
      // path, the next launch stages the file if it is still there; by
      // content, this text wherever it was written (a fresh name each run
      // included) — core/_shared/commonjs-cell.ts, RUNTIME CODE. A content
      // key the launch already carries answers now.
      (globalThis.__nimbusModuleMisses ??= new Set()).add(normalizedPath);
      if (typeof __nimbusNotifyRuntimeCode === "function") __nimbusNotifyRuntimeCode();
      const text = __readFileOr(resolvedPath, null);
      if (text === null) throw new Error("Cannot load module '" + resolvedPath + "': it was not in this launch's module map; the next launch of the same command stages it.");
      cell = __nimbusRuntimeModule(normalizedPath, text);
      globalThis.__nimbusModuleMisses.delete(normalizedPath);
    }
    const evaluation = cell(mod.exports, scopedRequire, mod, "/" + resolvedPath, "/" + modDir);
    // A module with top-level await completes later. require() returns its
    // exports now (static imports lowered to require cannot wait); import()
    // waits for it (__esmLoad).
    if (evaluation && typeof evaluation.then === "function") __moduleEvaluations.set(evaluationKey, evaluation);
  } catch (e) {
    __moduleCache.delete(evaluationKey);
    // A ReferenceError for a CommonJS name is the module loader's to explain
    // where it leaves an ES module's job, and nothing else's: a require() of
    // an ES module is that module's job (Node's ModuleJobSync).
    if (__nimbusIsCommonJSGlobalLikeError(e)) {
      if (required && esModule) __nimbusExplainCommonJSGlobalLike(e, moduleUrl, false);
      throw e;
    }
    if (e && typeof e === "object" && !e.__nimbusModulePath) {
      try {
        Object.defineProperty(e, "__nimbusModulePath", { value: resolvedPath, configurable: true, writable: true });
        const at = resolvedPath.lastIndexOf("node_modules/");
        const parts = at < 0 ? [] : resolvedPath.slice(at + 13).split("/");
        const pkg = parts[0] && parts[0].startsWith("@") ? parts[0] + "/" + parts[1] : parts[0];
        const advisory = pkg ? __nimbusAbiAdvisories.get(pkg) : undefined;
        const note = "\nNimbus module: " + resolvedPath
          + (advisory ? "\nNimbus: " + pkg + " has no Workers-compatible build: " + advisory : "");
        if (typeof e.message === "string") e.message += note;
        if (typeof e.stack === "string" && !e.stack.includes("Nimbus module:")) e.stack += note;
      } catch {}
    }
    throw e;
  } finally {
    globalThis.__currentModulePath = __prevModulePath;
  }

  // Update cache with final exports (module.exports may have been reassigned)
  __moduleCache.set(evaluationKey, mod.exports);
  return mod.exports;
}

/**
 * Resolve a module ID from a given directory.
 * Returns the resolved VFS path, or null.
 */
function __resolveFrom(id, fromDir) {
  // An absolute file: URL is a specifier Node accepts: `import(href)` is the
  // portable way to load a path a resolver just handed back, and it is what
  // every package that resolves before it imports emits — @nuxt/cli's
  // loadKit does `import(pathToFileURL(resolveModulePath('@nuxt/kit', …)).href)`.
  // The ESM→CJS transform funnels those imports through this one resolver, so
  // the scheme has to come off before the specifier is classified: with it on,
  // the file: URL misses the absolute-path branch below and gets looked up as
  // if it were the name of a package.
  if (typeof id === "string" && id.startsWith("file:")) {
    let filePath;
    try {
      const u = new URL(id);
      // .pathname drops the query a cache-busting importer appends
      // (`import(href + "?t=" + Date.now())` is the standard HMR spelling),
      // and the decode is what node:url's fileURLToPath does with it.
      filePath = decodeURIComponent(u.pathname);
    } catch { filePath = id.replace(/^file:\/\//, ""); }
    id = filePath;
  }
  // X.5-P: literal "." / ".." are CommonJS aliases for "./" / "../".
  // Pre-fix they slipped past the startsWith("./")/("../") guards (which
  // require >= 3 / >= 4 chars respectively) and fell into the bare-spec
  // branch — querying __resolveNodeModule for a package literally named
  // "." → "Cannot find module '.'" (verify-90993b3 §3 bucket P:
  // fastify via ajv/dist/compile/jtd, redis via @redis/client/dist/lib/client).
  // Normalize so they take the relative-resolve branch (which then probes
  // index.js / package.json#main via __resolveFile). See
  if (id === ".") id = "./";
  else if (id === "..") id = "../";
  // Relative path
  if (id.startsWith("./") || id.startsWith("../") || id.startsWith("/")) {
    let base;
    if (id.startsWith("/")) {
      base = id.replace(/^\/+/, "");
    } else {
      // VFS paths are stored without leading /. __pathMod.resolve treats
      // a non-absolute fromDir as relative-to-cwd which would corrupt the
      // result (audit §3.7-bug). Force-absolutise fromDir before resolving,
      // then strip the leading / again.
      const absFromDir = fromDir.startsWith("/") ? fromDir : "/" + fromDir;
      base = __pathMod.resolve(absFromDir, id).replace(/^\/+/, "");
    }
    return __resolveFile(base);
  }
  // imports field (#name)
  if (id.startsWith("#")) {
    return __resolveImportsField(id, fromDir);
  }
  // Bare specifier: the enclosing package's own name resolves through its
  // exports map (Node's LOAD_PACKAGE_SELF), then node_modules resolution.
  // Once the enclosing package claims the name, its map is the whole
  // answer: a subpath it does not expose is not found, never a
  // node_modules copy's.
  const self = __resolvePackageSelf(id, fromDir);
  if (self) return self.resolved;
  return __resolveNodeModule(id, fromDir);
}

// ═══════════════════════════════════════════════════════════════════════
// ──  import() — Node's ESM loader ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// A cell's dynamic import() reaches here with its module's URL
// (core/runtime/dynamic-import-rewrite.ts). Resolution is Node's ESM
// algorithm (core/_shared/esm-resolver.ts, interpolated below): the "import"
// conditions, no extension probing, a directory refused by name, file: URLs,
// Node's error codes and messages. What resolves loads through the same
// module cache require uses, shaped as the namespace Node would give.
// Node's builtins that exist only with the scheme; the rest of the table is
// the process's own builtins, undici among them, which the process provides
// in place of any installed copy (see builtins.undici above).
const __ESM_SCHEME_ONLY_BUILTINS = new Set(["test", "test/reporters", "sqlite", "sea"]);
// Node's ESM resolver (core/_shared/esm-resolver.ts, compiled once by
// scripts/bundle-facet-workers.mjs): declares createEsmResolver.
function createEsmResolver(host) {
  const conditions =   new Set(["node", "import", "module-sync"]);
  const ask = {
    *kind(path) {
      const kind = yield host.kind(path);
      return kind === "file" || kind === "directory" ? kind : null;
    },
    *readText(path) {
      const text = yield host.readText(path);
      return typeof text === "string" ? text : null;
    },
    *realpath(path) {
      const real = yield host.realpath(path);
      return typeof real === "string" ? real : path;
    },
    *cjsResolve(specifier, parentPath) {
      const found = yield host.cjsResolve(specifier, parentPath);
      return typeof found === "string" ? found : null;
    }
  };
  function codedError(Ctor, code, message) {
    return Object.assign(new Ctor(message), { code });
  }
  const codeOf = (error) => error !== null && typeof error === "object" && "code" in error ? error.code : void 0;
  const filePath = (url) => decodeURIComponent(new URL(String(url)).pathname);
  const fileUrl = (path) => {
    const url = new URL("file://");
    url.pathname = path;
    return url;
  };
  function isRelativeSpecifier(specifier) {
    if (specifier[0] !== ".") return false;
    if (specifier.length === 1 || specifier[1] === "/") return true;
    return specifier[1] === "." && (specifier.length === 2 || specifier[2] === "/");
  }
  const isRelativeOrAbsolute = (specifier) => specifier !== "" && (specifier[0] === "/" || isRelativeSpecifier(specifier));
  function* readPackageConfig(pjsonPath, specifier, base) {
    const text = (yield* ask.kind(pjsonPath)) === "file" ? yield* ask.readText(pjsonPath) : null;
    if (text === null) return { exists: false, pjsonPath, type: "none" };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw codedError(
        Error,
        "ERR_INVALID_PACKAGE_CONFIG",
        `Invalid package config ${pjsonPath}` + (base ? ` while importing ${JSON.stringify(specifier)} from ${base}` : "") + "."
      );
    }
    const config = { exists: true, pjsonPath, type: "none" };
    if (parsed === null || typeof parsed !== "object") return config;
    if (typeof parsed.name === "string") config.name = parsed.name;
    if (typeof parsed.main === "string") config.main = parsed.main;
    if ("exports" in parsed) config.exports = parsed.exports;
    if (parsed.imports !== null && typeof parsed.imports === "object") config.imports = parsed.imports;
    if (parsed.type === "module" || parsed.type === "commonjs") config.type = parsed.type;
    return config;
  }
  function* packageScopeConfig(resolved) {
    let pjsonUrl = new URL("./package.json", resolved);
    while (true) {
      if (pjsonUrl.pathname.endsWith("node_modules/package.json")) break;
      const config = yield* readPackageConfig(filePath(pjsonUrl), resolved.href, void 0);
      if (config.exists) return config;
      const last = pjsonUrl;
      pjsonUrl = new URL("../package.json", pjsonUrl);
      if (pjsonUrl.pathname === last.pathname) break;
    }
    return { exists: false, pjsonPath: filePath(pjsonUrl), type: "none" };
  }
  function invalidPackageTarget(key, target, pjsonUrl, internal, base) {
    const text = typeof target === "object" && target !== null ? JSON.stringify(target, null, "") : `${target}`;
    const pkgPath = filePath(new URL(".", pjsonUrl));
    const related = !internal && text.length > 0 && !text.startsWith("./");
    const tail = `in the package config ${pkgPath}package.json imported from ${base}${related ? '; targets must start with "./"' : ""}`;
    return codedError(
      Error,
      "ERR_INVALID_PACKAGE_TARGET",
      key === "." ? `Invalid "exports" main target ${JSON.stringify(text)} defined ${tail}` : `Invalid "${internal ? "imports" : "exports"}" target ${JSON.stringify(text)} defined for '${key}' ${tail}`
    );
  }
  const invalidSegment = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))?(\\|\/|$)/i;
  const deprecatedInvalidSegment = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/i;
  function* resolveTargetString(target, subpath, match, pjsonUrl, base, pattern, internal, isPathMap) {
    if (subpath !== "" && !pattern && target[target.length - 1] !== "/") {
      throw invalidPackageTarget(match, target, pjsonUrl, internal, base);
    }
    if (!target.startsWith("./")) {
      if (internal && !target.startsWith("../") && !target.startsWith("/")) {
        let isUrl = false;
        try {
          new URL(target);
          isUrl = true;
        } catch {
        }
        if (!isUrl) {
          const exportTarget = pattern ? target.replace(/\*/g, () => subpath) : target + subpath;
          return yield* packageResolve(exportTarget, pjsonUrl.href);
        }
      }
      throw invalidPackageTarget(match, target, pjsonUrl, internal, base);
    }
    if (invalidSegment.test(target.slice(2)) && deprecatedInvalidSegment.test(target.slice(2))) {
      throw invalidPackageTarget(match, target, pjsonUrl, internal, base);
    }
    const resolved = new URL(target, pjsonUrl);
    if (!resolved.pathname.startsWith(new URL(".", pjsonUrl).pathname)) {
      throw invalidPackageTarget(match, target, pjsonUrl, internal, base);
    }
    if (subpath === "") return resolved;
    if (invalidSegment.test(subpath) && deprecatedInvalidSegment.test(subpath) && !isPathMap) {
      const request = pattern ? match.replace("*", () => subpath) : match + subpath;
      throw codedError(
        TypeError,
        "ERR_INVALID_MODULE_SPECIFIER",
        `Invalid module "${request}" request is not a valid match in pattern "${match}" for the "${internal ? "imports" : "exports"}" resolution of ${filePath(pjsonUrl)} imported from ${base}`
      );
    }
    if (pattern) return new URL(resolved.href.replace(/\*/g, () => subpath));
    return new URL(subpath, resolved);
  }
  function* resolveTarget(pjsonUrl, target, subpath, key, base, pattern, internal, isPathMap) {
    if (typeof target === "string") {
      return yield* resolveTargetString(target, subpath, key, pjsonUrl, base, pattern, internal, isPathMap);
    }
    if (Array.isArray(target)) {
      if (target.length === 0) return null;
      let lastException;
      for (const item of target) {
        let result;
        try {
          result = yield* resolveTarget(pjsonUrl, item, subpath, key, base, pattern, internal, isPathMap);
        } catch (error) {
          lastException = error;
          if (codeOf(error) === "ERR_INVALID_PACKAGE_TARGET") continue;
          throw error;
        }
        if (result === void 0) continue;
        if (result === null) {
          lastException = null;
          continue;
        }
        return result;
      }
      if (lastException === void 0 || lastException === null) return lastException;
      throw lastException;
    }
    if (typeof target === "object" && target !== null) {
      const keys = Object.getOwnPropertyNames(target);
      for (const condition of keys) {
        if (/^\d+$/.test(condition) && String(Number(condition)) === condition && Number(condition) < 4294967295) {
          throw codedError(
            Error,
            "ERR_INVALID_PACKAGE_CONFIG",
            `Invalid package config ${filePath(pjsonUrl)} while importing ${fileUrl(base).href}. "exports" cannot contain numeric property keys.`
          );
        }
      }
      for (const condition of keys) {
        if (condition !== "default" && !conditions.has(condition)) continue;
        const result = yield* resolveTarget(
          pjsonUrl,
          Reflect.get(target, condition),
          subpath,
          key,
          base,
          pattern,
          internal,
          isPathMap
        );
        if (result === void 0) continue;
        return result;
      }
      return void 0;
    }
    if (target === null) return null;
    throw invalidPackageTarget(key, target, pjsonUrl, internal, base);
  }
  function patternKeyCompare(a, b) {
    const aStar = a.indexOf("*");
    const bStar = b.indexOf("*");
    const baseA = aStar === -1 ? a.length : aStar + 1;
    const baseB = bStar === -1 ? b.length : bStar + 1;
    if (baseA > baseB) return -1;
    if (baseB > baseA) return 1;
    if (aStar === -1) return 1;
    if (bStar === -1) return -1;
    if (a.length > b.length) return -1;
    if (b.length > a.length) return 1;
    return 0;
  }
  function bestPattern(map, name) {
    let best = "";
    let bestSubpath = "";
    for (const key of Object.getOwnPropertyNames(map)) {
      const star = key.indexOf("*");
      if (star === -1 || !name.startsWith(key.slice(0, star))) continue;
      const trailer = key.slice(star + 1);
      if (name.length >= key.length && name.endsWith(trailer) && patternKeyCompare(best, key) === 1 && key.lastIndexOf("*") === star) {
        best = key;
        bestSubpath = name.slice(star, name.length - trailer.length);
      }
    }
    return best ? { key: best, subpath: bestSubpath } : null;
  }
  function exportsNotFound(subpath, pjsonUrl, base) {
    const pkgPath = filePath(new URL(".", pjsonUrl));
    return codedError(
      Error,
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
      subpath === "." ? `No "exports" main defined in ${pkgPath}package.json imported from ${base}` : `Package subpath '${subpath}' is not defined by "exports" in ${pkgPath}package.json imported from ${base}`
    );
  }
  function* packageExportsResolve(pjsonUrl, subpath, config, base) {
    let exports = config.exports;
    const isSugar = (() => {
      if (typeof exports === "string" || Array.isArray(exports)) return true;
      if (typeof exports !== "object" || exports === null) return false;
      let sugar = false;
      let i = 0;
      for (const key of Object.getOwnPropertyNames(exports)) {
        const current = key === "" || key[0] !== ".";
        if (i++ === 0) sugar = current;
        else if (sugar !== current) {
          throw codedError(
            Error,
            "ERR_INVALID_PACKAGE_CONFIG",
            `Invalid package config ${filePath(pjsonUrl)} while importing ${fileUrl(base).href}. "exports" cannot contain some keys starting with '.' and some not. The exports object must either be an object of package subpath keys or an object of main entry condition name keys only.`
          );
        }
      }
      return sugar;
    })();
    if (isSugar) exports = { ".": exports };
    const map = exports;
    if (Object.prototype.hasOwnProperty.call(map, subpath) && !subpath.includes("*") && !subpath.endsWith("/")) {
      const result = yield* resolveTarget(pjsonUrl, map[subpath], "", subpath, base, false, false, false);
      if (result == null) throw exportsNotFound(subpath, pjsonUrl, base);
      return result;
    }
    const best = bestPattern(map, subpath);
    if (best) {
      const result = yield* resolveTarget(pjsonUrl, map[best.key], best.subpath, best.key, base, true, false, subpath.endsWith("/"));
      if (result == null) throw exportsNotFound(subpath, pjsonUrl, base);
      return result;
    }
    throw exportsNotFound(subpath, pjsonUrl, base);
  }
  function* packageImportsResolve(name, baseUrl) {
    const base = filePath(baseUrl);
    if (name === "#" || name.startsWith("#/") || name.endsWith("/")) {
      throw codedError(TypeError, "ERR_INVALID_MODULE_SPECIFIER", `Invalid module "${name}" is not a valid internal imports specifier name imported from ${base}`);
    }
    const config = yield* packageScopeConfig(new URL(baseUrl));
    let pjsonUrl;
    if (config.exists) {
      pjsonUrl = fileUrl(config.pjsonPath);
      const imports = config.imports;
      if (imports) {
        if (Object.prototype.hasOwnProperty.call(imports, name) && !name.includes("*")) {
          const result = yield* resolveTarget(pjsonUrl, imports[name], "", name, base, false, true, false);
          if (result != null) return result;
        } else {
          const best = bestPattern(imports, name);
          if (best) {
            const result = yield* resolveTarget(pjsonUrl, imports[best.key], best.subpath, best.key, base, true, true, false);
            if (result != null) return result;
          }
        }
      }
    }
    const where = pjsonUrl ? ` in package ${filePath(new URL(".", pjsonUrl))}package.json` : "";
    throw codedError(TypeError, "ERR_PACKAGE_IMPORT_NOT_DEFINED", `Package import specifier "${name}" is not defined${where} imported from ${base}`);
  }
  function* legacyMainResolve(pjsonUrl, config, base) {
    const tries = [];
    if (config.main !== void 0) {
      for (const suffix of ["", ".js", ".json", ".node", "/index.js", "/index.json", "/index.node"]) tries.push(`./${config.main}${suffix}`);
    }
    tries.push("./index.js", "./index.json", "./index.node");
    for (const candidate of tries) {
      const url = new URL(candidate, pjsonUrl);
      if ((yield* ask.kind(filePath(url))) === "file") return url;
    }
    const dir = fileUrl(filePath(new URL(".", pjsonUrl)).replace(/\/+/g, "/"));
    const missing = filePath(new URL(config.main ?? "index.js", dir));
    throw codedError(Error, "ERR_MODULE_NOT_FOUND", `Cannot find package '${missing}' imported from ${base}`);
  }
  function* packageResolve(specifier, baseUrl) {
    if (host.isBuiltin(specifier)) return new URL("node:" + specifier);
    const base = filePath(baseUrl);
    let separator = specifier.indexOf("/");
    let valid = true;
    let scoped = false;
    if (specifier[0] === "@") {
      scoped = true;
      if (separator === -1 || specifier.length === 0) valid = false;
      else separator = specifier.indexOf("/", separator + 1);
    }
    const name = separator === -1 ? specifier : specifier.slice(0, separator);
    if (/^\.|%|\\/.test(name)) valid = false;
    if (!valid) {
      throw codedError(TypeError, "ERR_INVALID_MODULE_SPECIFIER", `Invalid module "${specifier}" is not a valid package name imported from ${base}`);
    }
    const subpath = "." + (separator === -1 ? "" : specifier.slice(separator));
    const self = yield* packageScopeConfig(new URL(baseUrl));
    if (self.exists && self.exports != null && self.name === name) {
      return yield* packageExportsResolve(fileUrl(self.pjsonPath), subpath, self, base);
    }
    let pjsonUrl = new URL("./node_modules/" + name + "/package.json", baseUrl);
    let pjsonPath = filePath(pjsonUrl);
    let lastPath;
    do {
      if ((yield* ask.kind(pjsonPath.slice(0, pjsonPath.length - 13))) !== "directory") {
        lastPath = pjsonPath;
        pjsonUrl = new URL((scoped ? "../../../../node_modules/" : "../../../node_modules/") + name + "/package.json", pjsonUrl);
        pjsonPath = filePath(pjsonUrl);
        continue;
      }
      const config = yield* readPackageConfig(pjsonPath, specifier, base);
      if (config.exports != null) return yield* packageExportsResolve(pjsonUrl, subpath, config, base);
      if (subpath === ".") return yield* legacyMainResolve(pjsonUrl, config, base);
      return new URL(subpath, pjsonUrl);
    } while (pjsonPath.length !== lastPath.length);
    throw codedError(Error, "ERR_MODULE_NOT_FOUND", `Cannot find package '${name}' imported from ${base}`);
  }
  function* formatOf(url, path) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot) : "";
    if (ext === ".mjs" || ext === ".mts") return "module";
    if (ext === ".cjs" || ext === ".cts") return "commonjs";
    if (ext === ".json") return "json";
    if (ext === ".js" || ext === ".ts" || ext === "") {
      const type = (yield* packageScopeConfig(url)).type;
      if (type === "module") return "module";
      if (type === "commonjs") return "commonjs";
      return "detect";
    }
    throw codedError(TypeError, "ERR_UNKNOWN_FILE_EXTENSION", `Unknown file extension "${ext}" for ${path}`);
  }
  function* finalizeResolution(resolved, baseUrl) {
    const base = filePath(baseUrl);
    if (/%2f|%5c/i.test(resolved.pathname)) {
      throw codedError(
        TypeError,
        "ERR_INVALID_MODULE_SPECIFIER",
        `Invalid module "${resolved.pathname}" must not include encoded "/" or "\\" characters imported from ${base}`
      );
    }
    const path = filePath(resolved);
    const kind = path.endsWith("/") ? "directory" : yield* ask.kind(path);
    if (kind === "directory") {
      throw Object.assign(
        codedError(Error, "ERR_UNSUPPORTED_DIR_IMPORT", `Directory import '${path}' is not supported resolving ES modules imported from ${base}`),
        { url: resolved.href }
      );
    }
    if (kind !== "file") {
      throw Object.assign(
        codedError(Error, "ERR_MODULE_NOT_FOUND", `Cannot find module '${path}' imported from ${base}`),
        { url: resolved.href }
      );
    }
    const real = yield* ask.realpath(path);
    const url = fileUrl(real);
    url.search = resolved.search;
    url.hash = resolved.hash;
    return { url: url.href, path: real };
  }
  function* moduleResolve(specifier, parentUrl) {
    let resolved;
    if (isRelativeOrAbsolute(specifier)) resolved = new URL(specifier, parentUrl);
    else if (specifier[0] === "#") resolved = yield* packageImportsResolve(specifier, parentUrl);
    else {
      try {
        resolved = new URL(specifier);
      } catch {
        resolved = yield* packageResolve(specifier, parentUrl);
      }
    }
    if (resolved.protocol === "node:") return { url: "node:" + resolved.pathname, builtin: resolved.pathname };
    if (resolved.protocol !== "file:") return { url: resolved.href };
    return yield* finalizeResolution(resolved, parentUrl);
  }
  function* loadable(resolved) {
    if (resolved.builtin !== void 0) {
      if (!host.isBuiltin("node:" + resolved.builtin)) {
        throw codedError(Error, "ERR_UNKNOWN_BUILTIN_MODULE", `No such built-in module: node:${resolved.builtin}`);
      }
      return { url: resolved.url, builtin: resolved.builtin, format: "builtin" };
    }
    if (resolved.url.startsWith("data:")) return { url: resolved.url, format: "data" };
    if (resolved.path === void 0) {
      throw codedError(
        Error,
        "ERR_UNSUPPORTED_ESM_URL_SCHEME",
        `Only URLs with a scheme in: file and data are supported by the default ESM loader. Received protocol '${new URL(resolved.url).protocol}'`
      );
    }
    return { url: resolved.url, path: resolved.path, format: yield* formatOf(new URL(resolved.url), resolved.path) };
  }
  function* commonJsHint(specifier, parentUrl) {
    let found = yield* ask.cjsResolve(specifier, filePath(parentUrl));
    if (found === null) return null;
    if (isRelativeSpecifier(specifier)) {
      const from = parentUrl.slice("file://".length, parentUrl.lastIndexOf("/")).split("/").filter(Boolean);
      const to = fileUrl(found).pathname.split("/").filter(Boolean);
      let common = 0;
      while (common < from.length && common < to.length && from[common] === to[common]) common++;
      found = [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
      if (!found.startsWith("../")) found = `./${found}`;
    } else if (specifier[0] && specifier[0] !== "/" && specifier[0] !== ".") {
      const slash = specifier.indexOf("/");
      const pkg = slash === -1 ? specifier : specifier.slice(0, slash);
      const needle = `/node_modules/${pkg}/`;
      const at = found.lastIndexOf(needle);
      found = at !== -1 ? pkg + "/" + found.slice(at + needle.length).split("/").map(encodeURIComponent).join("/") : fileUrl(found).href;
    }
    return found;
  }
  function* resolveWithHint(specifier, parentUrl) {
    try {
      return yield* moduleResolve(specifier, parentUrl);
    } catch (error) {
      const code = codeOf(error);
      if (error instanceof Error && (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNSUPPORTED_DIR_IMPORT")) {
        const asGiven = specifier.startsWith("file://") ? filePath(specifier) : specifier;
        const found = yield* commonJsHint(asGiven, parentUrl);
        if (found && found !== asGiven) error.message += `
Did you mean to import ${JSON.stringify(found)}?`;
      }
      throw error;
    }
  }
  function* importTarget(specifier, parentUrl) {
    return yield* loadable(yield* resolveWithHint(specifier, parentUrl));
  }
  function* metaResolve(specifier, parentUrl) {
    try {
      return (yield* moduleResolve(specifier, parentUrl)).url;
    } catch (error) {
      const code = codeOf(error);
      if ((code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNSUPPORTED_DIR_IMPORT") && error !== null && typeof error === "object" && "url" in error && typeof error.url === "string") return error.url;
      throw error;
    }
  }
  function runSync(steps) {
    let next = steps.next();
    while (!next.done) {
      if (next.value instanceof Promise) throw new Error("resolveSync: the host answered asynchronously");
      next = steps.next(next.value);
    }
    return next.value;
  }
  return {
    async resolve(specifier, parentUrl) {
      const steps = importTarget(specifier, parentUrl);
      let next = steps.next();
      while (!next.done) {
        let answer;
        try {
          answer = await next.value;
        } catch (error) {
          next = steps.throw(error);
          continue;
        }
        next = steps.next(answer);
      }
      return next.value;
    },
    resolveSync: (specifier, parentUrl) => runSync(importTarget(specifier, parentUrl)),
    metaResolveSync: (specifier, parentUrl) => runSync(metaResolve(specifier, parentUrl)),
    packageScopeSync(url) {
      const { pjsonPath, type } = runSync(packageScopeConfig(new URL(url)));
      return { pjsonPath, type };
    },
    validateAttributes(url, format, attributes) {
      for (const key of Object.keys(attributes)) {
        if (key !== "type") {
          throw codedError(TypeError, "ERR_IMPORT_ATTRIBUTE_UNSUPPORTED", `Import attribute "${key}" with value "${attributes[key]}" is not supported in ${url}`);
        }
      }
      const type = attributes.type;
      if (format === "json" || format === "data" && /^data:application\/json(?:;[^,]*)?,/.test(url)) {
        if (type === "json") return;
        if (!("type" in attributes)) {
          throw codedError(TypeError, "ERR_IMPORT_ATTRIBUTE_MISSING", `Module "${url}" needs an import attribute of "type: json"`);
        }
      } else if (type == null) {
        return;
      }
      if (typeof type !== "string") {
        throw codedError(TypeError, "ERR_INVALID_ARG_TYPE", `The "type" argument must be of type string. Received ${typeof type}`);
      }
      if (type !== "json") {
        throw codedError(TypeError, "ERR_IMPORT_ATTRIBUTE_UNSUPPORTED", `Import attribute "type" with value "${type}" is not supported in ${url}`);
      }
      throw codedError(TypeError, "ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE", `Module "${url}" is not of type "json"`);
    }
  };
}
const __esmResolver = createEsmResolver({
  kind(path) {
    const st = __fsMod.statSync(path, { throwIfNoEntry: false });
    return !st ? null : st.isDirectory() ? "directory" : st.isFile() ? "file" : null;
  },
  realpath(path) {
    try { return __fsMod.realpathSync(path); } catch { return path; }
  },
  readText(path) { return __readFileOr(path, null); },
  isBuiltin(specifier) {
    const scheme = specifier.startsWith("node:");
    const name = scheme ? specifier.slice(5) : specifier;
    if (!scheme && __ESM_SCHEME_ONLY_BUILTINS.has(name)) return false;
    return Object.prototype.hasOwnProperty.call(builtins, name);
  },
  cjsResolve(specifier, parentPath) {
    try {
      const dir = parentPath.slice(0, parentPath.lastIndexOf("/")).replace(/^\/+/, "");
      const found = __resolveFrom(specifier, dir);
      return found ? "/" + String(found).replace(/^\/+/, "") : null;
    } catch { return null; }
  },
});
const __esmNamespaces = new Map();
/** A module namespace: its names sorted, read through to the exports. */
function __esmNamespaceOf(names, read) {
  const ns = Object.create(null);
  for (const name of [...names].sort()) {
    Object.defineProperty(ns, name, { enumerable: true, get: () => read(name) });
  }
  Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
  return Object.preventExtensions(ns);
}
function __esmLoad(resolution) {
  const cached = __esmNamespaces.get(resolution.url);
  if (cached) return cached;
  let ns;
  if (resolution.format === "builtin") {
    const mod = __requireFrom("node:" + resolution.builtin, "");
    const names = new Set(mod && (typeof mod === "object" || typeof mod === "function") ? Object.keys(mod) : []);
    names.add("default");
    ns = __esmNamespaceOf(names, (name) => name === "default" ? mod : mod[name]);
  } else if (resolution.format === "data") {
    const url = new URL(resolution.url);
    const comma = url.pathname.indexOf(',');
    const header = url.pathname.slice(0, comma);
    const mediaType = header.split(';')[0].toLowerCase();
    const payload = url.pathname.slice(comma + 1);
    const text = header.split(';').includes('base64')
      ? __BufferMod.from(decodeURIComponent(payload), 'base64').toString('utf8') : decodeURIComponent(payload);
    if (mediaType === "application/json") {
      const value = JSON.parse(text);
      ns = __esmNamespaceOf(["default"], () => value);
    } else if (mediaType === "text/javascript" || mediaType === "application/javascript") {
      // A data URL produced at runtime is a module body, just like a written
      // file. It is staged by the same runtime-code service, retaining its URL
      // as the import base (relative imports from data URLs remain invalid).
      const cell = __nimbusRuntimeModule(resolution.url, text);
      const mod = { exports: {} };
      Object.defineProperty(mod, "__nimbusImportMeta", { value: {
        url: resolution.url,
        resolve: (id) => __nimbusImportMetaResolve(id, resolution.url),
      } });
      const requireData = (id) => {
        const resolved = __esmResolver.resolveSync(String(id), resolution.url);
        if (resolved.format === "builtin") return __requireFrom("node:" + resolved.builtin, "");
        if (resolved.path) return __loadModule(resolved.path.replace(/^\/+/, ""), resolved.url);
        throw Object.assign(new Error("Synchronous nested data-module import is unsupported"), { code: "ERR_REQUIRE_ASYNC_MODULE" });
      };
      let result;
      try {
        result = cell(mod.exports, requireData, mod, undefined, undefined);
      } catch (e) {
        __nimbusExplainCommonJSGlobalLike(e, resolution.url, false);
        throw e;
      }
      const namespace = () => __esmNamespaceOf(Object.keys(mod.exports).filter((n) => n !== "__esModule"), (n) => mod.exports[n]);
      if (result && typeof result.then === "function") {
        const pending = result.then(namespace, (error) => {
          __esmNamespaces.delete(resolution.url);
          __nimbusExplainCommonJSGlobalLike(error, resolution.url, true);
          throw error;
        });
        __esmNamespaces.set(resolution.url, pending);
        return pending;
      }
      ns = namespace();
    } else {
      throw Object.assign(new TypeError("Unsupported data module MIME type: " + mediaType), { code: "ERR_UNKNOWN_MODULE_FORMAT" });
    }
  } else {
    const key = resolution.path.replace(/^\/+/, "");
    // A typeless .js is the ES module the launch lowered, by its syntax.
    const esm = resolution.format === "module"
      || (resolution.format === "detect" && __nimbusModuleCellIsEsModule(key));
    // Canonical queryless ESM shares evaluation with require() and static
    // imports lowered to require(). Queries/fragments are distinct jobs.
    const variant = esm && (resolution.url.includes("?") || resolution.url.includes("#"));
    const evaluationKey = variant ? resolution.url : key;
    // The import is the module's job: what escapes its evaluation is
    // explained as Node's loader explains it.
    let exports;
    try {
      exports = __loadModule(key, evaluationKey, false);
    } catch (e) {
      __nimbusExplainCommonJSGlobalLike(e, resolution.url, false);
      throw e;
    }
    const namespace = () => {
      if (resolution.format === "json") return __esmNamespaceOf(["default"], () => exports);
      if (esm) {
        // The ESM→CJS transform's exports: the module's own names, live.
        const names = exports && typeof exports === "object" ? Object.keys(exports).filter((name) => name !== "__esModule") : [];
        return __esmNamespaceOf(names, (name) => exports[name]);
      }
      // CommonJS: module.exports is the default, its names the named exports.
      const mod = exports;
      const names = new Set(mod && (typeof mod === "object" || typeof mod === "function") ? Object.keys(mod) : []);
      names.delete("default");
      names.add("default");
      return __esmNamespaceOf(names, (name) => name === "default" ? mod : mod[name]);
    };
    // A module with top-level await: the import resolves once its evaluation
    // completes, and rejects with what it throws.
    const evaluation = __moduleEvaluations.get(evaluationKey);
    if (evaluation !== undefined) {
      const pending = evaluation.then(namespace, (error) => {
        __esmNamespaces.delete(resolution.url);
        __nimbusExplainCommonJSGlobalLike(error, resolution.url, true);
        throw error;
      });
      __esmNamespaces.set(resolution.url, pending);
      return pending;
    }
    ns = namespace();
  }
  __esmNamespaces.set(resolution.url, ns);
  return ns;
}
// A bundled copy of a package the runtime provides, bound to the runtime's
// (esbuild-service.ts rewriteProvidedCommonJsModules, PROVIDED_PACKAGE_HOOK):
// what require() serves for it, from any module, an ES module included.
globalThis.__nimbusProvidedPackage = (name) => __require(name);
globalThis.__nimbusDynamicImport = function __nimbusDynamicImport(parentUrl, specifier, options) {
  return Promise.resolve().then(() => {
    const text = String(specifier);
    const attributes = {};
    // V8's own checks and messages (node 22), which run before resolution.
    if (options !== undefined) {
      if (options === null || typeof options !== "object") throw new TypeError("The second argument to import() must be an object");
      const withAttributes = options.with;
      if (withAttributes !== undefined) {
        if (withAttributes === null || typeof withAttributes !== "object") throw new TypeError("The 'assert' option must be an object");
        for (const key of Object.keys(withAttributes)) {
          if (typeof withAttributes[key] !== "string") throw new TypeError("Import assertion value must be a string");
          attributes[key] = withAttributes[key];
        }
      }
    }
    const resolution = __esmResolver.resolveSync(text, parentUrl);
    __esmResolver.validateAttributes(resolution.url, resolution.format, attributes);
    return __esmLoad(resolution);
  });
};

// Node's import.meta.resolve, synchronous as in Node: the URL a specifier
// names, even for a file or directory that will not load.
globalThis.__nimbusImportMetaResolve = function __nimbusImportMetaResolve(specifier, parentUrl) {
  const parent = typeof parentUrl === "string" && parentUrl.startsWith("file:")
    ? parentUrl
    : "file:///" + String(globalThis.__currentModulePath || "[eval]").replace(/^\/+/, "");
  return __esmResolver.metaResolveSync(String(specifier), parent);
};

/**
 * Staged N-API bindings (PACKAGE_ABI_POLICY stagedArtifacts of kind
 * "binding"). A launch whose closure requires one carries the staged wasm
 * build in its module map and registers it on globalThis.__nimbusStagedBindings
 * under the package name the binding is required by. require() answers that
 * name from the registry ahead of node_modules: the published package of that
 * name (rolldown's wasm32-wasip1-threads build, or a platform shard) cannot
 * run in a Worker isolate.
 */
function __stagedBinding(id) {
  const registry = globalThis.__nimbusStagedBindings;
  return registry instanceof Map ? registry.get(id) : undefined;
}

function __loadStagedBinding(entry, fromDir) {
  if (entry.exports !== undefined) return entry.exports;
  // The binding is built from one upstream version. The package requiring it
  // must be that version, or its JavaScript and the binding disagree about
  // every class and option; a require from anywhere else has no version to
  // check against.
  const marker = "node_modules/" + entry.owner + "/";
  const dir = fromDir + "/";
  const at = dir.lastIndexOf(marker);
  if (at >= 0) {
    const manifest = "/" + dir.slice(0, at + marker.length) + "package.json";
    let version = null;
    try { version = JSON.parse(builtins.fs.readFileSync(manifest, "utf8")).version; } catch {}
    if (version !== entry.version) {
      throw new Error("Nimbus runs " + entry.owner + "'s N-API binding from a staged " + entry.version
        + " build; this process loaded " + entry.owner + "@" + version + " (" + manifest + "), which it"
        + " does not match. Install " + entry.owner + "@" + entry.version + ".");
    }
  }
  entry.exports = entry.create({
    fs: builtins.fs,
    env: builtins.process.env,
    writeStdout: (bytes) => builtins.process.stdout.write(bytes),
    writeStderr: (bytes) => builtins.process.stderr.write(bytes),
  });
  return entry.exports;
}

/**
 * require() from a specific directory context.
 * This is what each loaded module gets as its require function.
 */
function __requireFrom(id, fromDir, required = true) {
  // Check builtins first (always takes priority)
  if (builtins[id]) return builtins[id];
  if (id.startsWith("node:")) {
    const bare = id.substring(5);
    if (builtins[bare]) return builtins[bare];
  }
  const staged = __stagedBinding(id);
  if (staged) return __loadStagedBinding(staged, fromDir);

  const resolved = __resolveFrom(id, fromDir);
  if (!resolved) throw new Error("Cannot find module '" + id + "' (from " + fromDir + ")");

  return __loadModule(resolved, resolved, required);
}

function __requireBaseDir(specifier) {
  const text = String(specifier || "");
  const filePath = text.startsWith("file:")
    ? builtins.url.fileURLToPath(text)
    : text;
  const normalized = filePath.replace(/^\/+/, "");
  const fullPath = normalized || (dirname || cwd || "/home/user").replace(/^\/+/, "");
  const slash = fullPath.lastIndexOf("/");
  return slash >= 0 ? fullPath.substring(0, slash) : "";
}

function __makeRequire(fromDir) {
  const localRequire = (id) => __requireFrom(id, fromDir);
  localRequire.resolve = (id) => {
    if (__stagedBinding(id)) return id;
    const r = __resolveFrom(id, fromDir);
    if (!r) throw new Error("Cannot resolve '" + id + "'");
    return "/" + r;
  };
  localRequire.cache = __moduleCache;
  localRequire.main = __require.main;
  return localRequire;
}

/**
 * Top-level require() — resolves from cwd/dirname.
 * This is the require passed to the user's entry script.
 */
function __require(id) {
  return __requireFrom(id, dirname || cwd || "/home/user");
}
// An ES entry's own require: its static imports, part of its job.
function __nimbusEntryImport(id) {
  return __requireFrom(id, dirname || cwd || "/home/user", false);
}
// The program's entry evaluated as Node's loader runs it (manager.ts
// entryModule): a CommonJS entry with require(); an ES entry as a job of its
// own, its require its static imports, and what escapes its evaluation
// explained (__nimbusExplainCommonJSGlobalLike).
function __nimbusEvaluateEntry(wrapper, mod, filename, dirname, esModule) {
  if (!esModule) return wrapper(mod.exports, __require, mod, filename, dirname);
  const url = builtins.url.pathToFileURL(filename).href;
  let result;
  try {
    result = wrapper(mod.exports, __nimbusEntryImport, mod, filename, dirname);
  } catch (e) {
    __nimbusExplainCommonJSGlobalLike(e, url, false);
    throw e;
  }
  if (result && typeof result.then === "function") {
    return result.then(undefined, (e) => { __nimbusExplainCommonJSGlobalLike(e, url, true); throw e; });
  }
  return result;
}
__require.resolve = (id) => {
  if (__stagedBinding(id)) return id;
  const r = __resolveFrom(id, dirname || cwd || "/home/user");
  if (!r) throw new Error("Cannot resolve '" + id + "'");
  return "/" + r;
};
__require.cache = __moduleCache;
__require.main = null;

// ═══════════════════════════════════════════════════════════════════════
// ── END OF GENERATED SHIMS — closing marker ─────────────────────────
// (builtins block has been moved above the resolver functions)
// ═══════════════════════════════════════════════════════════════════════
