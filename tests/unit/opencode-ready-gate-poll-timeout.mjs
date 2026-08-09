#!/usr/bin/env bun
// Behavior test: the opencode serve readiness gate survives a wedged poll.
//
// Root cause this guards against (live-diagnosed 2026-07-16): a /doc poll that
// reaches the serve facet mid-boot can hang until the dispatcher's 30s header
// timeout (opencode's request handler attaches after listen()). The pre-fix
// gate awaited each poll unbounded, so one wedged poll starved the loop past
// the whole readiness budget while the server came up fine behind it — dual
// `opencode` was killed at the deadline even though /doc answered 200
// externally. The gate must cap each poll and keep polling on cadence.
//
// Mirrors the harness of opencode-server-facet-routeable-stub.mjs: the REAL
// FacetManager + PortRegistry, a fake route stub.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { residentFacetName } from '../../packages/worker/src/loaders/process-fabric.ts';
import { createFacetWorld, createFacetCtx } from './facet-host-harness.mjs';

setCtxExports({ SupervisorRPC: (_opts) => ({ __supervisor: true }) });

// One serve facet per pid, each with its own poll behaviour. The module map is
// not built here: the subject is the readiness gate, not what the map contains.
const facetBehaviour = new Map();
const world = createFacetWorld((_config, info) => ({
  async startProcess() { return new Promise(() => {}); }, // resident
  handleHttpRequest: (request) => facetBehaviour.get(info.facetName)(request),
}), { resolveConfig: false });

// The FIRST poll wedges forever (the mid-boot black hole); later polls answer
// 200 (the server finished booting).
let polls = 0;
const wedgeThenServe = () => {
  polls++;
  if (polls === 1) return new Promise(() => {});
  return Promise.resolve(new Response('{"openapi":"3.0.0"}', { status: 200 }));
};

const env = {
  LOADER: world.loader,
  ASSETS: { async fetch() { return new Response('', { status: 404 }); } },
};
const ctx = createFacetCtx(world, 'do-test');
const processes = new SessionProcessSupervisor();
const portRegistry = new PortRegistry();
const fm = new FacetManager(ctx, env, processes, portRegistry, {});

const makeStageSpec = (portArg) => ({
  mode: 'server', argv: ['serve', '--port', String(portArg)], env: {}, cwd: '/home/user',
  cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  stdin: '', vfsBundle: '{}', vfsManifest: '{}', vfsMetadata: '{}',
});

const entry = processes.spawn('opencode serve --port 4096', ['opencode', 'serve'], '/home/user');
const pid = entry.pid;
processes.setLongRunning(pid);
const port = 4096;
// Behaviour is keyed by facet NAME, and a facet is named for its reusable
// slot rather than its pid. This is the first process, so it holds slot 0.
facetBehaviour.set(residentFacetName(0), wedgeThenServe);
await fm._runOpencodeServerFacet({
  pid,
  command: 'opencode serve --port 4096',
  stageSpec: makeStageSpec(port),
}, port);

// The gate must abandon the wedged first poll at its per-poll cap and pass on
// a later poll — well inside the overall budget.
const t0 = Date.now();
await fm._awaitOpencodeServerReady(pid, port, 5000, 150);
const elapsed = Date.now() - t0;
assert.ok(polls >= 2, `a fresh poll fired after the wedged one (polls=${polls})`);
assert.ok(elapsed < 3000, `gate passed without starving on the wedged poll (took ${elapsed}ms)`);

// Fail-loud path: never-200 polls surface the last poll outcome at the deadline.
const entry2 = processes.spawn('opencode serve --port 4097', ['opencode', 'serve'], '/home/user');
processes.setLongRunning(entry2.pid);
facetBehaviour.set(
  residentFacetName(1),
  async () => new Response('nope', { status: 502 }),
);
await fm._runOpencodeServerFacet({
  pid: entry2.pid,
  command: 'opencode serve --port 4097',
  stageSpec: makeStageSpec(4097),
}, 4097);
await assert.rejects(
  () => fm._awaitOpencodeServerReady(entry2.pid, 4097, 800, 150),
  (e) => {
    assert.match(e.message, /did not become ready/);
    assert.match(e.message, /last poll: status 502/, 'the last poll outcome is surfaced');
    return true;
  },
);

console.log('opencode-ready-gate-poll-timeout: ok');
