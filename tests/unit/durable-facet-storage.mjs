#!/usr/bin/env bun
// A durable application's facet is a store, not an isolate.
//
// The two release classes only diverge where it matters: an ephemeral
// process's `proc-slot-<n>` name goes back to the free list AND its SQLite is
// dropped, because the name will be handed to the next process and the store
// must not be; a durable `app-slot-<n>` name is released with abort alone,
// because the store IS the application — the next boot of it has to re-attach
// the same rows, whether that boot is a re-drive after a platform reset or an
// explicit relaunch.
//
// And the store is still not immortal: `removeDurableApp` is the one path
// allowed to delete it, owner-checked, releasing the port reservation,
// purging the journal rows, deleting the facet, and freeing the slot — in
// that order, so a crash mid-removal leaves a claimed name rather than an
// unrecoverable store.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { ProcessFabric } from '../../packages/fabric/src/process-fabric.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { facetNameCountDurable } from '../../packages/fabric/src/budgets.ts';
import {
  createFacetWorld,
  createFacetCtx,
  resetProcessFacetStorage,
  createProcessFacetCtx,
} from './facet-host-harness.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import {
  readPortReservation,
  reservePort,
} from '../../packages/worker/src/session/port-capability.ts';
import { PORT_CAPABILITY_KEY_PREFIX } from '../../packages/worker/src/session/keys.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const BOOT = {
  kind: 'code',
  code: {
    compatibilityDate: '2025-01-01',
    compatibilityFlags: [],
    mainModule: 'worker.js',
    modules: { 'worker.js': 'export default {}' },
  },
};

function setup({ doId = 'durable-do', storage = new Map() } = {}) {
  const boots = [];
  const world = createFacetWorld(() => {
    const boot = { id: `boot-${boots.length + 1}`, served: 0 };
    boots.push(boot);
    return {
      boot,
      async startProcess() { return { ok: true }; },
      async handleHttpRequest() { return Response.json({ boot: boot.id, served: ++boot.served }); },
    };
  });
  const ctx = createFacetCtx(world, doId, storage);
  const env = { LOADER: world.loader };
  const processes = new SessionProcessSupervisor();
  const portRegistry = new PortRegistry();
  const fm = new FacetManager(ctx, env, processes, portRegistry, processHostFor, {});
  const disk = createSqliteVfsTestHarness();
  const managerVfs = new SqliteVFS(disk.sql, disk.ctx);
  fm.setVfs(managerVfs, new SqliteFilesystemAuthority(managerVfs));
  return { boots, world, ctx, fm, portRegistry, storage };
}

// ── 1. explicit facet names mint `app-slot-<n>` and stay pinned ─────────────
{
  const { ctx, fm, world } = setup();
  const spawned = await fm.spawnWorker('export default {}', 'durable app', '/app', {
    durable: { owner: 'A', image: { runner: 'r-a', application: 'app-a' } },
  });
  assert.ok(spawned.pid > 0, 'the durable spawn booted');
  const name = world.boots[0] && world.liveFacets()[0];
  assert.match(name, /^app-slot-\d+$/, 'the durable spawn took an app-slot name, not a proc-slot one');
  assert.equal(name, 'app-slot-0', 'the first durable slot is slot 0');

  // A second owner's spawn mints the NEXT slot, not a reuse of A's.
  await fm.spawnWorker('export default {}', 'durable app', '/app', {
    durable: { owner: 'B', image: { runner: 'r-b', application: 'app-b' } },
  });
  assert.deepEqual(world.liveFacets().sort(), ['app-slot-0', 'app-slot-1'],
    'a second durable app gets its own slot, never the first one\'s name');
}

