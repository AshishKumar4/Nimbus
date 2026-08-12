#!/usr/bin/env bun
// A response ROUTED to a resident Node server is a durability boundary.
//
// `resident-node-request-vfs-durability` pins that a writeFileSync inside a
// request handler is visible through the supervisor VFS by the time the
// response returns — but it exercises the generated worker directly, so it
// never crosses the leg routing actually adds.
//
// The two directions are not symmetric. The handler's write goes STRAIGHT to
// the session over the facet's SUPERVISOR binding. The response takes one more
// hop than the write does: out of the facet, back through PortRegistry's route
// target. That asymmetry is asserted here through the real routing leg rather
// than argued about.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { residentFacetName } from '../../packages/worker/src/loaders/workerd-facet-host.ts';
import { createFacetWorld, createFacetCtx, createProcessFacetCtx } from './facet-host-harness.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

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
const supervisorProps = [];

setCtxExports({ SupervisorRPC: ({ props }) => makeSupervisor(props) });

/**
 * Evaluate the generated worker the facet's module map carries and run it as
 * the process — the real program, not a stand-in for it.
 */
const world = createFacetWorld(async (config, info) => {
  const source = config.modules['worker.js'].replace(
    'import { DurableObject } from "cloudflare:workers";',
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  );
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const generated = await import(url);
    const supervisor = config.env.SUPERVISOR;
    supervisorProps.push(supervisor.props);
    return new generated.NimbusProcess(createProcessFacetCtx(info.facetName), { SUPERVISOR: supervisor });
  } finally {
    URL.revokeObjectURL(url);
  }
});

const env = {
  LOADER: world.loader,
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

const ctx = createFacetCtx(world, 'routed-durability-session');
const processes = new SessionProcessSupervisor();
const ports = new PortRegistry();
const manager = new FacetManager(ctx, env, processes, ports, processHostFor, {});
const harness = createSqliteVfsTestHarness();
sessionVfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(sessionVfs);

delete globalThis.__portRegistry;

const spawned = await manager.spawnNode(`
const fs = require('node:fs');
const http = require('node:http');
http.createServer((req, res) => {
  fs.writeFileSync('/home/user/routed-write.txt', req.url.slice(1));
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok:' + req.url);
}).listen(${PORT});
`, {
  command: 'node routed-server.js',
  filename: '/home/user/routed-server.js',
  cwd: '/home/user',
  port: PORT,
});

// The process really is a facet of this session, and its syscalls come home.
// Named for its reusable slot, not its pid (loaders/process-fabric).
assert.deepEqual(world.liveFacets(), [residentFacetName(0)],
  'the node process is the session\'s facet for that pid');
assert.ok(
  supervisorProps.every((p) => p.doId === 'routed-durability-session'),
  'the facet SUPERVISOR is minted for the SESSION, so writes land on the user session',
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
    durable.get('home/user/routed-write.txt'),
    'first',
    'the handler write is durable on the coordinator before the routed response returns',
  );
  assert.deepEqual(
    order,
    ['write', 'response'],
    'the routing hop is entirely downstream of the write, so it cannot overtake it',
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
  assert.equal(durable.get('home/user/routed-write.txt'), 'second');
  assert.deepEqual(order, ['write', 'response']);
}

// The routed requests reached the ONE program the user started — routing must
// not have booted a second copy to answer with.
assert.equal(world.boots.length, 1, 'routing boots no second copy of the program');
assert.equal(processes.get(spawned.pid)?.state, 'running');

console.log('resident-node-routed-request-durability: ok');
