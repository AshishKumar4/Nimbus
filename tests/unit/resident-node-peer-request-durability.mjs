#!/usr/bin/env bun
// A resident Node server hosted on a PEER DO is still a durability boundary.
//
// `resident-node-request-vfs-durability` pins that a writeFileSync inside a
// request handler is visible through the supervisor VFS by the time the
// response returns — but it exercises the generated worker directly, so it
// never crosses the leg that peer placement actually adds.
//
// On a peer the two directions are not symmetric. The handler's write goes
// STRAIGHT to the coordinator over its SUPERVISOR binding, which is minted for
// the coordinator wherever the facet runs. The response takes one MORE hop
// than the write does: out of the facet, through the hosting peer's
// `_rpcRouteHostedHttp`, and only then back to the coordinator's PortRegistry.
// That asymmetry is what made node's placement look unsafe, so it is asserted
// here through the real routing leg rather than argued about.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import {
  _rpcHostProcessProbe,
  _rpcHostProcess,
  _rpcAwaitHostedBoot,
  _rpcRouteHostedHttp,
  _rpcCancelHostProcess,
} from '../../packages/worker/src/session/rpc.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';

const PORT = 4471;

/**
 * Stands in for the coordinator's disk. Every write that lands here arrived
 * over a SUPERVISOR binding from inside the facet, whichever DO hosts it.
 */
const durable = new Map();
const order = [];
let writeDelayMs = 0;

function makeSupervisor(props) {
  return {
    props,
    async writeFile(path, content) {
      // Slow the write down so ordering has to be REAL. If the response could
      // overtake it, this is where the race would open.
      if (writeDelayMs > 0) await new Promise((r) => setTimeout(r, writeDelayMs));
      durable.set(String(path).replace(/^\/+/, ''), String(content));
      order.push('write');
    },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
}

let sessionVfs;
/** workerKey → the ONE generated-worker instance hosted for that process. */
const hostedWorkers = new Map();
const supervisorProps = [];

async function instantiateGeneratedWorker(props) {
  const path = props.residentCode.vfsTextModules['worker.js'].replace(/^\/+/, '');
  const source = sessionVfs.as(CRED_KERNEL).readFileString(path).replace(
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    'class WorkerEntrypoint { constructor(env, ctx) { this.env = env; this.ctx = ctx; } }',
  );
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const generated = await import(url);
    supervisorProps.push(props.supervisor);
    return new generated.NimbusNodeProcess(
      { SUPERVISOR: makeSupervisor(props.supervisor) },
      { waitUntil() {} },
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

setCtxExports({
  SupervisorRPC: ({ props }) => makeSupervisor(props),
  NimbusLoadedEntrypoint: ({ props }) => ({
    // A spec-carrying stub boots the program; a code-free one must find the
    // program already running, exactly as the real entrypoint does.
    async startProcess(args) {
      const worker = await instantiateGeneratedWorker(props);
      hostedWorkers.set(props.key, worker);
      return worker.startProcess(args);
    },
    async handleHttpRequest(request) {
      const worker = hostedWorkers.get(props.key);
      if (!worker) throw new Error(`Nimbus: dynamic worker '${props.key}' is no longer loaded (evicted?)`);
      return worker.handleHttpRequest(request);
    },
  }),
});

// The peer runs the REAL host legs, so the routed request below genuinely
// crosses _rpcRouteHostedHttp rather than a simulation of it.
const peerSelf = { _hostedProcesses: new Map(), _hostedProcessWaiters: new Map() };
let routedThroughPeer = 0;
const peerStub = {
  _rpcHostProcessProbe: async () => _rpcHostProcessProbe(peerSelf),
  _rpcHostProcess: (boot, opts) => _rpcHostProcess(peerSelf, boot, opts),
  _rpcAwaitHostedBoot: (key) => _rpcAwaitHostedBoot(peerSelf, key),
  _rpcRouteHostedHttp: (key, wire) => {
    routedThroughPeer++;
    return _rpcRouteHostedHttp(peerSelf, key, wire);
  },
  _rpcCancelHostProcess: async (key) => _rpcCancelHostProcess(peerSelf, key),
};

const env = {
  NIMBUS_SESSION: { idFromName: (name) => ({ name }), get: () => peerStub },
  LOADER: {
    load() { throw new Error('a resident process must not be loaded by the DO'); },
    get() { throw new Error('a resident process must not be loaded by the DO'); },
  },
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(
        readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
        { status: 200 },
      );
    },
  },
};

const ctx = { id: { toString: () => 'peer-durability-coordinator' }, waitUntil() {} };
const processes = new SessionProcessSupervisor();
const ports = new PortRegistry();
const manager = new FacetManager(ctx, env, processes, ports, {});
const harness = createSqliteVfsTestHarness();
sessionVfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(sessionVfs);

delete globalThis.__portRegistry;

const spawned = await manager.spawnNode(`
const fs = require('node:fs');
const http = require('node:http');
http.createServer((req, res) => {
  fs.writeFileSync('/home/user/peer-write.txt', req.url.slice(1));
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok:' + req.url);
}).listen(${PORT});
`, {
  command: 'node peer-server.js',
  filename: '/home/user/peer-server.js',
  cwd: '/home/user',
  port: PORT,
});

// The process really is hosted on a peer, and its syscalls really do come home.
assert.equal(peerSelf._hostedProcesses.size, 1, 'the node process is hosted on a peer DO');
assert.ok(
  supervisorProps.every((p) => p.doId === 'peer-durability-coordinator'),
  'the facet SUPERVISOR is minted for the COORDINATOR, so writes land on the user session',
);

// ── The ordering, through the real routing leg ─────────────────────────────
{
  writeDelayMs = 25;
  order.length = 0;
  const response = await ports.routeRequest(
    PORT,
    new Request(`http://127.0.0.1:${PORT}/first`, { headers: { 'X-Nimbus-Port': String(PORT) } }),
    '/first',
  );
  order.push('response');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok:/first');
  assert.equal(
    durable.get('home/user/peer-write.txt'),
    'first',
    'the handler write is durable on the coordinator before the routed response returns',
  );
  assert.deepEqual(
    order,
    ['write', 'response'],
    'the extra peer hop is entirely downstream of the write, so it cannot overtake it',
  );
}

// Repeat under a longer write delay: a boundary that holds only because the
// write happened to be fast is not a boundary.
{
  writeDelayMs = 120;
  order.length = 0;
  const response = await ports.routeRequest(
    PORT,
    new Request(`http://127.0.0.1:${PORT}/second`, { headers: { 'X-Nimbus-Port': String(PORT) } }),
    '/second',
  );
  order.push('response');
  assert.equal(response.status, 200);
  assert.equal(durable.get('home/user/peer-write.txt'), 'second');
  assert.deepEqual(order, ['write', 'response']);
}

// Both responses really did take the extra hop; without this the ordering
// assertions above could be passing against a local route.
assert.equal(routedThroughPeer, 2, 'every routed response crossed _rpcRouteHostedHttp on the peer');

// The routed request reached the ONE program the user started — the peer leg
// must not have booted a second copy to answer with.
assert.equal(hostedWorkers.size, 1, 'routing through the peer boots no second copy');
assert.equal(processes.get(spawned.pid)?.state, 'running');

console.log('resident-node-peer-request-durability: ok');
