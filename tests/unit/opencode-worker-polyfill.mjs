#!/usr/bin/env bun
// Unit test for the in-isolate Web Worker polyfill (opencode-facet-runner.ts →
// WORKER_POLYFILL_SRC). OpenTUI runs its syntax-highlight tree-sitter parser as
// `new Worker("./parser.worker.js")` and talks to it over birpc on the worker
// message channel; workerd has no real Worker, so the polyfill runs the parser
// module in the client's isolate.
//
// Contract under test:
//   - "./parser.worker.js" imports the real staged module: the polyfill claims
//     a per-worker context, buffers pre-handler messages, and bridges both
//     directions over opencode's EXACT Rpc contract.
//   - opencode's API-server worker is a fail-loud sentinel. A Nimbus TUI
//     attaches to the `opencode serve` facet over HTTP, so no supported path
//     spawns it and it is neither built nor staged; both names upstream's
//     resolver can produce (worker.js, worker.ts) throw at construction, and
//     nothing is imported.
//
// This test installs the polyfill (globalThis.Worker) and drives opencode's
// EXACT Rpc.client contract against the parser worker.

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

// ── 4: the API-server worker is a fail-loud sentinel, and imports nothing ────
// Upstream's resolver (cli/cmd/tui/thread.ts target()) can only ever name the
// built worker.js or the worker.ts source URL it falls back to. Both must throw
// at construction, and no module import may be attempted for either.
let imported = null;
globalThis.__nimbusWorkerImport = async (specifier) => {
  imported = specifier;
};
for (const spec of [
  './worker.js',
  'worker.js',
  new URL('file:///opencode/cli/cmd/tui/worker.js'),
  new URL('file:///opencode/cli/cmd/tui/worker.ts'),
]) {
  assert.throws(
    () => new Worker(spec, { env: { OPENCODE_PROCESS_ROLE: 'worker' } }),
    /API-server worker .* is never built or staged/,
    `spawning the API-server worker fails loud: ${spec}`,
  );
}
assert.equal(imported, null, 'no module was imported for the API-server worker');
console.log('  [4] the API-server worker fails loud at construction and imports nothing');

// ── 5: unknown spec fails loud ───────────────────────────────────────────────
assert.throws(
  () => new Worker('./mystery.js', {}),
  /unsupported in-isolate Worker target/,
  'an unrecognized Worker target fails loud (no silent no-op)',
);
assert.equal(imported, null, 'an unrecognized Worker target imports nothing');
console.log('  [5] an unrecognized Worker target fails loud');

console.log(
  'opencode-worker-polyfill OK: parser worker bridges opencode birpc both ways ' +
    '(buffered pre-handler, ordered, events); the API-server worker is a fail-loud sentinel',
);
