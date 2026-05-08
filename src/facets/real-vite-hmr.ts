/**
 * real-vite-hmr.ts — Phase 2 HMR bridge for the real-vite facet.
 *
 * The browser's `@vite/client` script (served as-is by Vite) opens a
 * WebSocket to Vite's HMR path. In local dev that's a raw TCP socket;
 * under workerd we don't have one, so we:
 *
 *   1. Route the browser's upgrade request to a new DO endpoint
 *      `/s/<id>/preview/__nimbus_hmr` (picked as an unusual path that
 *      won't collide with user code). The DO accepts the WebSocket.
 *   2. On the facet side, we shim `ws.WebSocketServer` — the npm
 *      module Vite bundles for HMR. The shim registers itself in a
 *      facet-local "pending connections" table; when a connection
 *      arrives via RPC, the shim delivers an "on('connection')" event
 *      to Vite.
 *   3. Messages from Vite (server → client, e.g. HMR update) are
 *      pushed back to the supervisor via `SUPERVISOR.hmrSend(clientId,
 *      msg)`, which the supervisor forwards to the right WebSocket.
 *   4. Messages from the browser (client → server, e.g. ping/pong,
 *      custom events) are ferried via a long-poll
 *      `SUPERVISOR.hmrNextEvent(serverId)` that returns the queued
 *      batch.
 *
 * Phase 1's VFS-backed fs shim is the prerequisite: chokidar's watch
 * events drive Vite's HMR, so we need real file change notifications
 * plumbed to the facet. Those come via the SAME long-poll loop as
 * client-side WS messages — both are just "events from the
 * supervisor", multiplexed.
 *
 * Scope note: Phase 2 implements the minimum viable path —
 * connection + server→client messages — enough for the
 * "[vite] connected" handshake + full-reload triggers on file save.
 * True module-level `import.meta.hot.accept()` needs chokidar events
 * to fire Vite's `moduleGraph.invalidate`; wire that up once Phase 1's
 * fs shim is streaming VFS events.
 */

// This file is pure source; at runtime it contributes:
//   1. Supervisor-side: HmrBridge class (connection registry + WS pump).
//   2. Supervisor-side: CirrusHmrRPC WorkerEntrypoint class (the RPC
//      service the facet talks to for hmrSend/hmrNextEvent).
//   3. Facet-side: ESM source strings for the ws shim + chokidar shim.
// All are emitted by the generators below.

import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * Supervisor-side registry of active HMR connections for a single
 * real-vite session. One instance lives on each NimbusSession that has
 * real-vite running. The instance is bound to a specific facet via
 * its `facetStub` (a ctx.exports wrapper around the facet's
 * WorkerEntrypoint).
 *
 * Lifecycle:
 *   - On browser WS upgrade (/preview/__nimbus_hmr), the DO calls
 *     bridge.attachClient(ws) → HMR connection id is generated, ws
 *     is stored, and a one-shot RPC to the facet tells it "new
 *     connection".
 *   - The facet's ws shim emits a 'connection' event to Vite. Vite
 *     starts sending handshake messages via the shim's .send() →
 *     those come back to the supervisor via SUPERVISOR.hmrSend →
 *     HmrBridge.relayToBrowser(clientId, msg).
 *   - Browser WS messages arrive at the DO's webSocketMessage
 *     handler, which calls bridge.deliverClientMessage(clientId, msg)
 *     → enqueued for the next hmrNextEvent long-poll.
 *   - Same long-poll returns VFS change events so chokidar can fire.
 */
export class HmrBridge {
  /** clientId → WebSocket */
  private clients = new Map<string, WebSocket>();
  /** Pending events awaiting the next long-poll. */
  private pending: Array<{ type: string; clientId?: string; msg?: string; path?: string; event?: string; oldPath?: string }> = [];
  /** Resolver for the currently-suspended long-poll, if any. */
  private resolver: ((events: any[]) => void) | null = null;
  /** Has the facet ever called hmrNextEvent? Used for diagnostics. */
  public _everAwaitedEvents = false;
  private _nextId = 1;

  /** Register a new browser WebSocket. Returns the assigned client id. */
  attachClient(ws: WebSocket): string {
    const id = 'c' + (this._nextId++);
    this.clients.set(id, ws);
    this.push({ type: 'connection', clientId: id });
    return id;
  }

  detachClient(id: string): void {
    this.clients.delete(id);
    this.push({ type: 'disconnect', clientId: id });
  }

