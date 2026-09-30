/**
 * Nimbus owns port numbers and request admission; workerd owns the Node HTTP
 * protocol and stream implementation. Inserted into the generated node shims.
 *
 * Platform contract: https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
 * and workerd v1.20260926.1 src/node/internal/internal_http_server.ts:
 * listen/close are patchable; handleAsNodeRequest dispatches through its
 * native port table; ephemeral ports are isolate-local. A native listen(0)
 * would therefore give every process the same first port (49152). Nimbus
 * allocates that number through the supervisor instead.
 *
 * No upgrade support is added: workerd's HTTP dispatcher emits request, not
 * upgrade. The separate Cirrus HMR bridge is not part of this path.
 */
export const NATIVE_HTTP_SOURCE = `
const __nativeHttpResponse = globalThis.Response;
const __nativeHttpRequest = globalThis.Request;
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
        globalThis.__nimbusOpenSockets = (globalThis.__nimbusOpenSockets || 0) + 1;
        response.once("close", () => {
          globalThis.__nimbusOpenSockets--;
          globalThis.__nimbusHandleReleased?.();
        });
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
      const captureResponse = (_request, response) => { nativeResponse = response; };
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
`;
