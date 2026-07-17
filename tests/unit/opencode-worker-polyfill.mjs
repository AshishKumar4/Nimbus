#!/usr/bin/env bun
// Unit test for the in-isolate Web Worker polyfill (opencode-facet-runner.ts →
// WORKER_POLYFILL_SRC). opencode's TUI is a client/server split: the bare
// `opencode` TUI client spawns its API server as `new Worker("./worker.js")`
// and OpenTUI its parser as `new Worker("./parser.worker.js")`, then talks to
// each over birpc on the worker message channel.
//
// Contract under test (post defect-#20):
//   - "./parser.worker.js" imports the real staged module: the polyfill claims
//     a per-worker context, buffers pre-handler messages, and bridges both
//     directions over opencode's EXACT Rpc contract.
//   - "./worker.js" is NEVER imported. A Nimbus attach facet always talks to
//     the remote `opencode serve` facet, and importing worker.js's chunk graph
//     into a live facet kills the production workerd process (defect #20).
//     The polyfill answers the worker RPC surface with an in-polyfill stub.
//
// This test installs the polyfill (globalThis.Worker), drives opencode's EXACT
// Rpc.client contract against both worker kinds, and asserts the round-trips.

import assert from 'node:assert/strict';
import { WORKER_POLYFILL_SRC } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';

// ── opencode's util/rpc.ts, verbatim contract ────────────────────────────────
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
// client(): the TUI side, talking to the Worker instance (handles rpc.error
// exactly like opencode's client does — reject with Error(message)).
function rpcClient(target) {
  const pending = new Map();
  const listeners = new Map();
  let id = 0;
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data);
    if (parsed.type === 'rpc.result') {
      const entry = pending.get(parsed.id);
      if (entry) { entry.resolve(parsed.result); pending.delete(parsed.id); }
    }
    if (parsed.type === 'rpc.error') {
      const entry = pending.get(parsed.id);
      if (entry) { entry.reject(new Error(parsed.error)); pending.delete(parsed.id); }
    }
    if (parsed.type === 'rpc.event') {
      const handlers = listeners.get(parsed.event);
      if (handlers) for (const h of handlers) h(parsed.data);
    }
  };
  return {
    call(method, input) {
      const requestId = id++;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
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

let eventEmitter = null; // parser-side scope, captured so we can emit later

// Stub the worker-module import for the PARSER path: simulate a worker
// top-level with awaits BEFORE Rpc.listen — the client's first call arrives
// before the handler is installed (exercises pre-handler buffering).
globalThis.__nimbusWorkerImport = async (specifier) => {
  assert.equal(specifier, 'parser.worker.js', 'only the parser worker is ever imported');
  const scope = globalThis.__nimbusWorkerClaim();
  eventEmitter = scope;
  // Two awaited microtasks model a worker top-level `await` before listen.
  await Promise.resolve();
  await Promise.resolve();
  rpcListen(scope, {
    async ping(input) { return { echoed: input.url }; },
  });
};

const Worker = installPolyfill();
assert.equal(typeof Worker, 'function', 'polyfill installed globalThis.Worker');

// ── 1 + 2: parser spawn, pre-handler buffering, both directions ──────────────
const parser = new Worker(new URL('file:///opencode/parser.worker.js'), {});
const parserClient = rpcClient(parser);
const first = await parserClient.call('ping', { url: 'http://opencode.internal/x' });
assert.deepEqual(first, { echoed: 'http://opencode.internal/x' }, 'pre-handler call buffered then round-tripped');
console.log('  [1] parser client.call round-trips (pre-handler buffered)');

const events = [];
parserClient.on('global.event', (d) => events.push(d));
rpcEmit(eventEmitter, 'global.event', { kind: 'session.updated', n: 7 });
await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(events, [{ kind: 'session.updated', n: 7 }], 'worker event delivered to client.on');
console.log('  [2] worker-emitted event reaches the client subscriber');

// ── ordering: a burst of buffered calls resolves in order ────────────────────
const parser2 = new Worker('parser.worker.js', {});
const client2 = rpcClient(parser2);
const calls = await Promise.all([
  client2.call('ping', { url: 'a' }),
  client2.call('ping', { url: 'b' }),
  client2.call('ping', { url: 'c' }),
]);
assert.deepEqual(calls.map((c) => c.echoed), ['a', 'b', 'c'], 'buffered burst resolves in order');
console.log('  [3] a burst of pre-handler calls resolves in order');

// ── 4: worker.js is answered by the stub, never imported ─────────────────────
globalThis.__nimbusWorkerImport = async () => {
  throw new Error('worker.js must never be imported (defect #20)');
};
const realFetch = globalThis.fetch;
let fetched = null;
globalThis.fetch = async (url, init) => {
  fetched = { url, init };
  return new Response('remote-body', { status: 201, headers: { 'x-nimbus': 'yes' } });
};
try {
  const server = new Worker('./worker.js', { env: { OPENCODE_PROCESS_ROLE: 'worker' } });
  const serverClient = rpcClient(server);
  assert.equal(await serverClient.call('checkUpgrade', {}), undefined, 'checkUpgrade is a stub no-op');
  assert.equal(await serverClient.call('reload', {}), undefined, 'reload is a stub no-op');
  assert.equal(await serverClient.call('snapshot', {}), null, 'snapshot returns null');
  const proxied = await serverClient.call('fetch', {
    url: 'http://127.0.0.1:4096/doc',
    method: 'GET',
    headers: { a: 'b' },
  });
  assert.deepEqual(fetched, {
    url: 'http://127.0.0.1:4096/doc',
    init: { method: 'GET', headers: { a: 'b' }, body: undefined },
  }, 'stub fetch forwards url/method/headers/body');
  assert.equal(proxied.status, 201, 'stub fetch maps status');
  assert.equal(proxied.headers['x-nimbus'], 'yes', 'stub fetch maps headers');
  assert.equal(proxied.body, 'remote-body', 'stub fetch maps body text');
  await assert.rejects(
    () => serverClient.call('server', {}),
    /does not host the opencode server/,
    'server() fails loud — the serve facet owns the port',
  );
  await assert.rejects(
    () => serverClient.call('mystery', {}),
    /unsupported TUI worker RPC/,
    'unknown worker RPC fails loud',
  );
} finally {
  globalThis.fetch = realFetch;
}
console.log('  [4] worker.js is stubbed: fetch proxies, lifecycle no-ops, server() and unknowns fail loud');

// ── 5: unknown spec fails loud ───────────────────────────────────────────────
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
  'opencode-worker-polyfill OK: parser worker bridges opencode birpc both ways ' +
    '(buffered pre-handler, ordered, events); worker.js answered by the attach stub, never imported',
);
