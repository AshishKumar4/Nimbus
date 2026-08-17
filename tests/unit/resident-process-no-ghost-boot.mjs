#!/usr/bin/env bun
// A routed request must never boot a SECOND copy of the user's program.
//
// A resident process (`node server.js`, a python/ruby socket server) runs as a
// DO Facet of the session, and its port is served through that facet's stub. If
// a request arriving after the facet was lost could re-run the facet's start
// callback, the user's module scope would be evaluated again, its side effects
// re-run, and the request answered 200 by a process the user never started —
// with its own memory, while the process they did start is gone.
// Live-reproduced on a local workerd 2026-07-24 under the previous keyed-loader
// scheme: after three more resident servers were spawned in one session, the
// first server's port answered 200 with a different module-scope boot id.
//
// The invariant, asserted here through FacetManager's public spawn surface:
//   1. spawning a resident process evaluates the program EXACTLY ONCE;
//   2. any number of routed requests evaluate it ZERO further times;
//   3. a request that finds the facet gone FAILS LOUD — it never boots a
//      replacement and answers from it.
// A "boot" here is one module evaluation, exactly as it is on the real loader.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/fabric/src/ctx-exports.ts';
import { residentFacetName } from '../../packages/worker/src/loaders/workerd-facet-host.ts';
import { createFacetWorld, createFacetCtx } from './facet-host-harness.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { readFileSync } from 'node:fs';

setCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

/**
 * Stands in for the program the facet runs. Each module evaluation is one BOOT
 * with a fresh module scope, which is what a real second isolate would give the
 * user.
 */
const world = createFacetWorld(() => {
  const boot = { id: `boot-${world.boots.length + 1}`, served: 0 };
  return {
    boot,
    async startProcess() { return { ok: true }; },
    async handleHttpRequest(request) {
      boot.served++;
      return Response.json({ boot: boot.id, served: boot.served, url: new URL(request.url).pathname });
    },
  };
});

const env = {
  LOADER: world.loader,
  // spawnNode stages the node shims from ASSETS (integrity-checked) before it
  // boots anything, so serve the real staged artifact.
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
    },
  },
};
const ctx = createFacetCtx(world, 'do-test');
const processes = new SessionProcessSupervisor();
const portRegistry = new PortRegistry();
const fm = new FacetManager(ctx, env, processes, portRegistry, processHostFor, {});
// A resident process materializes its generated module map in the session's
// image store and boots from the path, so the manager needs the disk every
// real session has.
const harness = createSqliteVfsTestHarness();
fm.setVfs(new SqliteVFS(harness.sql, harness.ctx));

// ── 1. spawning evaluates the user's program exactly once ───────────────────
const spawned = await fm.spawnNode('http.createServer(...).listen(3000)', {
  command: 'node server.js',
  filename: '/home/user/server.js',
  cwd: '/home/user',
  port: 3000,
});
assert.equal(world.boots.length, 1, "spawn evaluates the user's program exactly once");
const firstBoot = world.boots[0].instance.boot;
// Facets are named for a reusable SLOT rather than the pid — a Durable Object
// never reclaims a facet ID, so a name that could not repeat would exhaust the
// index. One process in a fresh session, so it holds the first slot.
const facetName = residentFacetName(0);
assert.deepEqual(world.liveFacets(), [facetName], 'the process IS the session\'s facet for that pid');
assert.equal(world.boots[0].loaderId, `nimbus-process:do-test:${spawned.pid}`,
  'the module map is keyed on the process, so no two processes can share one');

// ── 2. routed requests never evaluate the program again ─────────────────────
for (let i = 0; i < 25; i++) {
  const res = await portRegistry.routeRequest(3000, new Request(`http://s/port/3000/ping?i=${i}`), '/ping');
  assert.equal(res.status, 200, `request ${i} served`);
  const body = await res.json();
  assert.equal(body.boot, firstBoot.id, `request ${i} was answered by the process the user started`);
  assert.equal(body.url, '/ping', 'the inner path reaches the program unchanged');
}
assert.equal(world.boots.length, 1, '25 routed requests booted nothing — no ghost process');
assert.equal(firstBoot.served, 25, 'every request landed on the one running program');

// ── 3. a lost facet fails LOUD instead of booting a replacement ────────────
world.lose(facetName);
const afterLoss = await portRegistry.routeRequest(3000, new Request('http://s/port/3000/ping'), '/ping');
assert.equal(afterLoss.status, 502, 'a lost facet surfaces an error to the caller');
assert.match((await afterLoss.json()).error, /no longer loaded/, 'the error names the real cause');
assert.equal(world.boots.length, 1, 'the loss booted NO replacement — the ghost never happens');

// ── 4b. $PORT is a hint to the program, not a claim on the port ────────────
// The session exports PORT=3000 by default so Express-style scripts find it.
// A long-running spawn must NOT read that as "this process owns 3000", or the
// second server started in a session takes over the first one's port.
{
  const { runFresh } = await import('../../packages/worker/src/runtime/node-runner.ts');
  const owner = portRegistry.get(3000)?.pid;
  await runFresh(fm, 'http.createServer(...).listen(4200)', {
    argv: [], env: { PORT: '3000' }, cwd: '/home/user', filename: '/home/user/c.js',
    command: 'node c.js', forceLongRunning: true,
  });
  assert.equal(portRegistry.get(3000)?.pid, owner,
    'a spawn that merely inherited $PORT did not seize port 3000');
}

// ── 4. a spawn never claims a port it was not asked for ────────────────────
// `runFresh` used to reserve a guessed default (3000) for every long-running
// node invocation, so the second server started in a session took over the
// first one's port: /port/3000 answered from the newest process while the one
// the user started kept running, unreachable. A port a program really binds
// arrives through the http shim's listen() -> SUPERVISOR.registerPort.
{
  const before = portRegistry.getAll().map((e) => `${e.port}:${e.pid}`).sort();
  const second = await fm.spawnNode('http.createServer(...).listen(4200)', {
    command: 'node b.js', filename: '/home/user/b.js', cwd: '/home/user',
  });
  const after = portRegistry.getAll().map((e) => `${e.port}:${e.pid}`).sort();
  assert.deepEqual(after, before, 'a spawn with no requested port reserves nothing');
  const stillA = portRegistry.get(3000);
  assert.ok(stillA && stillA.pid === spawned.pid,
    "port 3000 still belongs to the process that asked for it, not the newest spawn");
  assert.notEqual(second.pid, spawned.pid);
}

console.log('resident-process-no-ghost-boot: ok');
