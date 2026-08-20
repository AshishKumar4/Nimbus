// Shared harness for the loom Actor suites.
//
// partyserver imports `cloudflare:workers` at module scope, so the real
// class cannot resolve under bun as-is. The harness registers a bun plugin
// that serves a minimal virtual module in its place — `DurableObject` is a
// two-field base class and `env` an empty bag — which lets the tests drive
// the REAL partyserver Server and the REAL loom Actor, not stand-ins.
//
// IMPORTANT: the plugin must be registered before any loom/partyserver
// module resolves. Static imports hoist above this module's execution, so
// tests must load loom DYNAMICALLY, via loadLoom() below.
//
// partyserver's connection layer calls
// `WebSocket.prototype.(de)serializeAttachment.call(ws)` on arbitrary
// socket objects; the harness installs those methods on bun's WebSocket
// prototype, backed by a plain `_attachment` field on the socket.

import { plugin } from 'bun';
import { Database } from 'bun:sqlite';

plugin({
  name: 'cloudflare-workers-virtual',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      loader: 'object',
      exports: {
        DurableObject: class DurableObject {
          constructor(ctx, env) {
            this.ctx = ctx;
            this.env = env;
          }
        },
        env: {},
      },
    }));
  },
});

// workerd's WebSocket carries READY_STATE_* alongside the standard OPEN
// family; partyserver's hibernating iterator compares against the former.
// bun has only the standard names, and partyserver's own shim fills the
// standard names, not these — so the harness supplies them.
if (!('READY_STATE_OPEN' in WebSocket)) {
  Object.assign(WebSocket, {
    READY_STATE_CONNECTING: 0,
    READY_STATE_OPEN: 1,
    READY_STATE_CLOSING: 2,
    READY_STATE_CLOSED: 3,
  });
}

if (!('serializeAttachment' in WebSocket.prototype)) {
  WebSocket.prototype.serializeAttachment = function serializeAttachment(value) {
    this._attachment = value;
  };
  WebSocket.prototype.deserializeAttachment = function deserializeAttachment() {
    return this._attachment;
  };
}

/** Load the loom modules after the virtual module is in place. */
export async function loadLoom() {
  const [actor, callable, client, protocol, routing, schedules] = await Promise.all([
    import('../../../packages/loom/src/actor.ts'),
    import('../../../packages/loom/src/callable.ts'),
    import('../../../packages/loom/src/client.ts'),
    import('../../../packages/loom/src/protocol.ts'),
    import('../../../packages/loom/src/routing.ts'),
    import('../../../packages/loom/src/schedules.ts'),
  ]);
  return { ...actor, ...callable, ...client, ...protocol, ...routing, ...schedules };
}

/**
 * The durable half of a Durable Object, shared by every incarnation:
 * the KV map, the SQLite database, and the accepted sockets.
 */
export function createBacking() {
  return { kv: new Map(), db: new Database(':memory:'), sockets: [] };
}

/**
 * One incarnation's DurableObjectState. A fresh ctx over the same backing
 * is what a hibernation wake or an instance reset produces.
 */
export function createActorCtx({ name = 'test-actor', backing = createBacking(), exports } = {}) {
  const { kv, db, sockets } = backing;
  const alarms = [];
  const waits = [];
  const ctx = {
    backing,
    alarms,
    id: { name },
    exports,
    storage: {
      sql: {
        exec(query, ...params) {
          if (/^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE|DROP)/i.test(query)) {
            db.query(query).run(...params);
            return [];
          }
          return db.query(query).all(...params);
        },
      },
      async get(key) { return kv.get(key); },
      async put(key, value) { kv.set(key, value); },
      async delete(key) { return kv.delete(key); },
      async list({ prefix }) {
        const found = new Map();
        for (const [key, value] of kv) {
          if (key.startsWith(prefix)) found.set(key, value);
        }
        return found;
      },
      async sync() {},
      setAlarm(at) { alarms.push(at); },
    },
    async blockConcurrencyWhile(fn) { return fn(); },
    acceptWebSocket(ws, tags) {
      ws._tags = tags;
      sockets.push(ws);
    },
    getWebSockets(tag) {
      return tag === undefined ? [...sockets] : sockets.filter((s) => s._tags?.includes(tag));
    },
    getTags(ws) { return ws._tags ?? []; },
    waitUntil(promise) { waits.push(promise.catch(() => {})); },
    async drainWaits() { await Promise.all(waits.splice(0)); },
  };
  return ctx;
}

/**
 * A wake-shaped hibernatable socket: accepted by a previous instance, its
 * attachment already carrying partyserver's `__pk` metadata. Driving
 * `actor.webSocketMessage(ws, ...)` with one is exactly the
 * post-hibernation path.
 */
export function fakeSocket(id, { tags = [], uri = `ws://test/parties/actor/${id}` } = {}) {
  return {
    readyState: 1,
    sent: [],
    closed: null,
    _attachment: { __pk: { id, tags: [id, ...tags], uri }, __user: null },
    _tags: [id, ...tags],
    send(message) { this.sent.push(message); },
    close(code, reason) { this.closed = { code, reason }; this.readyState = 3; },
    serializeAttachment(value) { this._attachment = value; },
    deserializeAttachment() { return this._attachment; },
  };
}

/** Accept a wake-shaped socket into a ctx, as a previous instance did. */
export function attachSocket(ctx, socket) {
  ctx.backing.sockets.push(socket);
  return socket;
}

/** The last JSON frame a fake socket was sent, parsed. */
export function lastFrame(socket) {
  return socket.sent.length > 0 ? JSON.parse(socket.sent[socket.sent.length - 1]) : undefined;
}

/** Every JSON frame a fake socket was sent, parsed. */
export function frames(socket) {
  return socket.sent.map((m) => JSON.parse(m));
}
