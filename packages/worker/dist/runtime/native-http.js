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
    const context = { ports, get supervisor() { return __supervisor; }, get pending() { return __pendingIO; } };
    globalThis.__nimbusHttpContext = context;
    const patchKey = Symbol.for("nimbus.native-http.patch");
    const ownerKey = Symbol.for("nimbus.native-http.owner");
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
      const listen = proto.listen, close = proto.close, ref = proto.ref, unref = proto.unref;
      Object.defineProperty(proto, patchKey, { value: true });
      proto.listen = function (...args) {
        const ctx = globalThis.__nimbusHttpContext;
        const [options, callback] = net._normalizeArgs(args);
        if (this.listening || this[ownerKey]?.pending) {
          const err = new Error("Listen method has been called more than once without closing.");
          err.code = "ERR_SERVER_ALREADY_LISTEN";
          throw err;
        }
        const state = { ctx, pending: false, cancelled: false, port: null };
        this[ownerKey] = state;
        const requested = options.port === undefined ? 0 : Number(options.port);
        const start = (port) => {
          state.pending = false;
          if (state.cancelled) {
            if (state.port !== null) ctx.pending.push(Promise.resolve(ctx.supervisor.unregisterPort(state.port)));
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
            if (requested === 0 && state.port !== null) ctx.pending.push(Promise.resolve(ctx.supervisor.unregisterPort(state.port)));
            if (e && e.code === "EADDRINUSE") { queueMicrotask(() => this.emit("error", e)); return; }
            throw e;
          }
        };
        if (requested === 0) {
          state.pending = true;
          const task = Promise.resolve(ctx.supervisor.allocatePort()).then(port => {
            state.port = port;
            start(port);
          }, error => { state.pending = false; this.emit("error", error); });
          ctx.pending.push(task);
        } else start(options.port);
        return this;
      };
      proto.close = function (callback) {
        const state = this[ownerKey];
        if (state) {
          state.cancelled = true;
          if (state.pending) {
            if (callback) queueMicrotask(() => callback());
            return this;
          }
          if (state.port !== null && state.ctx.ports.get(state.port) === this) {
            state.ctx.ports.delete(state.port);
            state.ctx.pending.push(Promise.resolve(state.ctx.supervisor.unregisterPort(state.port)));
          }
        }
        return Reflect.apply(close, this, callback ? [callback] : []);
      };
      proto.ref = function () { this.__nimbusUnrefed = false; return Reflect.apply(ref, this, []); };
      proto.unref = function () { this.__nimbusUnrefed = true; return Reflect.apply(unref, this, []); };
    }
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