  /** Called by the DO webSocketMessage handler. Forwards to the facet. */
  deliverClientMessage(id: string, msg: string): void {
    this.push({ type: 'message', clientId: id, msg });
  }

  /** Called by the facet via SUPERVISOR.hmrSend to push a msg to a browser. */
  relayToBrowser(id: string | null, msg: string): void {
    console.log('[HmrBridge relay] id=', id, 'msg len=', msg?.length, 'clients=', this.clients.size);
    if (id == null) {
      for (const ws of this.clients.values()) {
        try { ws.send(msg); } catch { /* client gone */ }
      }
      return;
    }
    const ws = this.clients.get(id);
    if (!ws) { console.log('[HmrBridge relay] no WS for id', id); return; }
    try { ws.send(msg); console.log('[HmrBridge relay] sent ok'); } catch (e: any) { console.log('[HmrBridge relay] send threw:', e?.message); }
  }

  /**
   * Push a synthetic VFS event into the event queue. Called by
   * NimbusSession's VFS-events listener so the facet's chokidar shim
   * fires file-change callbacks.
   */
  pushVfsEvent(event: string, path: string, oldPath?: string): void {
    this.push({ type: 'vfs', event, path, oldPath });
  }

  private push(ev: any): void {
    this.pending.push(ev);
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      const batch = this.pending;
      this.pending = [];
      try { r(batch); } catch { /* dropped */ }
    }
  }

  /**
   * Called by the facet via SUPERVISOR.hmrNextEvent. Long-polls up to
   * `timeoutMs` for the next batch of events. Returns an empty array
   * on timeout so the facet can loop without leaking a promise.
   */
  async nextEvents(timeoutMs: number = 25_000): Promise<any[]> {
    this._everAwaitedEvents = true;
    if (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = [];
      return batch;
    }
    return new Promise((resolve) => {
      this.resolver = resolve;
      setTimeout(() => {
        if (this.resolver === resolve) {
          this.resolver = null;
          resolve([]);
        }
      }, timeoutMs);
    });
  }

  /** Active client count. */
  get size(): number { return this.clients.size; }

  /** Drop all clients (facet restart, session close). */
  closeAll(): void {
    for (const ws of this.clients.values()) {
      try { ws.close(1001, 'facet restart'); } catch { /* ignore */ }
    }
    this.clients.clear();
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      try { r([]); } catch { /* ignore */ }
    }
    this.pending = [];
  }
}

/**
 * Registry mapping `doId` → `CirrusReal` instance. Populated when
 * NimbusSession creates a CirrusReal. The facet-side RPC looks up the
 * right HmrBridge via this registry — otherwise CirrusHmrRPC.fetch
 * can't know WHICH session called it.
 */
const _BRIDGES = new Map<string, { hmr: HmrBridge }>();

export function registerHmrBridge(doId: string, holder: { hmr: HmrBridge }): void {
  _BRIDGES.set(doId, holder);
}
// unregisterHmrBridge intentionally not exposed — the registry is GC'd
// when the supervisor DO is evicted, and the cirrus-real comment at the
// stop() site explains why we don't unregister mid-life.

/**
 * WorkerEntrypoint the facet talks to via `env.CIRRUS_HMR`.
 *
 * hmrSend CANNOT write to browser WSs directly (workerd forbids
 * cross-request I/O on objects owned by a different request's
 * context — even hibernatable WSs owned by the DO can't be written
 * to from a sibling WorkerEntrypoint isolate). Instead, hmrSend
 * routes through the DO stub's _rpcHmrRelay method, where the
 * ws.send() happens in the DO's own request context.
 *
 * Props: { doId: string }
 *   doId — the supervisor DO's id, used to find the right stub +
 *          HmrBridge.
 */
export class CirrusHmrRPC extends WorkerEntrypoint {
  private _bridge(): HmrBridge | null {
    const doId = (this.ctx as any).props?.doId;
    if (!doId) return null;
    return _BRIDGES.get(doId)?.hmr || null;
  }

  private _stub(): any {
    const doId = (this.ctx as any).props?.doId;
    if (!doId) return null;
    const id = (this.env as any).NIMBUS_SESSION.idFromString(doId);
    return (this.env as any).NIMBUS_SESSION.get(id);
  }

  async hmrSend(clientId: string | null, msg: string): Promise<void> {
    const stub = this._stub();
    if (!stub) return;
    // Call the DO's own RPC method, which runs in the DO's context
    // and can legally call ws.send() on hibernatable sockets.
    try { await stub._rpcHmrRelay(clientId, msg); } catch { /* socket gone */ }
  }

