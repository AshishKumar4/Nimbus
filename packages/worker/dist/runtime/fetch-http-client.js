/** The HTTP client transport over fetch; native Node streams still own buffering and backpressure. */
export const FETCH_HTTP_CLIENT_SOURCE = String.raw `
function __nimbusInstallFetchHttpClient(http, https, url, Buffer, context) {
  const installed = Symbol.for("nimbus.http.fetch-client");
  if (http[installed]) { http[installed](context); return; }
  let activeContext = context;
  const NativeClientRequest = http.ClientRequest;
  const NativeIncomingMessage = http.IncomingMessage;
  const Writable = Object.getPrototypeOf(http.OutgoingMessage.prototype).constructor;
  const fail = (code, message, Base = Error) => nodeError(Base, code, message);
  const reset = (message) => Object.assign(new Error(message), { code: "ECONNRESET" });
  const abortError = (cause) => Object.assign(new Error("The operation was aborted", { cause }), { code: "ABORT_ERR", name: "AbortError" });
  const duration = (value) => {
    if (typeof value !== "number") throw invalidArgType("msecs", "number", value);
    if (!Number.isFinite(value) || value < 0) throw fail("ERR_OUT_OF_RANGE", 'The value of "msecs" is out of range. It must be a non-negative finite number. Received ' + value, RangeError);
    return Math.min(value, 2147483647);
  };
  const requestOptions = (input, options, callback) => {
    if (typeof input === "string") input = url.urlToHttpOptions(new URL(input));
    else if (input?.href && input.protocol && input.auth === undefined && input.path === undefined) input = url.urlToHttpOptions(input);
    else { callback = options; options = input; input = undefined; }
    if (typeof options === "function") { callback = options; options = input; }
    else options = { ...input, ...options };
    return [options || {}, callback];
  };
  const checkPath = (path) => {
    if (/[^\u0021-\u00ff]/.test(path)) throw fail("ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters", TypeError);
    if (/^(?:[/\\]{2}|[^/\\]*:)/.test(path)) throw fail("ERR_INVALID_ARG_VALUE", "options.path must be a path-only request target", TypeError);
  };
  class IncomingMessage extends NativeIncomingMessage {
    #reader;
    #reading = false;
    #idle;
    constructor(response, idle, joinDuplicateHeaders) {
      super();
      this.#idle = idle;
      this.statusCode = response.status;
      this.statusMessage = response.statusText;
      this.url = response.url;
      this.joinDuplicateHeaders = joinDuplicateHeaders;
      const headers = [];
      for (const [name, value] of response.headers) {
        if (name === "set-cookie") continue;
        headers.push(name, value);
      }
      for (const cookie of response.headers.getSetCookie()) headers.push("set-cookie", cookie);
      this._addHeaderLines(headers, headers.length);
      this.#reader = response.body?.getReader();
    }
    _read() {
      if (this.#reading) return;
      if (!this.#reader) { this.complete = true; this.push(null); return; }
      this.#reading = true;
      const pump = async () => {
        try {
          while (!this.destroyed) {
            const next = await this.#reader.read();
            if (this.destroyed) return;
            if (next.done) { this.complete = true; this.push(null); return; }
            this.#idle.touch();
            if (!this.push(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength))) return;
          }
        } catch (error) { this.destroy(error); }
        finally { this.#reading = false; }
      };
      void pump();
    }
    _destroy(error, callback) {
      if (!this.complete) { this.aborted = true; this.emit("aborted"); }
      const finish = () => callback(this.listenerCount("error") ? error : null);
      if (this.#reader) this.#reader.cancel(error).then(finish, finish);
      else finish();
    }
    setTimeout(msecs, callback) {
      this.#idle.setTimeout(msecs);
      if (callback) this.once("timeout", callback);
      return this;
    }
  }
  class ClientRequest extends http.OutgoingMessage {
    #context;
    #controller = new AbortController();
    #writer;
    #queued = false;
    #prepared;
    #deferred;
    #started = false;
    #timer;
    #incoming;
    #signal;
    #counted = false;
    #contentLength;
    #completeBody;
    #bytesWritten = 0;
    socket = null;
    connection = null;
    reusedSocket = false;
    aborted = false;
    maxHeadersCount = Infinity;
    constructor(input, options, callback) {
      super();
      this.#context = activeContext;
      [options, callback] = requestOptions(input, options, callback);
      const defaultAgent = options._defaultAgent || http.globalAgent;
      this.agent = options.agent === false ? new defaultAgent.constructor() : options.agent ?? defaultAgent;
      if (typeof this.agent === "object" && typeof this.agent.addRequest !== "function") throw invalidArgType("options.agent", ["Agent-like Object", "undefined", "false"], this.agent);
      const expected = this.agent?.protocol || defaultAgent.protocol;
      this.protocol = options.protocol || expected;
      if (this.protocol !== expected) throw fail("ERR_INVALID_PROTOCOL", 'Protocol "' + this.protocol + '" not supported. Expected "' + expected + '"', TypeError);
      const defaultPort = options.defaultPort || this.agent?.defaultPort || 80;
      this.port = String(options.port || defaultPort);
      for (const name of ["hostname", "host"]) if (options[name] != null && typeof options[name] !== "string") throw invalidArgType("options." + name, ["string", "undefined", "null"], options[name]);
      this.host = options.hostname || options.host || "localhost";
      if (options.method != null && typeof options.method !== "string") throw invalidArgType("options.method", "string", options.method);
      this.method = options.method ? options.method.toUpperCase() : "GET";
      if (!/^[!#$%&'*+.^_\u0060|~0-9A-Za-z-]+$/.test(this.method)) throw fail("ERR_INVALID_HTTP_TOKEN", 'Method must be a valid HTTP token ["' + options.method + '"]', TypeError);
      this.path = options.path || "/";
      checkPath(this.path);
      for (const [name, type] of [["createConnection", "function"], ["lookup", "function"], ["socketPath", "string"], ["maxHeaderSize", "number"]]) {
        if (options[name] === undefined) continue;
        if (typeof options[name] !== type) throw invalidArgType("options." + name, type, options[name]);
        throw fail("ERR_OPTION_NOT_IMPLEMENTED", "The options." + name + " option is not implemented");
      }
      for (const name of ["insecureHTTPParser", "joinDuplicateHeaders"]) if (options[name] !== undefined && typeof options[name] !== "boolean") throw invalidArgType("options." + name, "boolean", options[name]);
      this.joinDuplicateHeaders = options.joinDuplicateHeaders;
      const headers = options.headers;
      if (Array.isArray(headers)) {
        if (headers.length % 2) throw fail("ERR_INVALID_ARG_VALUE", "The argument 'headers' is invalid", TypeError);
        for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
      } else {
        if (headers != null) for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
        if ((options.setHost ?? options.setDefaultHeaders ?? true) && !this.getHeader("host")) {
          let host = this.host.includes(":") && !this.host.startsWith("[") ? "[" + this.host + "]" : this.host;
          if (+this.port !== +defaultPort) host += ":" + this.port;
          this.setHeader("Host", host);
        }
        if (options.auth && !this.getHeader("authorization")) this.setHeader("Authorization", "Basic " + Buffer.from(options.auth).toString("base64"));
      }
      if (callback) this.once("response", callback);
      if (options.timeout !== undefined) this.setTimeout(options.timeout);
      if (options.signal !== undefined) {
        const signal = options.signal;
        if (!(signal instanceof AbortSignal)) throw invalidArgType("signal", "AbortSignal", signal);
        this.#signal = signal;
        const cancel = () => this.destroy(abortError(signal.reason));
        if (signal.aborted) queueMicrotask(cancel);
        else signal.addEventListener("abort", cancel, { once: true });
        this.once("close", () => signal.removeEventListener("abort", cancel));
      }
    }
    #start() {
      if (this.#queued || this.destroyed || this.#signal?.aborted) return;
      this.#queued = true;
      try {
        this.#context.queued();
        this.#counted = true;
        const headers = [];
        for (const name of this.getRawHeaderNames()) {
          const value = this.getHeader(name);
          if (Array.isArray(value)) for (const part of value) headers.push([name, String(part)]);
          else headers.push([name, String(value)]);
        }
        this.#prepared = { method: this.method, path: this.path, protocol: this.protocol, host: this.host, port: this.port,
          headers, framed: this.hasHeader("content-length") || this.hasHeader("transfer-encoding"), contentLength: this.#contentLength, body: this.#completeBody };
        this._header = this.method + " " + this.path + " HTTP/1.1\r\n";
        this._headerSent = true;
      } catch (error) { this.destroy(error); this.#resume(); return; }
      // A complete end body is admitted by Writable's existing deferred finish.
      // Incremental writes must be admitted before they can finish.
      if (this.#contentLength === undefined) queueMicrotask(() => this.#admit());
    }
    #admit() {
      const request = this.#prepared;
      this.#prepared = undefined;
      if (request && !this.destroyed && !this.#signal?.aborted) {
        try { this.#open(request); }
        catch (error) { this.destroy(error); }
      }
      this.#resume();
    }
    #open(request) {
      checkPath(request.path);
      const target = new URL(request.protocol + "//" + (request.host.includes(":") && !request.host.startsWith("[") ? "[" + request.host + "]" : request.host));
      target.port = request.port;
      const address = request.path && request.path !== "/" ? new URL(request.path, target) : target;
      const headers = request.headers;
      if (request.method !== "GET" && request.method !== "HEAD" && !request.framed) {
        headers.push(request.contentLength === undefined ? ["transfer-encoding", "chunked"] : ["content-length", String(request.contentLength)]);
      }
      let body;
      if (request.method !== "GET" && request.method !== "HEAD") {
        if (request.body !== undefined) body = request.body;
        else {
          const stream = new TransformStream();
          this.#writer = stream.writable.getWriter();
          body = stream.readable;
        }
      }
      this.#context.started(request);
      this.#started = true;
      this.#touch();
      const response = fetch(address, { method: request.method, headers, body, signal: this.#controller.signal, redirect: "manual", duplex: "half", encodeResponseBody: "manual" });
      this.#completeBody = undefined;
      Promise.resolve(response).then((response) => {
        if (this.destroyed) { response.body?.cancel().catch(() => {}); return; }
        const incoming = this.#incoming = this.res = new IncomingMessage(response, {
          touch: () => this.#touch(), setTimeout: (msecs) => this.setTimeout(msecs),
        }, this.joinDuplicateHeaders);
        this.#touch();
        incoming.on("error", (error) => { if (!this.destroyed) this.emit("error", error); });
        incoming.once("close", () => {
          if (!incoming.complete || !this._writableState.finished) { this.destroy(); return; }
          // A completed exchange closes its transport, not its already-finished Writable.
          // OutgoingMessage deliberately disables Writable autoDestroy for this lifetime.
          if (this.destroyed) return;
          this.destroyed = true;
          clearTimeout(this.#timer);
          this.#writer = undefined;
          queueMicrotask(() => this.emit("close"));
        });
        if (!this.emit("response", incoming)) incoming._dump();
      }, (error) => { if (!this.destroyed) this.destroy(error); });
    }
    #afterAdmission(operation) {
      if (this.#started || this.destroyed || this.#signal?.aborted) { operation(); return; }
      // Native Writable has one outstanding write callback, never a second queue.
      this.#deferred = operation;
      this.#start();
    }
    #resume() {
      const operation = this.#deferred;
      this.#deferred = undefined;
      if (operation) operation();
    }
    _write(chunk, encoding, callback) {
      if (this.#contentLength !== undefined) { this.#start(); callback(); return; }
      this.#afterAdmission(() => {
        if (!this.destroyed && this.#writer) this.#writer.write(Buffer.from(chunk)).then(() => { this.#touch(); callback(); }, callback);
        else callback();
      });
    }
    #checkLength(chunk, encoding, ending) {
      if (!this.strictContentLength || this.finished || this.destroyed) return;
      if (chunk != null && typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return;
      const length = chunk == null ? 0 : typeof chunk === "string" ? Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined) : chunk.byteLength;
      const actual = this.#bytesWritten + length;
      if (this._hasBody && !this._removedContLen && !this.chunkedEncoding && this.hasHeader("content-length") && !this.hasHeader("transfer-encoding")) {
        const expected = Number(this.getHeader("content-length"));
        if (actual > expected || (ending && actual !== expected)) throw fail("ERR_HTTP_CONTENT_LENGTH_MISMATCH", "Response body's content-length of " + actual + " byte(s) does not match the content-length of " + expected + " byte(s) set in header");
      }
      return actual;
    }
    write(chunk, encoding, callback) {
      if (this.finished) return http.OutgoingMessage.prototype.write.call(this, chunk, encoding, callback);
      const length = this.#checkLength(chunk, encoding, false);
      const accepted = Writable.prototype.write.call(this, chunk, encoding, callback);
      if (length !== undefined) this.#bytesWritten = length;
      return accepted;
    }
    end(chunk, encoding, callback) {
      if (this.destroyed) return this;
      if (typeof chunk === "function") { callback = chunk; chunk = undefined; encoding = undefined; }
      else if (typeof encoding === "function") { callback = encoding; encoding = undefined; }
      if (this.finished) return http.OutgoingMessage.prototype.end.call(this, chunk, encoding, callback);
      if (chunk != null && typeof chunk !== "string" && !(chunk instanceof Uint8Array)) throw invalidArgType("chunk", ["string", "Buffer", "Uint8Array"], chunk);
      const length = this.#checkLength(chunk, encoding, true);
      if (!this.#queued && this.writableLength === 0) {
        this.#contentLength = 0;
        if (this.method !== "GET" && this.method !== "HEAD") {
          if (chunk == null) this.#completeBody = Buffer.alloc(0);
          else if (typeof chunk === "string") this.#completeBody = Buffer.from(chunk, encoding);
          else if (chunk instanceof Uint8Array) this.#completeBody = Buffer.from(chunk);
          this.#contentLength = this.#completeBody?.byteLength;
        }
      }
      this.#start();
      if (this.#contentLength !== undefined && !this.strictContentLength) return http.OutgoingMessage.prototype.end.call(this, undefined, undefined, callback);
      if (chunk != null) Writable.prototype.write.call(this, this.#completeBody ?? chunk, encoding);
      Writable.prototype.end.call(this, callback);
      if (length !== undefined) this.#bytesWritten = length;
      this.finished = true;
      return this;
    }
    emit(event, ...args) {
      if (event === "finish") {
        if (this.destroyed) return false;
        this.#admit();
        if (!this.destroyed && this.#writer) this.#writer.close().catch((error) => this.destroy(error));
      }
      if (event === "close" && this.destroyed) {
        this._closed = true;
        if (this.#counted) { this.#counted = false; this.#context.finished(this); }
      }
      return super.emit(event, ...args);
    }
    cork() { return Writable.prototype.cork.call(this); }
    uncork() { return Writable.prototype.uncork.call(this); }
    get writableLength() { return this._writableState.length; }
    get writableCorked() { return this._writableState.corked; }
    get writableNeedDrain() { return this._writableState.needDrain; }
    flushHeaders() { this.#start(); }
    _implicitHeader() { this.#start(); }
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      if (!this.#started) {
        this.destroy();
        queueMicrotask(() => this.emit("abort"));
      } else {
        queueMicrotask(() => this.emit("abort"));
        this.destroy();
      }
    }
    destroy(error) {
      if (this.destroyed) return this;
      this.destroyed = true;
      return Writable.prototype.destroy.call(this, error);
    }
    _destroy(error, callback) {
      clearTimeout(this.#timer);
      this.#prepared = undefined;
      this.#completeBody = undefined;
      this.#controller.abort(error);
      if (this.#incoming && !this.#incoming.complete) this.#incoming.destroy(reset("aborted"));
      if (!this.#incoming && error == null && (!this.aborted || this.#started)) error = reset("socket hang up");
      if (this.#writer) this.#writer.abort(error).catch(() => {});
      callback(error);
    }
    setTimeout(msecs, callback) {
      this.timeout = duration(msecs);
      if (callback) this.once("timeout", callback);
      this.#touch();
      return this;
    }
    clearTimeout(callback) { return this.setTimeout(0, callback); }
    #touch() {
      clearTimeout(this.#timer);
      if (!this.timeout || !this.#started || this.destroyed) return;
      this.#timer = setTimeout(() => { this.emit("timeout"); this.#incoming?.emit("timeout"); this.destroy(abortError()); }, this.timeout);
    }
  }
  for (const name of ["onSocket", "addTrailers", "setNoDelay", "setSocketKeepAlive"]) {
    Object.defineProperty(ClientRequest.prototype, name, { value: NativeClientRequest.prototype[name], writable: true, configurable: true });
  }
  http.ClientRequest = ClientRequest;
  http.request = function request(...args) { return new ClientRequest(...args); };
  http.get = function get(...args) { const req = new ClientRequest(...args); req.end(); return req; };
  https.request = function request(input, options, callback) {
    const [opts, cb] = requestOptions(input, options, callback);
    return new ClientRequest({ ...opts, _defaultAgent: https.globalAgent }, cb);
  };
  https.get = function get(...args) { const req = https.request(...args); req.end(); return req; };
  Object.defineProperty(http, installed, { value: (next) => { activeContext = next; } });
}
`;
