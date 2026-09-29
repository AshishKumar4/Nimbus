// The workerd HTTP boundary for Bun-only runtime tests. Node's real HTTP
// server owns parsing/streams; each logical guest port is backed by an OS
// ephemeral listener, so concurrent test files never bind the same host port.
// Actual workerd dispatch is exercised by native-http-workerd.mjs.
import http from 'node:http';
import net from 'node:net';
import { generateShimsCode as shims } from '../../../packages/worker/src/runtime/node-shims.ts';

const hostFetch = globalThis.fetch.bind(globalThis);
const hostTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

function withHostTimers(work) {
  const guestTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
  Object.assign(globalThis, hostTimers);
  try { return work(); } finally { Object.assign(globalThis, guestTimers); }
}
const realms = globalThis.__nimbusTestHttpRealms ??= new Map();
let nextRealm = 0;


export function createHttpPlatform() {
  const listeners = new Map();
  class Server extends http.Server {
    constructor(...args) {
      withHostTimers(() => super(...args));
      // Bun starts its 30 s TCP connection sweep from an internal listening
      // listener, not from listen() itself. Workerd has no host TCP sweep.
      // Keep only the listeners installed by the native constructor on host
      // scheduling; application listeners added afterward use guest timers.
      for (const listener of this.rawListeners('listening')) {
        this.removeListener('listening', listener);
        this.on('listening', (...values) => withHostTimers(() => Reflect.apply(listener, this, values)));
      }
    }
    listen(...args) {
      const [opts, callback] = net._normalizeArgs(args);
      const port = Number(opts.port ?? 0);
      if (listeners.has(port)) throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
      listeners.set(port, this);
      this.ready = Promise.withResolvers();
      super.listen(0, '127.0.0.1', () => {
        this.socketPort = http.Server.prototype.address.call(this).port;
        this.ready.resolve();
        callback?.();
      });
      this.logicalAddress = { port, family: 'IPv4', address: opts.host || '127.0.0.1' };
      super.unref();
      return this;
    }
    address() { return this.logicalAddress ?? null; }
    get listening() { return this.logicalAddress != null; }
    set listening(value) { this.nativeListening = value; }
    close(callback) {
      if (this.logicalAddress) listeners.delete(this.logicalAddress.port);
      this.logicalAddress = null;
      super.close(callback);
      return this;
    }
  }
  const native = { ...http, Server, createServer: (...args) => new Server(...args) };
  async function handleAsNodeRequest(port, request) {
    const server = listeners.get(port);
    if (!server) throw new Error(`No HTTP server for ${port}`);
    await server.ready.promise;
    const url = new URL(request.url);
    url.hostname = '127.0.0.1';
    url.port = String(server.socketPort);
    return hostFetch(url, {
      method: request.method, headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      signal: request.signal, duplex: 'half',
    });
  }
  return { http: native, net, handleAsNodeRequest };
}

function bindings() {
  const id = ++nextRealm;
  realms.set(id, createHttpPlatform());
  return `const { http: __real_http, net: __real_net, handleAsNodeRequest: __nimbusHandleAsNodeRequest } = globalThis.__nimbusTestHttpRealms.get(${id});`;
}

/** Standalone shims factories, without a generated runner's import block. */
export function generateShimsCode() {
  return `${bindings()}\nconst __pendingIO = [];\n${shims()}`;
}

/** A generated runner's real workerd imports, mapped to this platform seam. */
export function adaptHttpImports(source) {
  if (!source.includes("import * as __real_http from 'node:http';")) return source;
  return source
    .replace("import * as __real_http from 'node:http';", bindings())
    .replace("import * as __real_net from 'node:net';", '')
    .replace("import { handleAsNodeRequest as __nimbusHandleAsNodeRequest } from 'cloudflare:node';", '');
}
