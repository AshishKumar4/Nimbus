#!/usr/bin/env bun
// Route binding for the staged opencode SERVE facet, end to end through the
// process fabric's PEER placement.
//
// `opencode serve` is a resident server, so it declares `heavy` and its facet
// is hosted on a sibling DO. Nothing above the fabric may notice: the pid still
// owns one re-resolvable route target bound BEFORE boot, so when the http
// shim's listen() fires SUPERVISOR.registerPort the reserved port resolves to a
// handler a later routing request can re-enter. This pins that:
//
//   1. the coordinator DO never materializes the facet config or touches its
//      own Worker Loader — the hosting peer boots the facet.
//   2. the pid's port resolves through the routed-HTTP peer leg (loopback +
//      /port/<n>), byte-identically to a local facet.
//   3. _awaitOpencodeServerReady resolves once /doc answers 200 through the
//      loopback router, and fails loud (with the log tail) if the facet exits.
//
// Mirrors tests/unit/port-registry-routeable-stub.mjs + node-runner-server-
// promotion.mjs: it exercises the REAL PortRegistry, the REAL binding logic in
// FacetManager and the REAL peer-leg RPCs, not a mock that trivially passes.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import {
  _rpcHostProcessProbe,
  _rpcHostProcess,
  _rpcRouteHostedHttp,
  _rpcCancelHostProcess,
} from '../../packages/worker/src/session/rpc.ts';

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
let loaderGetCalled = false;
const nleProps = [];

// Inject the ctx.exports the keyed stubs resolve through. The HOST creates TWO
// NimbusLoadedEntrypoint stubs per serve facet: a stage-carrying START stub
// (assembles the module map in the stateless entrypoint isolate) and a
// code-free ROUTE stub. Neither carries `code` — no session DO may ever
// materialize the ~23 MB opencode module map (the supervisor OOM-reset at the
// 128 MiB isolate cap when it did; live-diagnosed 2026-07-16).
const startStub = { async startProcess() { return new Promise(() => {}); } }; // resident
setCtxExports({
  NimbusLoadedEntrypoint: (opts) => {
    nleProps.push(opts.props);
    assert.equal(opts.props.code, undefined, 'stubs must not pin facet code in props');
    return opts.props.stage ? startStub : routeStub;
  },
  SupervisorRPC: (_opts) => ({ __supervisor: true }),
});

const failingLoader = {
  load() { loaderLoadCalled = true; throw new Error('the DO must not load the facet directly'); },
  get(_key, _cb) { loaderGetCalled = true; throw new Error('the DO must not load the facet directly'); },
};

// The sibling DO that hosts the facet, driven through the REAL peer-leg RPCs.
const peerSelf = {
  _hostedProcesses: new Map(),
  _hostedProcessWaiters: new Map(),
  env: { LOADER: failingLoader },
};
const peerStub = {
  _rpcHostProcessProbe: async () => _rpcHostProcessProbe(peerSelf),
  _rpcHostProcess: (boot, opts) => _rpcHostProcess(peerSelf, boot, opts),
  _rpcRouteHostedHttp: (key, request) => _rpcRouteHostedHttp(peerSelf, key, request),
  _rpcCancelHostProcess: async (key) => _rpcCancelHostProcess(peerSelf, key),
};

const env = {
  LOADER: failingLoader,
  NIMBUS_SESSION: { idFromName: (name) => ({ name }), get: () => peerStub },
  ASSETS: { async fetch() { return new Response('', { status: 404 }); } },
};
const ctx = { id: { toString: () => 'do-test' }, waitUntil: (_p) => {} };
const processes = new SessionProcessSupervisor();
const portRegistry = new PortRegistry();
const fm = new FacetManager(ctx, env, processes, portRegistry, {});

// Fabricate the staged facet (bypass the VFS snapshot that _stageOpencodeFacet
// does — this test targets the routeing decision).
const entry = processes.spawn('opencode serve --port 4096', ['opencode', 'serve'], '/home/user');
const pid = entry.pid;
processes.setLongRunning(pid);
const port = 4096;
const staged = {
  pid,
  command: 'opencode serve --port 4096',
  stageSpec: {
    mode: 'server', argv: ['serve', '--port', '4096'], env: {}, cwd: '/home/user',
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    stdin: '', vfsBundle: '{}', vfsManifest: '{}', vfsMetadata: '{}',
  },
};

const result = await fm._runOpencodeServerFacet(staged, port);
// Peer placement returns as soon as the process is scheduled; the host leg
// boots the facet on the sibling. Settle it before inspecting the peer.
for (let i = 0; i < 100 && nleProps.length < 2; i++) {
  await new Promise((r) => setTimeout(r, 1));
}

// ── 1. keyed NLE stubs; no session DO touches the Worker Loader itself ───────
assert.equal(loaderLoadCalled, false, 'server facet must not use the one-shot LOADER.load');
assert.equal(loaderGetCalled, false, 'no session DO may materialize the facet config');
assert.equal(nleProps.length, 2, 'one stage-carrying start stub + one code-free route stub');
assert.equal(peerSelf._hostedProcesses.size, 1, 'the facet is hosted on the sibling peer');
for (const props of nleProps) {
  assert.equal(props.key, `nimbus-process:do-test:${pid}`, 'keyed on the pid workerKey');
}
assert.ok(nleProps.some((p) => p.stage && p.stage.mode === 'server'), 'start stub carries the stage spec');
assert.ok(nleProps.some((p) => p.stage === undefined), 'route stub is code- and stage-free');
assert.equal(result.pid, pid);
assert.equal(result.exitCode, 0);

// ── 2. the pid's port resolves to the bound route stub ───────────────────────
const portEntry = portRegistry.get(port);
assert.ok(portEntry, 'port reserved after _runOpencodeServerFacet');
assert.ok(portEntry.facetStub, 'port resolves to the bound (re-resolvable) route target');
assert.deepEqual(portRegistry.getRouteablePortsByPid(pid), [port], 'pid owns a routeable port');

const res = await portRegistry.routeRequest(
  port, new Request(`http://127.0.0.1:${port}/doc`), '/doc',
);
assert.equal(res.status, 200, 'loopback/`/port/<n>` reaches the peer-hosted serve facet');
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
