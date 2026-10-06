/**
 * A WebSocket upgrade made with `http.request` / `https.request`, as the `ws`
 * package (and every client built on it) makes one: inserted into the
 * generated node shims after the native HTTP module (native-http.ts).
 *
 * workerd's `http.request` cannot make one: it refuses `createConnection`
 * (ERR_OPTION_NOT_IMPLEMENTED; `ws` always passes it) and has no 'upgrade'
 * event. A child's sockets are the supervisor's anyway: an inbound frame has
 * to arrive as a supervisor reply for the coherence barrier to ride on it
 * (session/ws-relay.ts). So a request carrying `Upgrade: websocket` is
 * answered here, over the same relayed socket the global WebSocket uses: the
 * supervisor makes the upgrade, a fetch through the workspace's network (its
 * egress, when it has one), for ws: and wss: alike, with the request's own
 * headers.
 *
 * The request is a ClientRequest as `ws` and Node use one: headers, end(),
 * abort(), destroy(), a timeout, then 'upgrade' (res, socket, head) on a 101
 * or 'response' (res) with the destination's status, headers and body when it
 * refuses. The socket speaks RFC 6455 to its client: the client's masked
 * frames are read (fragments joined, a ping answered, a close passed on) and
 * each message is sent on the relayed socket; each message the relay delivers
 * is written back as an unmasked frame, and its close as a close frame. No
 * extension is negotiated on this hop (no Sec-WebSocket-Extensions in the
 * 101), and Sec-WebSocket-Accept is computed for the client's key, so `ws`'s
 * handshake checks pass as against a server.
 *
 * Not here: a WebSocket server in the session. workerd's HTTP server emits
 * 'request', not 'upgrade', so `new WebSocketServer({ server })` never sees a
 * connection (docs/sandbox-sdk.md).
 */
export const NODE_WS_UPGRADE_SOURCE = `
// ═══════════════════════════════════════════════════════════════════════
// ──  WebSocket upgrades over http(s).request (runtime/node-ws-upgrade.ts)
// ═══════════════════════════════════════════════════════════════════════
const __nimbusWebSocketUpgrades = (() => {
  const patched = Symbol.for("nimbus.websocket-upgrade");
  /** RFC 6455 section 1.3: what the server appends to the client's key. */
  const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };
  const utf8 = new TextDecoder();

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

  /** A response head as Node's IncomingMessage has it: headers by lowercased name (set-cookie a list), and raw. */
  function incoming(status, statusText, pairs, body) {
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
    res.complete = true;
    if (body && body.byteLength > 0) res.push(Buffer.from(body));
    res.push(null);
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

  function protocolError(message) {
    return Object.assign(new Error("Nimbus: WebSocket protocol error from the client: " + message), { code: "ERR_NIMBUS_WEBSOCKET_PROTOCOL" });
  }

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
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
      this._pending = this._pending.length > 0 ? Buffer.concat([this._pending, bytes]) : bytes;
      try {
        this._parse();
        callback();
      } catch (error) {
        callback(error);
      }
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
          this._clientClose = payload;
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
          const reason = payload.length > 2 ? utf8.decode(payload.subarray(2)) : "";
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
      if (this._relay.readyState !== 1) return;
      this._relay.send(opcode === OPCODE.text ? utf8.decode(payload) : new Uint8Array(payload));
    }

    // net.Socket's tuning, which a relayed socket has no use for.
    setTimeout(ms, callback) { if (callback) this.once("timeout", callback); return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { return this; }
    unref() { return this; }
  }

  /** A ClientRequest carrying \`Upgrade: websocket\`: answered over a relayed socket. */
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
      if (callback) this.once("response", callback);
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
      queueMicrotask(() => {
        if (aborted) this.emit("abort");
        if (error) this.emit("error", error);
        this.emit("close");
      });
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
        relay = new __NimbusRelayedWebSocket(url, { protocols, headers });
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
      const socket = new WebSocketBridge(relay);
      this.socket = socket;
      if (this.listenerCount("upgrade") === 0) {
        // Node closes an upgraded connection nobody took.
        socket.destroy();
        return;
      }
      this.emit("upgrade", res, socket, Buffer.alloc(0));
    }

    _refused(handshake) {
      const res = incoming(handshake.status, handshake.statusText || "", handshake.headers || [], handshake.body);
      // The relay hands over at most WS_RELAY_REFUSAL_BODY_MAX_BYTES of it.
      res.complete = !handshake.truncated;
      if (this.listenerCount("response") === 0) {
        res.resume();
        this.emit("close");
        return;
      }
      this.emit("response", res);
      this.emit("close");
    }
  }

  /** \`module\`'s request and get, answering a WebSocket upgrade here and anything else as before. */
  return function install(module, secure) {
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
  };
})();
`;
