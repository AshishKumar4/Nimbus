#!/usr/bin/env bun
// A durable worker spawn is journaled so a platform reset can re-drive it —
// but it must only ever claim a port its owner holds a persisted reservation
// for. Without that check a spawn that names a foreign port would boot, then
// clear the real owner's exposure and register itself over the listener the
// owner still runs. This pins the ownership gate on FacetManager.spawnWorker:
// a durable spawn is refused before it writes the journal, and again after the
// boot if the reservation changed under it.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { createFacetWorld, createFacetCtx } from './facet-host-harness.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { readFileSync } from 'node:fs';
import {
  persistPortCapability,
  readPortExposure,
  readPortReservation,
  releasePortReservation,
  reservePort,
} from '../../packages/worker/src/session/port-capability.ts';
import { PORT_CAPABILITY_KEY_PREFIX } from '../../packages/worker/src/session/keys.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
// A deferred a test can hold: while it is pending, the spawn's handle.booted()
// never resolves, so a reservation can be released or reassigned mid-boot.
// `entered` resolves the moment the runner's startProcess actually runs — the
// journal row and the facet already exist — so a test knows the launch is
// genuinely parked at the boot gate, not merely queued behind preflight.
let bootHold = null;
let bootEntered = null;
const world = createFacetWorld(() => {
  const boot = { id: `boot-${world.boots.length + 1}`, served: 0 };
  return {
    boot,
    async startProcess() {
      if (!bootHold) return { ok: true };
      bootEntered.resolve();
      return bootHold.promise;
    },
    async handleHttpRequest(request) {
      boot.served++;
      return Response.json({ boot: boot.id, served: boot.served });
    },
  };
});

