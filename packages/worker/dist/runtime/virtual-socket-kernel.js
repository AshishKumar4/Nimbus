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
 * wasm32-wasi-nimbus syscalls) should call this shared JS kernel rather
 * than each implementing their own preview bridge.
 */
export const VIRTUAL_SOCKET_KERNEL_SRC = `
const __NIMBUS_SOCKET_TIMEOUT_MS = 30_000;

class __NimbusDeferred {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

function __nimbusSocketBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value && typeof value.toJs === "function") return __nimbusSocketBytes(value.toJs());
  return new Uint8Array(0);
}

function __nimbusConcatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function __nimbusFindHeaderEnd(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i + 4;
  }
  return -1;
}

function __nimbusHeaderValue(headers, name) {
  const target = name.toLowerCase();
  for (const [k, v] of headers) {
    if (k.toLowerCase() === target) return v;
  }
  return null;
}

function __nimbusParseChunked(body) {
  const dec = new TextDecoder();
  const chunks = [];
  let off = 0;
  while (off < body.length) {
    let lineEnd = -1;
    for (let i = off; i + 1 < body.length; i++) {
      if (body[i] === 13 && body[i + 1] === 10) { lineEnd = i; break; }
    }
    if (lineEnd < 0) return null;
    const line = dec.decode(body.subarray(off, lineEnd)).trim();
    const sizeText = line.split(";", 1)[0];
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) return null;
    off = lineEnd + 2;
    if (body.length < off + size + 2) return null;
    if (size === 0) return __nimbusConcatBytes(chunks);
    chunks.push(body.subarray(off, off + size));
    off += size;
    if (body[off] !== 13 || body[off + 1] !== 10) return null;
    off += 2;
  }
  return null;
}

async function __nimbusRequestBytes(request) {
  const url = new URL(request.url);
  const path = (url.pathname || "/") + url.search;
  const headers = new Headers(request.headers);
  if (!headers.has("Host")) headers.set("Host", url.host || "nimbus.local");
  const body = request.method === "GET" || request.method === "HEAD"
    ? new Uint8Array(0)
    : new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > 0 && !headers.has("Content-Length")) {
    headers.set("Content-Length", String(body.byteLength));
  }
  const lines = [request.method + " " + path + " HTTP/1.1"];
  headers.forEach((value, key) => lines.push(key + ": " + value));
  lines.push("", "");
  return __nimbusConcatBytes([new TextEncoder().encode(lines.join("\\r\\n")), body]);
}

class __NimbusVirtualConnection {
  constructor(id, requestBytes) {
    this.id = id;
    this.requestBytes = requestBytes;
    this.requestOffset = 0;
    this.output = [];
    this.closed = false;
    this.waiters = [];
  }

  read(maxBytes) {
    if (this.requestOffset >= this.requestBytes.byteLength) return [];
    const end = Math.min(this.requestOffset + Math.max(1, maxBytes | 0), this.requestBytes.byteLength);
    const chunk = this.requestBytes.subarray(this.requestOffset, end);
    this.requestOffset = end;
    return Array.from(chunk);
  }

  write(bytesLike) {
    const bytes = __nimbusSocketBytes(bytesLike);
    if (bytes.byteLength > 0) this.output.push(bytes.slice());
    this._wake();
    return bytes.byteLength;
  }

  close() {
    this.closed = true;
    this._wake();
  }

  _wake() {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.resolve();
  }

  _responseFromBytes() {
    const bytes = __nimbusConcatBytes(this.output);
    const headerEnd = __nimbusFindHeaderEnd(bytes);
    if (headerEnd < 0) return null;
    const headerText = new TextDecoder().decode(bytes.subarray(0, headerEnd));
    const lines = headerText.replace(/\\r\\n/g, "\\n").split("\\n").filter((line) => line.length > 0);
    const statusLine = lines.shift() || "HTTP/1.1 200 OK";
    const m = /^HTTP\\/\\d(?:\\.\\d)?\\s+(\\d{3})(?:\\s+(.*))?$/.exec(statusLine);
    const status = m ? parseInt(m[1], 10) : 200;
    const statusText = m && m[2] ? m[2] : "";
    const headerPairs = [];
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      headerPairs.push([line.slice(0, idx), line.slice(idx + 1).trimStart()]);
    }
    const body = bytes.subarray(headerEnd);
    const contentLength = __nimbusHeaderValue(headerPairs, "Content-Length");
    const transferEncoding = __nimbusHeaderValue(headerPairs, "Transfer-Encoding");
    let responseBody = body;
    if (transferEncoding && /chunked/i.test(transferEncoding)) {
      const parsed = __nimbusParseChunked(body);
      if (!parsed) return null;
      responseBody = parsed;
    } else if (contentLength != null) {
      const expected = parseInt(contentLength, 10);
      if (Number.isFinite(expected) && body.byteLength < expected) return null;
      if (Number.isFinite(expected)) responseBody = body.subarray(0, expected);
    } else if (!this.closed) {
      return null;
    }
    const headers = new Headers();
    for (const [k, v] of headerPairs) {
      if (/^transfer-encoding$/i.test(k)) continue;
      headers.append(k, v);
    }
    return new Response(responseBody, { status, statusText, headers });
  }

  async response(timeoutMs) {
    const deadline = Date.now() + Math.max(1, timeoutMs || __NIMBUS_SOCKET_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const response = this._responseFromBytes();
      if (response) return response;
      const waiter = new __NimbusDeferred();
      this.waiters.push(waiter);
      const remaining = Math.max(1, deadline - Date.now());
      await Promise.race([
        waiter.promise,
        new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 250))),
      ]);
    }
    return new Response("Nimbus virtual socket: timed out waiting for response", { status: 504 });
  }
}

class __NimbusVirtualListener {
  constructor(port) {
    this.port = port;
    this.queue = [];
    this.waiters = [];
  }

  push(conn) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(conn);
    else this.queue.push(conn);
  }

  accept() {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    const waiter = new __NimbusDeferred();
    this.waiters.push(waiter);
    return waiter.promise;
  }

  take() {
    return this.queue.shift() || null;
  }

  pending() {
    return this.queue.length;
  }
}

class __NimbusVirtualSocketKernel {
  constructor() {
    this.listeners = new Map();
    this.connections = new Map();
    this.nextConnectionId = 1;
    this.nextEphemeralPort = 49152;
    this.listenWaiters = [];
  }

  listen(port) {
    let n = Number(port);
    if (!Number.isInteger(n) || n < 0 || n >= 65536) throw new Error("invalid port: " + port);
    if (n === 0) {
      while (this.listeners.has(this.nextEphemeralPort)) {
        this.nextEphemeralPort++;
        if (this.nextEphemeralPort >= 65535) this.nextEphemeralPort = 49152;
      }
      n = this.nextEphemeralPort++;
      if (this.nextEphemeralPort >= 65535) this.nextEphemeralPort = 49152;
    }
    let listener = this.listeners.get(n);
    if (!listener) {
      listener = new __NimbusVirtualListener(n);
      this.listeners.set(n, listener);
      try { globalThis.__nimbusVirtualSocketDidListen?.(n); } catch {}
      const waiters = this.listenWaiters.splice(0);
      for (const waiter of waiters) waiter.resolve(n);
    }
    return n;
  }

  closeListener(port) {
    this.listeners.delete(Number(port));
  }

  async accept(port) {
    const listener = this.listeners.get(Number(port));
    if (!listener) throw new Error("port is not listening: " + port);
    const conn = await listener.accept();
    return { id: conn.id, host: "127.0.0.1", port: 0 };
  }

  acceptNow(port) {
    const listener = this.listeners.get(Number(port));
    if (!listener) throw new Error("port is not listening: " + port);
    const conn = listener.take();
    return conn ? { id: conn.id, host: "127.0.0.1", port: 0 } : null;
  }

  recv(id, maxBytes) {
    const conn = this.connections.get(Number(id));
    if (!conn) return [];
    return conn.read(maxBytes);
  }

  send(id, bytesLike) {
    const conn = this.connections.get(Number(id));
    if (!conn) throw new Error("connection is closed: " + id);
    return conn.write(bytesLike);
  }

  close(id) {
    const conn = this.connections.get(Number(id));
    if (!conn) return;
    conn.close();
    this.connections.delete(Number(id));
  }

  pending(port) {
    return this.listeners.get(Number(port))?.pending() || 0;
  }

  firstListeningPort() {
    return this.listeners.size > 0 ? Array.from(this.listeners.keys())[0] : null;
  }

  waitReadable(ports, timeoutSeconds) {
    const normalized = (Array.isArray(ports) ? ports : []).map((p) => Number(p)).filter((p) => Number.isInteger(p));
    for (const port of normalized) {
      if (this.pending(port) > 0) return Promise.resolve([port]);
    }
    const timeoutMs = timeoutSeconds == null ? __NIMBUS_SOCKET_TIMEOUT_MS : Math.max(0, Number(timeoutSeconds) * 1000);
    const waiter = new __NimbusDeferred();
    const check = () => {
      const ready = normalized.filter((port) => this.pending(port) > 0);
      if (ready.length > 0) waiter.resolve(ready);
    };
    const oldWaiters = this.listenWaiters;
    const poll = setInterval(check, 25);
    const timer = setTimeout(() => {
      clearInterval(poll);
      waiter.resolve([]);
    }, timeoutMs);
    return waiter.promise.finally(() => {
      clearInterval(poll);
      clearTimeout(timer);
      this.listenWaiters = oldWaiters;
    });
  }

  async waitForListen(timeoutMs) {
    const existing = this.firstListeningPort();
    if (existing) return existing;
    const waiter = new __NimbusDeferred();
    this.listenWaiters.push(waiter);
    return await Promise.race([
      waiter.promise,
      new Promise((resolve) => setTimeout(() => resolve(null), Math.max(1, timeoutMs || 5_000))),
    ]);
  }

  async handleHttpRequest(port, request) {
    let listener = this.listeners.get(Number(port));
    if (!listener) {
      try { await globalThis.__nimbusVirtualSocketEnsureListener?.(Number(port)); } catch {}
      listener = this.listeners.get(Number(port));
    }
    if (!listener) return new Response("Nimbus virtual socket: no listener on port " + port, { status: 502 });
    const id = this.nextConnectionId++;
    const conn = new __NimbusVirtualConnection(id, await __nimbusRequestBytes(request));
    this.connections.set(id, conn);
    listener.push(conn);
    try {
      try { await globalThis.__nimbusVirtualSocketRequestQueued?.(Number(port)); } catch {}
      return await conn.response(__NIMBUS_SOCKET_TIMEOUT_MS);
    } finally {
      conn.close();
      this.connections.delete(id);
    }
  }
}

globalThis.__nimbusVirtualSockets = globalThis.__nimbusVirtualSockets || new __NimbusVirtualSocketKernel();
`;