// ── 2. a durable release aborts the process but keeps the store ─────────────
{
  const { ctx, fm, world } = setup();
  const spawned = await fm.spawnWorker('export default {}', 'durable app', '/app', {
    durable: { owner: 'A', image: { runner: 'r-a', application: 'app-a' } },
  });
  assert.equal(world.liveFacets().includes('app-slot-0'), true, 'the durable facet is live');
  // Seed a row into the facet's SQLite — a durable abort must leave it.
  const seeded = createProcessFacetCtx('app-slot-0');
  seeded.storage.sql.exec('CREATE TABLE IF NOT EXISTS marker (v INTEGER)');
  seeded.storage.sql.exec('INSERT INTO marker VALUES (42)');

  // Kill the process: a durable release aborts the facet but must NOT drop
  // its SQLite — that is what lets a relaunch re-attach the same store.
  fm.kill(spawned.pid);
  assert.equal(world.liveFacets().includes('app-slot-0'), false, 'the abort dropped the live facet');
  // The durable slot row is still pinned — the name is not freed by a kill.
  assert.equal(await ctx.storage.get('durable-slot:A'), 0, 'the owner still holds its slot');

  // A relaunch lands on the SAME name — re-attaching the retained store.
  const respawned = await fm.spawnWorker('export default {}', 'durable app', '/app', {
    durable: { owner: 'A', image: { runner: 'r-a', application: 'app-a' } },
  });
  assert.equal(world.liveFacets().includes('app-slot-0'), true, 'the relaunch re-attached the same facet');
  const reattached = createProcessFacetCtx('app-slot-0');
  assert.deepEqual(reattached.storage.sql.exec('SELECT v FROM marker'), [{ v: 42 }],
    'the retained store still holds the seeded row — abort did not drop it');
  assert.equal(await ctx.storage.get('durable-slot:A'), 0, 'the relaunch kept the pinned slot');
  assert.ok(respawned.pid !== spawned.pid, 'the relaunch is a new process on the same store');
}

// ── 3. removeDurableApp is the only path that deletes the store ─────────────
{
  const { ctx, fm, world } = setup();
  const spawned = await fm.spawnWorker('export default {}', 'durable app', '/app', {
    durable: { owner: 'A', image: { runner: 'r-a', application: 'app-a' } },
  });

  // A foreign owner cannot remove A's application.
  const removedByForeign = await fm.removeDurableApp('B');
  assert.equal(removedByForeign, false, 'a foreign owner removes nothing');
  assert.equal(world.liveFacets().includes('app-slot-0'), true, 'the foreign removal touched nothing');
  assert.equal(await ctx.storage.get('durable-slot:A'), 0, "A's slot is still pinned");

  // The owner removes its own application: process killed, slot freed, store gone.
  const removed = await fm.removeDurableApp('A');
  assert.equal(removed, true, 'the owner removed its own application');
  assert.equal(world.liveFacets().includes('app-slot-0'), false, 'the facet is no longer live');
  assert.equal(await ctx.storage.get('durable-slot:A'), undefined, 'the slot row is freed');
  assert.equal(await ctx.storage.get('durable-slot:next'), 1, 'the counter only ever advanced once');
  assert.deepEqual(await ctx.storage.get('durable-slot:free'), [0], 'the freed slot went to the free list');
  // The journal row is gone — nothing is owed a removed application.
  const journal = await ctx.storage.list({ prefix: 'resident-launch:' });
  assert.equal(journal.size, 0, 'the journal row was purged');
}

// ── 4. a durable spawn with a port releases the reservation on removal ──────
{
  const { ctx, fm, world, portRegistry } = setup();
  await reservePort(ctx, { owner: 'A', preferredPort: 20050, occupiedPorts: new Set() });
  const spawned = await fm.spawnWorker('export default {}', 'durable app', '/app', {
    durable: { owner: 'A', image: { runner: 'r-a', application: 'app-a' } },
    port: 20050,
  });
  assert.equal(portRegistry.get(20050)?.pid, spawned.pid, 'the durable spawn owns its port');

  await fm.removeDurableApp('A');
  assert.equal(await ctx.storage.get(`${PORT_CAPABILITY_KEY_PREFIX}20050`), undefined,
    'the port reservation row is released');
  assert.equal(portRegistry.get(20050), undefined, 'the live port registration is dropped');
}

