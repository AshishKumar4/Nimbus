#!/usr/bin/env bun
// The embedder subpaths `@nimbus-sh/worker` publishes, and what the composed
// facet manager's `apps` surface answers in their place.
//
// Kinu deep-imported `dist/session/programmatic.js`, `dist/session/routes.js`,
// `dist/session/port-capability.js`, `dist/facets/durable-slots.js` and
// `dist/git/commands.js` because the package's `exports` map stopped short of
// them. Four subpaths now publish the shipped modules an embedder composes
// with — `./workspace-host` (the factory and its types), `./port-capability`,
// `./durable-slots`, `./git` — while `session/programmatic` and
// `session/routes` stay unexported: the four rpc verbs Kinu used from them
// are reachable through the composed manager's `apps` surface.
//
//   1. every new subpath names a source file that exists, a d.ts and a js
//      under dist, in the same three-condition shape as the existing entries;
//   2. `apps.ensureDurableApp` reserves the owner's port with a capability;
//      `apps.listPorts` persists the capability it reports;
//      `apps.routeCapabilityPort` 404s a wrong capability and routes a right
//      one; `apps.removeDurableApp` answers the address it released.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { composeFacetManager } from '../../packages/worker/src/facets/compose.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { readPortExposure, readPortReservation } from '../../packages/worker/src/session/port-capability.ts';
import { PORT_CAPABILITY_KEY_PREFIX } from '../../packages/worker/src/session/keys.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const ROOT = new URL('../../', import.meta.url).pathname;
const WORKER = `${ROOT}packages/worker/`;

// ── 1. the exports map ────────────────────────────────────────────────────
{
  const pkg = JSON.parse(readFileSync(`${WORKER}package.json`, 'utf8'));
  const expected = {
    './workspace-host': 'workspace-host',
    './workspace': 'workspace',
    './facet-host': 'runtime/facet-loader-host',
    './port-capability': 'session/port-capability',
    './durable-slots': 'facets/durable-slots',
    './git': 'git/commands',
  };
  for (const [subpath, module] of Object.entries(expected)) {
    const entry = pkg.exports[subpath];
    assert.ok(entry, `${subpath} is exported`);
    assert.deepEqual(
      entry,
      { workspace: `./src/${module}.ts`, types: `./dist/${module}.d.ts`, import: `./dist/${module}.js` },
      `${subpath} has the same three-condition shape as the existing entries`,
    );
    assert.ok(existsSync(`${WORKER}src/${module}.ts`), `${subpath}: its source exists`);
  }
  for (const hidden of ['./session/programmatic', './session/routes', './programmatic', './routes']) {
    assert.equal(pkg.exports[hidden], undefined, `${hidden} stays unexported`);
  }
  const packaged = pkg.files.includes('dist');
  assert.ok(packaged, 'dist ships');
}

// ── 2. the composed apps surface ──────────────────────────────────────────
{
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest(request) { return Response.json({ served: new URL(request.url).pathname }); },
  }));
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(PID_GEN_STRIDE);
  const portRegistry = new PortRegistry();
  const ctx = createFacetCtx(world, 'embedder-do');
  const disk = createSqliteVfsTestHarness();
  const composed = composeFacetManager({
    ctx,
    env: {
      LOADER: world.loader,
      ASSETS: {
        async fetch(request) {
          const path = new URL(request.url).pathname.replace(/^\//, '');
          return new Response(readFileSync(`${WORKER}public/${path}`), { status: 200 });
        },
      },
    },
    processes,
    portRegistry,
    vfs: new SqliteVFS(disk.sql, disk.ctx),
    hooks: { onExternalExit() {}, notify() {}, requestLaunchTurn() {} },
  });
  const { apps, manager } = composed;

  // ensureDurableApp: a reservation with a minted capability, re-answered
  // identically on a second ask.
  const ensured = await apps.ensureDurableApp({ owner: 'slate:alpha', preferredPort: 20500 });
  assert.equal(ensured.port, 20500, 'the preferred port was reserved');
  assert.match(ensured.capability, /^[a-f0-9]{24}$/, 'with a minted capability');
  assert.equal(ensured.visibility, 'scoped');
  const stored = await readPortReservation(ctx, 20500);
  assert.equal(stored.owner, 'slate:alpha');
  assert.equal(stored.capability, ensured.capability, 'the capability lives on the reservation');
  assert.deepEqual(await apps.ensureDurableApp({ owner: 'slate:alpha' }), ensured, 'idempotent per owner');
  await assert.rejects(apps.ensureDurableApp({ owner: '' }), /owner must be a non-empty string/);

  // The owner's durable worker boots on its reserved port, and the route
  // through the capability reaches it.
  const spawned = await manager.spawnWorker('export default {}', 'slate worker', '/home/user', {
    port: 20500,
    durable: { owner: 'slate:alpha', image: { runner: 'r1', application: 'a1' } },
  });
  assert.equal(portRegistry.get(20500)?.pid, spawned.pid);
  assert.equal(portRegistry.get(20500)?.capability, ensured.capability, 'the registration re-adopted the reservation\'s capability');

  const wrong = await apps.routeCapabilityPort(20500, 'f'.repeat(24), new Request('http://x/anything'), '/anything');
  assert.equal(wrong.status, 404, 'a wrong capability is a 404, never a 403');
  const right = await apps.routeCapabilityPort(20500, ensured.capability, new Request('http://x/hello'), '/hello');
  assert.equal(right.status, 200);
  assert.deepEqual(await right.json(), { served: '/hello' }, 'routed to the process on the port');
  const dead = await apps.routeCapabilityPort(20999, ensured.capability, new Request('http://x/'), '/');
  assert.equal(dead.status, 404, 'a port nothing holds is not distinguishable by a capability either');

  // listPorts persists what it reports.
  const listed = await apps.listPorts();
  assert.deepEqual(listed.map((p) => [p.port, p.pid, p.capability]), [[20500, spawned.pid, ensured.capability]]);
  assert.equal(typeof listed[0].registeredAt, 'number');
  assert.equal((await readPortExposure(ctx, 20500))?.capability, ensured.capability, 'persisted at the moment it was told');

  // removeDurableApp ends the contract and names the address it released.
  const removed = await apps.removeDurableApp('slate:alpha');
  assert.deepEqual(removed, { owner: 'slate:alpha', removed: true, port: 20500 });
  for (let i = 0; i < 200 && processes.get(spawned.pid)?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.notEqual(processes.get(spawned.pid)?.state, 'running', 'the owner\'s process was ended');
  assert.equal(portRegistry.get(20500), undefined, 'and its port released');
  assert.equal(ctx.storage.rows.get(`${PORT_CAPABILITY_KEY_PREFIX}20500`), undefined, 'the reservation is gone');
  assert.deepEqual(await apps.removeDurableApp('slate:alpha'), { owner: 'slate:alpha', removed: false, port: null }, 'a second remove finds nothing');
  await assert.rejects(apps.removeDurableApp(''), /owner must be a non-empty string/);
}

console.log('PASS worker-package-exports-embedder');