  async hmrNextEvent(timeoutMs: number = 25_000): Promise<any[]> {
    // Long-poll can stay on the WorkerEntrypoint side — nextEvents
    // only awaits in-memory timers/queues, no WS I/O.
    const b = this._bridge();
    if (!b) return [];
    return b.nextEvents(Math.min(30_000, Math.max(1_000, timeoutMs)));
  }
}

/**
 * ESM source for the `ws` npm module shim. Vite's bundle still
 * statically imports things like `WebSocketServer` from `ws`; we
 * externalize that specifier and provide this module at LOADER.load
 * time.
 *
 * `new WebSocketServer({ noServer: true })` gives Vite back an object
 * that:
 *   - emits 'connection' events whenever the supervisor reports a
 *     new client via the long-poll,
 *   - exposes .handleUpgrade (stubbed since we don't have raw sockets).
 *
 * The returned client has `.on('message', cb)`, `.send(msg)`, `.close()`
 * — enough for Vite's hot.ts handshake.
 */
export function generateWsShimModuleCode(): string {
  return `
// ── ws shim (generated by src/real-vite-hmr.ts) ────────────────
//
// Vite imports { WebSocketServer, WebSocket } from 'ws'. We route
// those imports to this module (via esbuild alias), so the facet
// never tries to bind a real socket. All connections are multiplexed
// through the single DO-side /__nimbus_hmr WS and delivered here as
// events from the long-poll loop.

const _g = globalThis;

// Self-seed the global bindings at module-eval time. Our post-patched
// vite.bundle.js looks up globalThis.__cirrusWsModule synchronously
// at module-init (inside \`var WebSocketServerRaw = ...\`), so this
// assignment MUST win the race. ESM evaluates imports depth-first in
// source order, so as long as main.js imports this module before
// vite.bundle.js, we're ahead.

class CirrusWsClient {
  constructor(id) {
    this.id = id;
    this._listeners = { message: [], close: [], error: [], pong: [], ping: [] };
    this.readyState = 1; // OPEN
  }
  on(ev, cb) {
    if (this._listeners[ev]) this._listeners[ev].push(cb);
    return this;
  }
  off(ev, cb) {
    if (this._listeners[ev]) {
      const i = this._listeners[ev].indexOf(cb);
      if (i >= 0) this._listeners[ev].splice(i, 1);
    }
    return this;
  }
  emit(ev, ...args) {
    if (this._listeners[ev]) for (const l of this._listeners[ev].slice()) { try { l(...args); } catch (e) { console.warn('[cirrus-ws] listener threw:', e?.message); } }
  }
  send(data, cb) {
    const hmr = _g.__cirrusRealHmr;
    if (hmr?.hmrSend) {
      const msg = typeof data === 'string' ? data : data?.toString?.() || '';
      hmr.hmrSend(this.id, msg).then(() => cb?.(), (e) => cb?.(e));
    } else {
      cb?.();
    }
  }
  close(code, reason) {
    this.readyState = 3;
    this.emit('close', code || 1000, reason || '');
  }
  terminate() { this.close(1006, 'terminate'); }
  ping() { /* no-op; Vite does this keep-alive */ }
  pong() { /* no-op */ }
}

class CirrusWsServer {
  constructor(opts) {
    this.options = opts || {};
    this._listeners = { connection: [], error: [], listening: [], close: [], headers: [] };
    this.clients = new Set();
    _g.__cirrusRealWsServer = this; // allow the boot loop to find us
    // Tell the event loop we're ready. Some Vite codepaths emit
    // 'listening' themselves; doing it here is harmless.
    queueMicrotask(() => this.emit('listening'));
  }
  on(ev, cb) {
    if (this._listeners[ev]) this._listeners[ev].push(cb);
    return this;
  }
  off(ev, cb) {
    if (this._listeners[ev]) {
      const i = this._listeners[ev].indexOf(cb);
      if (i >= 0) this._listeners[ev].splice(i, 1);
    }
    return this;
  }
  emit(ev, ...args) {
    if (this._listeners[ev]) for (const l of this._listeners[ev].slice()) { try { l(...args); } catch (e) { console.warn('[cirrus-ws] listener threw:', e?.message); } }
  }
  /** Called by the HMR loop when a new connection shows up. */
  _acceptConnection(id) {
    const client = new CirrusWsClient(id);
    this.clients.add(client);
    _g.__cirrusRealWsClients ??= new Map();
    _g.__cirrusRealWsClients.set(id, client);
    console.log('[cirrus-ws] _acceptConnection id=' + id + ' listeners=' + (this._listeners.connection?.length || 0));
    this.emit('connection', client, { url: '/', headers: {} });
    return client;
  }
  _dispatchMessage(id, msg) {
    const client = _g.__cirrusRealWsClients?.get(id);
    if (client) client.emit('message', msg);
  }
  _disconnect(id) {
    const client = _g.__cirrusRealWsClients?.get(id);
    if (client) {
      client.close(1001, 'client gone');
      this.clients.delete(client);
      _g.__cirrusRealWsClients.delete(id);
    }
  }
  handleUpgrade(req, sock, head, cb) {
    // Never called in our flow, but Vite references it defensively.
    if (typeof cb === 'function') cb(new CirrusWsClient('<stub>'));
  }
  close(cb) {
    for (const c of this.clients) c.close(1001, 'server closing');
    this.clients.clear();
    cb?.();
  }
  shouldHandle() { return true; }
  get clients() { return this._clients ??= new Set(); }
  set clients(v) { this._clients = v; }
}

export const WebSocketServer = CirrusWsServer;
export const WebSocket = CirrusWsClient;
const _exports = { WebSocketServer: CirrusWsServer, WebSocket: CirrusWsClient };
_g.__cirrusWsModule = _exports;
export default _exports;
`.trim();
}