const env = {
  LOADER: world.loader,
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
const disk = createSqliteVfsTestHarness();
const managerVfs = new SqliteVFS(disk.sql, disk.ctx);
fm.setVfs(managerVfs, new SqliteFilesystemAuthority(managerVfs));
const none = new Set();
const CONFLICT = /port reservation conflict: durable worker does not own port/;
const record = (port) => ctx.storage.rows.get(`${PORT_CAPABILITY_KEY_PREFIX}${port}`);
// The reservation host the capability API needs. No owner hook: the stored
// record carries the owner — mirroring one through a hook is exactly the
// setup that masked the persist-time owner overwrite this test now pins.
const capHost = { ctx, portRegistry };

// ── 1. a foreign durable spawn is refused before it ever boots ──────────────
{
  // Owner A holds the reservation AND a live listener on the port.
  await reservePort(ctx, { owner: 'A', preferredPort: 20030, occupiedPorts: none });
  await persistPortCapability(capHost, 20030, 'a'.repeat(24));
  portRegistry.register(20030, 9001); // A's live listener
  const bootsBefore = world.boots.length;
  const portBefore = portRegistry.get(20030);

  await assert.rejects(
    fm.spawnWorker('export default {}', 'worker app', '/app', {
      durable: { owner: 'B', image: { runner: 'r', application: 'b-app' } },
      port: 20030,
    }),
    CONFLICT,
    'a durable spawn that does not own the port is refused',
  );
  assert.equal(world.boots.length, bootsBefore, 'the refused spawn never evaluated the program');
  assert.deepEqual(record(20030), { kind: 'explicit', owner: 'A', capability: 'a'.repeat(24), visibility: 'scoped' }, "the real owner's record is untouched");
  assert.equal(portRegistry.get(20030)?.pid, portBefore.pid, "the owner's listener is still registered");
  assert.equal(portRegistry.get(20030)?.capability, portBefore.capability, "the owner's exposure is intact");
}

// ── 2. the owner's own durable spawn keeps its exposure ─────────────────────
{
  const spawned = await fm.spawnWorker('export default {}', 'worker app', '/app', {
    durable: { owner: 'A', image: { runner: 'r', application: 'a-app' } },
    port: 20030,
  });
  assert.ok(spawned.pid > 0);
  assert.equal(portRegistry.get(20030)?.pid, spawned.pid, 'the owner registers its own port');
  assert.equal(
    portRegistry.get(20030)?.capability,
    'a'.repeat(24),
    'the persisted capability is re-adopted, not retired',
  );
}

// ── 3. a reservation changed mid-boot refuses the spawn ──────────────────────
{
  // B holds a fresh port; its durable spawn is held at boot, then the
  // reservation is released and re-claimed by C before the boot resolves.
  await reservePort(ctx, { owner: 'B', preferredPort: 20040, occupiedPorts: none });
  const bootsBefore = world.boots.length;
  bootHold = defer();
  bootEntered = defer();
  const spawning = fm.spawnWorker('export default {}', 'worker app', '/app', {
    durable: { owner: 'B', image: { runner: 'r', application: 'b-app' } },
    port: 20040,
  });
  const refused = spawning.then(() => 'spawned').catch((e) => e);
  // The launch is really at the boot gate: the runner's startProcess ran, the
  // program was evaluated, and its journal row is durable — this is not the
  // preflight rejecting it.
  await bootEntered.promise;
  assert.equal(world.boots.length, bootsBefore + 1, "B's program was evaluated before the reassignment");
  const bRow = [...ctx.storage.rows.entries()]
    .map(([key, v]) => ({ key, recipe: v?.recipe }))
    .find((r) => r.recipe && r.recipe.owner === 'B' && r.recipe.image?.application === 'b-app');
  assert.ok(bRow, "B's launch is journaled while it is parked at the boot gate");
  // Reassign the reservation while the launch is still parked, then let it boot.
  await releasePortReservation(ctx, { owner: 'B', port: 20040 });
  await reservePort(ctx, { owner: 'C', preferredPort: 20040, occupiedPorts: none });
  bootHold.resolve({ ok: true });
  const outcome = await refused;
  bootHold = null;
  bootEntered = null;
  assert.ok(outcome instanceof Error && CONFLICT.test(outcome.message),
    `the spawn is refused once the reservation changed hands, got ${outcome}`);
  assert.equal(portRegistry.get(20040), undefined, 'the refused spawn installed no listener');
  assert.deepEqual(record(20040), { kind: 'explicit', owner: 'C', capability: null, visibility: 'scoped' }, "C's reassignment stands");
}

// ── 4. a bare reservation (no capability) spawns without minting an exposure ──
{
  await reservePort(ctx, { owner: 'D', preferredPort: 20050, occupiedPorts: none });
  const spawned = await fm.spawnWorker('export default {}', 'worker app', '/app', {
    durable: { owner: 'D', image: { runner: 'r', application: 'd-app' } },
    port: 20050,
  });
  assert.ok(spawned.pid > 0);
  assert.equal(portRegistry.get(20050)?.pid, spawned.pid, 'the owner registers the port');
  assert.equal(await readPortExposure(ctx, 20050), null,
    'a bare reservation stays unexposed — no persisted capability is minted or adopted');
  assert.deepEqual(await readPortReservation(ctx, 20050), { kind: 'explicit', owner: 'D', capability: null, visibility: 'scoped' });
}

// ── 5. an SDK-side persist must not rewrite a durable reservation's owner ────
{
  // The stored record is the only source of truth for owner. persistPortCapability
  // used to rewrite the row with `owner: null` because the portCapabilityOwner
  // hook it read was never implemented — the re-drive preflight then saw a
  // reservation nobody owned, and the release threw 'held by another owner'.
  // capHost carries NO hook: this is the shape the SDK's ports.list()/expose
  // and the route readopt path actually run.
  await reservePort(ctx, { owner: 'E', preferredPort: 20060, occupiedPorts: none });
  const spawned = await fm.spawnWorker('export default {}', 'worker app', '/app', {
    durable: { owner: 'E', image: { runner: 'r', application: 'e-app' } },
    port: 20060,
  });
  assert.ok(spawned.pid > 0);
  // The embedder is told the capability — persist lands it durably.
  await persistPortCapability(capHost, 20060, 'e'.repeat(24));
  assert.deepEqual(
    await readPortReservation(ctx, 20060),
    { kind: 'explicit', owner: 'E', capability: 'e'.repeat(24), visibility: 'scoped' },
    'persisting a capability keeps the stored reservation owner',
  );

  // A re-drive of the same application: the spawn's post-boot re-adopt must
  // still pass its owner gate on the row persist wrote.
  // End the prior incarnation: a second LIVE instance is deliberately ephemeral.
  fm.kill(spawned.pid);
  const redriven = await fm.spawnWorker('export default {}', 'worker app', '/app', {
    durable: { owner: 'E', image: { runner: 'r', application: 'e-app' } },
    port: 20060,
  });
  assert.ok(redriven.pid > 0, 'the re-drive boots under the persisted reservation');
  assert.equal(portRegistry.get(20060)?.capability, 'e'.repeat(24),
    'the persisted capability is re-adopted through the owner-gated path');

  // And the owner can still release its own port.
  assert.equal(await releasePortReservation(ctx, { owner: 'E', port: 20060 }), true,
    'the owner still releases its port after a hookless persist');
}

console.log('resident-worker-reservation: ok');
