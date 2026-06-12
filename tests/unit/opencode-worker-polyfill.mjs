#!/usr/bin/env bun
// Unit test for the in-isolate Web Worker polyfill (opencode-facet-runner.ts →
// WORKER_POLYFILL_SRC). opencode's TUI is a client/server split: the bare
// `opencode` TUI client spawns its API server as `new Worker("./worker.js")`
// and OpenTUI its parser as `new Worker("./parser.worker.js")`, then talks to
// each over birpc on the worker message channel. On workerd there is one
// isolate per facet and no real Worker, so the polyfill runs both endpoints in
// one isolate over an in-memory MessageChannel.
//
// This test installs the polyfill (globalThis.Worker), stubs the worker-module
// import with a fake module that wires opencode's EXACT Rpc.listen contract to
// the per-worker context the polyfill claims, then drives opencode's EXACT
// Rpc.client contract against the Worker instance and asserts:
//   1. a client.call(...) round-trips request → server handler → result
//   2. an event the server emits reaches a client.on(...) subscriber
//   3. messages the client posts BEFORE the worker installs its handler are
//      buffered and delivered in order (the worker's top-level has awaits, so
//      the client's first call lands before Rpc.listen runs)
//   4. the `./parser.worker.js` spec resolves and an unknown spec fails loud

import assert from 'node:assert/strict';
import { WORKER_POLYFILL_SRC } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';

// ── opencode's util/rpc.ts, verbatim contract ────────────────────────────────
// listen(): wires the worker's message channel (here the claimed context's
// onmessage / postMessage — what the build-time `define`/banner rebinds bare
// onmessage/postMessage to).
function rpcListen(scope, rpc) {
  scope.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data);
    if (parsed.type === 'rpc.request') {
      const result = await rpc[parsed.method](parsed.input);
      scope.postMessage(JSON.stringify({ type: 'rpc.result', result, id: parsed.id }));
    }
  };
}
function rpcEmit(scope, event, data) {
  scope.postMessage(JSON.stringify({ type: 'rpc.event', event, data }));
}
// client(): the TUI side, talking to the Worker instance.
function rpcClient(target) {
  const pending = new Map();
  const listeners = new Map();
  let id = 0;
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data);
    if (parsed.type === 'rpc.result') {
      const resolve = pending.get(parsed.id);
      if (resolve) { resolve(parsed.result); pending.delete(parsed.id); }
    }
    if (parsed.type === 'rpc.event') {
      const handlers = listeners.get(parsed.event);
      if (handlers) for (const h of handlers) h(parsed.data);
    }
  };
  return {
    call(method, input) {
      const requestId = id++;
      return new Promise((resolve) => {
        pending.set(requestId, resolve);
        target.postMessage(JSON.stringify({ type: 'rpc.request', method, input, id: requestId }));
      });
    },
    on(event, handler) {
      let h = listeners.get(event);
      if (!h) { h = new Set(); listeners.set(event, h); }
      h.add(handler);
      return () => h.delete(handler);
    },
  };
}

// ── install the polyfill (the real production source) ─────────────────────────
const installPolyfill = new Function(WORKER_POLYFILL_SRC + '\nreturn globalThis.Worker;');

let eventEmitter = null; // server-side scope, captured so we can emit later
let serverReady = null;

// Stub the worker-module import: simulate opencode's worker.ts top-level, which
// has awaits BEFORE Rpc.listen — so the client's first call arrives before the
// handler is installed (exercises the polyfill's pre-handler buffering).
globalThis.__nimbusWorkerImport = async (specifier) => {
  assert.equal(specifier, 'worker.js', 'server worker resolves to the staged specifier');
  const scope = globalThis.__nimbusWorkerClaim();
  eventEmitter = scope;
  // Two awaited microtasks model worker.ts's `await Log.init(...)` before listen.
  await Promise.resolve();
  await Promise.resolve();
  rpcListen(scope, {
    async fetch(input) { return { echoed: input.url, role: process.env.OPENCODE_PROCESS_ROLE }; },
    async server() { return { url: 'http://opencode.internal' }; },
    async shutdown() { return undefined; },
  });
  serverReady?.();
};

const Worker = installPolyfill();
assert.equal(typeof Worker, 'function', 'polyfill installed globalThis.Worker');

// ── 1 + 3: spawn, post a call BEFORE the handler exists, assert round-trip ────
const worker = new Worker('./worker.js', { env: { OPENCODE_PROCESS_ROLE: 'worker' } });
const client = rpcClient(worker);

// Fire the first call immediately — the worker's handler is not installed yet
// (its import has pending awaits), so this must be buffered then delivered.
const firstCall = client.call('fetch', { url: 'http://opencode.internal/x' });
const result = await firstCall;
assert.deepEqual(
  result,
  { echoed: 'http://opencode.internal/x', role: 'worker' },
  'client.call round-tripped through the buffered-then-delivered request',
);
console.log('  [1] client.call round-trips request → server handler → result (pre-handler buffered)');

// ── 2: server-emitted event reaches a client subscriber ──────────────────────
const events = [];
client.on('global.event', (d) => events.push(d));
rpcEmit(eventEmitter, 'global.event', { kind: 'session.updated', n: 7 });
await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(events, [{ kind: 'session.updated', n: 7 }], 'server event delivered to client.on');
console.log('  [2] server-emitted event reaches the client subscriber');

// ── ordering: a burst of buffered calls resolves in order ────────────────────
const worker2 = new Worker('worker.js', {});
const client2 = rpcClient(worker2);
const calls = await Promise.all([
  client2.call('fetch', { url: 'a' }),
  client2.call('fetch', { url: 'b' }),
  client2.call('fetch', { url: 'c' }),
]);
assert.deepEqual(calls.map((c) => c.echoed), ['a', 'b', 'c'], 'buffered burst resolves in order');
console.log('  [3] a burst of pre-handler calls resolves in order');

// ── 4: parser spec resolves; unknown spec fails loud ─────────────────────────
globalThis.__nimbusWorkerImport = async (specifier) => {
  assert.equal(specifier, 'parser.worker.js', 'parser worker resolves to its staged specifier');
  const scope = globalThis.__nimbusWorkerClaim();
  rpcListen(scope, { async ping() { return 'pong'; } });
};
const parser = new Worker(new URL('file:///opencode/parser.worker.js'), {});
const parserClient = rpcClient(parser);
assert.equal(await parserClient.call('ping', {}), 'pong', 'parser.worker URL spec round-trips');
console.log('  [4] parser.worker.js spec resolves and round-trips');

let threw = false;
try {
  globalThis.__nimbusWorkerImport = async () => {};
  // eslint-disable-next-line no-new
  new Worker('./mystery.js', {});
} catch (e) {
  threw = /unsupported in-isolate Worker target/.test(String(e));
}
assert.ok(threw, 'an unrecognized Worker target fails loud (no silent no-op)');
console.log('  [5] an unrecognized Worker target fails loud');

console.log(
  'opencode-worker-polyfill OK: in-isolate Worker bridges opencode birpc both ways ' +
    '(buffered pre-handler, ordered, events), parser+server specs resolve, unknown fails loud',
);