/**
 * ESM source for the chokidar shim. Vite's bundle imports chokidar's
 * `watch()` function; we reroute that to this module. Our watcher
 * listens on the facet-global event dispatcher (fed by the long-poll
 * loop) and translates VFS events to chokidar-shaped callbacks.
 *
 * Supported events: add, change, unlink, addDir, unlinkDir, ready, all.
 */
export function generateChokidarShimModuleCode(): string {
  return `
// ── chokidar shim (generated by src/real-vite-hmr.ts) ───────────
const _g = globalThis;

class CirrusWatcher {
  constructor(paths, opts) {
    this.paths = Array.isArray(paths) ? paths : [paths];
    this.opts = opts || {};
    this._listeners = { add: [], change: [], unlink: [], addDir: [], unlinkDir: [], ready: [], all: [], error: [], raw: [] };
    this._watched = new Map();
    this._closed = false;
    _g.__cirrusRealWatchers ??= new Set();
    _g.__cirrusRealWatchers.add(this);
    queueMicrotask(() => { if (!this._closed) this.emit('ready'); });
  }
  on(ev, cb) {
    if (this._listeners[ev]) this._listeners[ev].push(cb);
    return this;
  }
  off(ev, cb) {
    if (this._listeners[ev]) {
      const i = this._listeners[ev].indexOf(cb);
      if (i >= 0) this._listeners[ev].splice(i, 1);
    }
    return this;
  }
  emit(ev, ...args) {
    if (this._listeners[ev]) for (const l of this._listeners[ev].slice()) { try { l(...args); } catch (e) { console.warn('[cirrus-chokidar] listener threw:', e?.message); } }
    if (ev !== 'all' && ev !== 'error' && ev !== 'raw' && this._listeners.all) {
      for (const l of this._listeners.all.slice()) { try { l(ev, ...args); } catch {} }
    }
  }
  /** Called by the HMR loop with a VFS event. */
  _dispatch(event, path, oldPath) {
    // Chokidar's event types line up with ours 1:1 except 'rename'.
    if (event === 'rename') {
      if (oldPath) this.emit('unlink', oldPath);
      this.emit('add', path);
      return;
    }
    if (this._listeners[event]) this.emit(event, path);
  }
  add(paths) {
    const arr = Array.isArray(paths) ? paths : [paths];
    for (const p of arr) if (!this.paths.includes(p)) this.paths.push(p);
    return this;
  }
  unwatch(paths) {
    const arr = Array.isArray(paths) ? paths : [paths];
    this.paths = this.paths.filter((p) => !arr.includes(p));
    return this;
  }
  getWatched() {
    const out = {};
    for (const p of this.paths) out[p] = [];
    return out;
  }
  async close() {
    this._closed = true;
    _g.__cirrusRealWatchers?.delete(this);
  }
  get isReady() { return !this._closed; }
}

export function watch(paths, opts) {
  console.log('[cirrus-chokidar] watch() called with paths=', JSON.stringify(paths).slice(0, 200));
  return new CirrusWatcher(paths, opts);
}
export const FSWatcher = CirrusWatcher;
const _exports = { watch, FSWatcher };
_g.__cirrusChokidarModule = { default: _exports, ..._exports };
export default _exports;
`.trim();
}
