#!/usr/bin/env bun
// Route binding for the staged opencode SERVE facet.
//
// `opencode serve` SERVES: it binds a route target into PortRegistry and its
// own readiness gate polls /doc back through that router. The pid owns one
// route target bound BEFORE boot, so when the http shim's listen() fires
// SUPERVISOR.registerPort the reserved port already resolves to a handler a
// later routing request can re-enter. This pins that:
//
//   1. the serve facet is the session's facet for that pid, minted from the
//      session's own loader and keyed on the process;
//   2. the pid's port resolves through the bound route target (loopback +
//      /port/<n>);
//   3. _awaitOpencodeServerReady resolves once /doc answers 200 through the
//      loopback router, and fails loud (with the log tail) if the facet exits.
//
// Mirrors tests/unit/port-registry-routeable-stub.mjs + node-runner-server-
// promotion.mjs: it exercises the REAL PortRegistry and the REAL binding logic
// in FacetManager, not a mock that trivially passes.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { residentFacetName } from '../../packages/worker/src/loaders/workerd-facet-host.ts';
import { createFacetWorld, createFacetCtx } from './facet-host-harness.mjs';

setCtxExports({ SupervisorRPC: (_opts) => ({ __supervisor: true }) });

// The running serve facet. Its module map is not built here: what this test is
// about is the route binding, and the assembler needs the whole artifact.
const seen = [];
const world = createFacetWorld(() => ({
  async startProcess() { return new Promise(() => {}); }, // resident
  async handleHttpRequest(request) {
    seen.push({ url: request.url, port: request.headers.get('X-Nimbus-Port') });
    return new Response('{"openapi":"3.0.0"}', {
      status: 200,
      headers: { 'X-Served-By': 'opencode-serve' },
    });
  },
}), { resolveConfig: false });

const env = {
  LOADER: world.loader,
  ASSETS: { async fetch() { return new Response('', { status: 404 }); } },
};
const ctx = createFacetCtx(world, 'do-test');
const processes = new SessionProcessSupervisor();
const portRegistry = new PortRegistry();
const fm = new FacetManager(ctx, env, processes, portRegistry, processHostFor, {});

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

// ── 1. one facet per process, keyed on the pid ──────────────────────────────
assert.equal(world.boots.length, 1, 'the serve facet evaluated exactly once');
// The facet is named for its reusable slot; the pid identity is carried by the
// loader key asserted just below.
assert.equal(world.boots[0].facetName, residentFacetName(0), 'the facet is the process\'s');
assert.equal(world.boots[0].loaderId, `nimbus-process:do-test:${pid}`, 'keyed on the pid workerKey');
assert.deepEqual(world.liveFacets(), [residentFacetName(0)]);
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
assert.equal(res.status, 200, 'loopback/`/port/<n>` reaches the locally hosted serve facet');
assert.equal(res.headers.get('X-Served-By'), 'opencode-serve');
assert.equal(seen.at(-1).port, String(port), 'X-Nimbus-Port threaded to the facet');
assert.equal(new URL(seen.at(-1).url).pathname, '/doc');

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
