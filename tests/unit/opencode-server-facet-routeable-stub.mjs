#!/usr/bin/env bun
// Route-stub binding for the staged opencode SERVE facet (multi-isolate split).
//
// A headless `opencode serve` facet must be routeable exactly the way a
// spawnNode server is: it runs on a KEYED loader entry (LOADER.get, not the
// one-shot LOADER.load) and binds a re-resolvable NimbusLoadedEntrypoint route
// stub for its pid BEFORE boot, so when the http shim's listen() fires
// SUPERVISOR.registerPort the reserved port resolves to a handler that a later
// routing request can re-enter. This pins that decision + the health-gate:
//
//   1. _runOpencodeServerFacet uses the KEYED path and never LOADER.load.
//   2. the pid's port resolves to the bound route stub (loopback + /port/<n>).
//   3. _awaitOpencodeServerReady resolves once /doc answers 200 through the
//      loopback router, and fails loud (with the log tail) if the facet exits.
//
// Mirrors tests/unit/port-registry-routeable-stub.mjs + node-runner-server-
// promotion.mjs: it exercises the REAL PortRegistry + the REAL binding logic in
// FacetManager, not a mock that trivially passes.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';

// A re-resolvable route stub, the shape NimbusLoadedEntrypoint exposes.
function makeRouteStub(bodyText) {
  const seen = [];
  return {
    seen,
    async handleHttpRequest(request) {
      seen.push({ url: request.url, port: request.headers.get('X-Nimbus-Port') });
      return new Response(bodyText, { status: 200, headers: { 'X-Served-By': 'opencode-serve' } });
    },
  };
}

const routeStub = makeRouteStub('{"openapi":"3.0.0"}');
let loaderLoadCalled = false;
let loaderGetKey = null;

// Inject the ctx.exports the keyed route-stub path resolves through.
setCtxExports({
  NimbusLoadedEntrypoint: (_opts) => routeStub,
  SupervisorRPC: (_opts) => ({ __supervisor: true }),
});

const startStub = { async startProcess() { return new Promise(() => {}); } }; // resident
const env = {
  LOADER: {
    load() { loaderLoadCalled = true; throw new Error('one-shot LOADER.load must not be used for a server facet'); },
    get(key, _cb) { loaderGetKey = key; return { getEntrypoint: () => startStub }; },
  },
  ASSETS: { async fetch() { return new Response('', { status: 404 }); } },
};
const ctx = { id: { toString: () => 'do-test' }, waitUntil: (_p) => {} };
const processes = new SessionProcessSupervisor();
const portRegistry = new PortRegistry();
const fm = new FacetManager(ctx, env, processes, portRegistry, {});

// Fabricate the staged facet (bypass the heavy bundle/vfs/wasm assembly that
// _stageOpencodeFacet does — this test targets the routeing decision).
const entry = processes.spawn('opencode serve --port 4096', ['opencode', 'serve'], '/home/user');
const pid = entry.pid;
processes.setLongRunning(pid);
const port = 4096;
const staged = {
  pid,
  command: 'opencode serve --port 4096',
  baseConfig: { mainModule: 'runner.js', modules: { 'runner.js': '' } },
  supervisorBinding: { __supervisor: true },
};

const result = await fm._runOpencodeServerFacet(staged, port);

// ── 1. keyed path, never the one-shot LOADER.load ────────────────────────────
assert.equal(loaderLoadCalled, false, 'server facet must not use the one-shot LOADER.load');
assert.equal(loaderGetKey, `nimbus-process:do-test:${pid}`, 'keyed LOADER.get on the pid workerKey');
assert.equal(result.pid, pid);
assert.equal(result.exitCode, 0);

// ── 2. the pid's port resolves to the bound route stub ───────────────────────
const portEntry = portRegistry.get(port);
assert.ok(portEntry, 'port reserved after _runOpencodeServerFacet');
assert.ok(portEntry.facetStub, 'port resolves to the bound (re-resolvable) route stub');
assert.deepEqual(portRegistry.getRouteablePortsByPid(pid), [port], 'pid owns a routeable port');

const res = await portRegistry.routeRequest(
  port, new Request(`http://127.0.0.1:${port}/doc`), '/doc',
);
assert.equal(res.status, 200, 'loopback/`/port/<n>` reaches the serve facet');
assert.equal(res.headers.get('X-Served-By'), 'opencode-serve');
assert.equal(routeStub.seen.at(-1).port, String(port), 'X-Nimbus-Port threaded to the facet');
assert.equal(new URL(routeStub.seen.at(-1).url).pathname, '/doc');

// ── 3. health-gate resolves when /doc answers 200 ────────────────────────────
await fm._awaitOpencodeServerReady(pid, port, 2000); // resolves fast (already 200)

// ── 3b. health-gate fails loud when the serve facet exits early ──────────────
const dead = processes.spawn('opencode serve --port 9999', ['opencode', 'serve'], '/home/user');
processes.appendOutput(dead.pid, 'stderr', 'ERROR: address in use\n');
processes.exit(dead.pid, 1);
await assert.rejects(
  () => fm._awaitOpencodeServerReady(dead.pid, 9999, 2000),
  (e) => {
    assert.match(e.message, /exited before becoming ready/);
    assert.match(e.message, /address in use/, 'the log tail is surfaced on failure');
    return true;
  },
);

console.log('opencode-server-facet-routeable-stub: ok');