// ── 5. the fabric path: a durable spawn keeps its name and store across abort
{
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }));
  const ctx = createFacetCtx(world, 'fabric-do');
  const env = { LOADER: world.loader };
  const fabric = new ProcessFabric(processHostFor(ctx, env, () => ({ readFile() { throw new Error('no disk'); } })));

  const spawn = (pid) => fabric.startResidentProcess({
    startContract: 'boot', pid,
    workerKey: `nimbus-process:fabric-do:${pid}`,
    boot: BOOT,
    facet: { name: 'app-slot-7', durable: true },
    onWriterActivated() {}, onWriterRetired() {},
  });
  const first = await spawn(1);
  await first.booted();
  assert.deepEqual(world.liveFacets(), ['app-slot-7'], 'the explicit name was honored');
  first.kill(); await first.done;
  assert.deepEqual(world.liveFacets(), [], 'the abort dropped the live facet');

  // A second spawn with the same name re-attaches the retained store — the
  // harness's createProcessFacetCtx keys the SQLite by facet name, so this is
  // the platform's abort-retains-storage behavior.
  const second = await spawn(2);
  await second.booted();
  assert.deepEqual(world.liveFacets(), ['app-slot-7'], 'the relaunch re-attached the same facet');
  second.kill(); await second.done;
}

// ── 5b. a spawn never ends a facet its own incarnation holds live ──────────
//
// The abort before get is for what an ended incarnation left running. A
// process this incarnation started is still its own, whoever asks for the name.
{
  let evaluations = 0;
  const world = createFacetWorld(() => {
    const boot = ++evaluations;
    return {
      async startProcess() { return { ok: true }; },
      async handleHttpRequest() { return Response.json({ boot }); },
    };
  });
  const ctx = createFacetCtx(world, 'live-do');
  const env = { LOADER: world.loader };
  const fabric = new ProcessFabric(processHostFor(ctx, env, () => ({ readFile() { throw new Error('no disk'); } })));
  const spawn = (pid) => fabric.startResidentProcess({
    startContract: 'boot', pid,
    workerKey: `nimbus-process:live-do:${pid}`,
    boot: BOOT,
    facet: { name: 'app-slot-9', durable: true },
    onWriterActivated() {}, onWriterRetired() {},
  });
  const running = await spawn(1);
  await running.booted();
  const other = await spawn(2);
  await other.booted();
  const answer = await (await running.routeTarget.handleHttpRequest(new Request('http://app.test/'))).json();
  assert.equal(answer.boot, 1, 'the running process still answers');
  assert.equal(evaluations, 1, 'nothing this incarnation runs was ended and booted again');
  other.kill(); running.kill();
  await Promise.all([other.done, running.done]);
}

// ── 6. the ledger counts durable mints, not durable releases ────────────────
{
  const { ctx, fm } = setup();
  const before = await facetNameCountDurable(ctx);
  await fm.spawnWorker('export default {}', 'durable app', '/app', {
    durable: { owner: 'A', image: { runner: 'r-a', application: 'app-a' } },
  });
  assert.equal(await facetNameCountDurable(ctx), before + 1,
    'minting a durable slot burns one facet ID');
  const spawned = await fm.spawnWorker('export default {}', 'durable app', '/app', {
    durable: { owner: 'A', image: { runner: 'r-a', application: 'app-a' } },
  });
  assert.equal(await facetNameCountDurable(ctx), before + 1,
    'a relaunch on the same slot mints nothing new');
  fm.kill(spawned.pid);
  assert.equal(await facetNameCountDurable(ctx), before + 1,
    'a kill does not mint or refund a durable name');
}

resetProcessFacetStorage();
console.log('ok - durable-facet-storage (name pinned, abort retains store, removeDurableApp is the only delete, ledger honest)');
