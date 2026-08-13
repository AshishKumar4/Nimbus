#!/usr/bin/env bun
//
// A launch the platform resets out from under is reported and re-driven.
//
// A resident launch spans many Durable Object turns and keeps its state in
// memory, so an instance reset — "Internal error in Durable Object storage
// caused object to be reset", which the storage layer issues over what one
// turn has outstanding — took the process, the terminal and the work with it
// and said nothing at all. The user typed `pi` and got a dead socket.
//
// What survives the reset is the journal: the launch's own inputs, written
// before its first byte of work and removed when it settles. A row still there
// when a LATER instance reads it is a launch that never ended, and the reader
// knows it is later because the pid in the row is at or below its own pid base
// (process-table.ts, PID_GEN_STRIDE). Re-driving is the same idempotent work
// against the same content-addressed images, so it is a repeat, not a repair.
//
// An instance reset is modelled here the way the platform does it: a new
// FacetManager over the SAME durable storage and the SAME filesystem, whose
// process table starts at the next generation's pid base, and nothing at all
// carried over in memory.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { readSupervisorAllocationBudget } from '../../packages/core/src/observability/heavy-alloc-coord.ts';

setCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

/** The durable half of a session: its storage rows and its filesystem. */
function createSession(label) {
  const storage = new Map();
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const fs = vfs.as(CRED_KERNEL);
  fs.mkdir('home/user/node_modules/dep/lib', { recursive: true, mode: 0o755 });
  fs.writeFile(
    'home/user/node_modules/dep/package.json',
    JSON.stringify({ name: 'dep', main: 'lib/index.js' }),
    { mode: 0o644 },
  );
  fs.writeFile(
    'home/user/node_modules/dep/lib/index.js',
    Array.from({ length: 16 }, (_, i) => `require('./mod${i}');`).join('\n')
      + '\nmodule.exports = 1;\n',
    { mode: 0o644 },
  );
  for (let i = 0; i < 16; i++) {
    fs.writeFile(
      `home/user/node_modules/dep/lib/mod${i}.js`,
      `module.exports = ${i};\n// ${'p'.repeat(400)}\n`,
      { mode: 0o644 },
    );
  }
  return { label, storage, vfs };
}

/**
 * A reset, from the launch's side, is that nothing ever resumes it: the
 * platform destroys the isolate between turns, so a suspended launch simply
 * never runs another chunk.
 *
 * Modelled as a DEAD FLAG the instance's pump checks, flipped right before
 * `crash()`. The flag has to be terminal, and checked again inside the queued
 * pump, for a reason that belongs to the test and not the subject: two
 * instances here share one process-wide allocation lease, so any predicate
 * derived from that lease (as an earlier version's was) turns true again the
 * moment the SUCCESSOR's launch takes it — and the "destroyed" launch rides
 * the successor's lease to a zombie completion. The cut still waits until the
 * launch has passed the lease-holding phase and parked: cutting a lease
 * holder would queue the recovered launch behind a lease no instance is left
 * to release, and the post-lease suspension is also where production measured
 * its mid-launch deaths — in the paced image write.
 */
function parkedPastLease(gen) {
  return gen.manager.hasPendingLaunchTurns && readSupervisorAllocationBudget().current === 0;
}

/** One instance of the session Durable Object. `crashable` marks the one a
 *  test will reset: its storage writes stay pending until a `sync()`, and
 *  `ctx.storage.crash()` — the reset — drops what was never synced, which is
 *  what the platform's rollback did to the journal of a mid-launch death. */
function createInstance(session, generation, { pumpWhile, crashable = false }) {
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }));
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(generation * PID_GEN_STRIDE);
  const notices = [];
  const spawns = [];
  const env = {
    LOADER: world.loader,
    NIMBUS_LAUNCH_CHUNK_BYTES: '2048',
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
  const ctx = createFacetCtx(world, session.label, session.storage, { crashable });
  const manager = new FacetManager(
    ctx,
    env, processes, new PortRegistry(), processHostFor,
    {
      requestLaunchTurn: () => {
        if (!pumpWhile()) return;
        setTimeout(() => {
          if (!pumpWhile()) return;
          void manager.pumpResidentLaunches();
        }, 0);
      },
      notify: (line) => { notices.push(line); },
      onSpawn: (pid, command) => { spawns.push({ pid, command }); },
    },
  );
  manager.setVfs(session.vfs);
  return { ctx, manager, processes, world, notices, spawns };
}

const settle = async (predicate, tries = 400) => {
  for (let i = 0; i < tries && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// ── 1. a reset launch comes back, and the user is told once ───────────────
{
  const session = createSession('reset-and-recover');

  // Generation 1 starts the launch and is reset mid-launch, parked at a
  // suspension past the lease-holding phase.
  let gen1Dead = false;
  const gen1 = createInstance(session, 1, {
    pumpWhile: () => !gen1Dead && readSupervisorAllocationBudget().current > 0,
    crashable: true,
  });
  const started = await gen1.manager.spawnNode("require('dep');", {
    filename: '/home/user/run.js', cwd: '/home/user', command: 'pi', attachedTty: true,
  });
  await settle(() => parkedPastLease(gen1));
  gen1Dead = true;
  assert.equal(gen1.world.configs.size, 0, 'the launch never got far enough to boot a facet');
  // The reset destroys what the dying instance's turns still had outstanding.
  // The journal row survives it only because _journalLaunch synced — measured
  // live, an unsynced row died with its writer and recovery found nothing.
  gen1.ctx.storage.crash();
  assert.ok(
    session.storage.has('resident-launch:' + started.pid),
    'the journal row is durable BEFORE the reset, not merely written',
  );

  // Generation 2 is the instance that replaces it. No alarm survives a death
  // like this one (the map write rolled back with the dying turn) — the
  // trigger that always exists is the reconnect: initSession pumps, and the
  // pump is what recovery is sited on.
  const gen2 = createInstance(session, 2, { pumpWhile: () => true });
  await gen2.manager.pumpResidentLaunches();
  await settle(() => gen2.world.configs.size > 0);

  assert.equal(gen2.notices.length, 1, 'the user is told once, not once per turn');
  assert.match(
    gen2.notices[0], /the session restarted while .* was starting — restarting it/,
    'the line says what happened and what is being done about it',
  );
  assert.ok(gen2.notices[0].includes('pi'), 'and names the command that was lost');
  assert.equal(gen2.notices[0].split('\n').length, 2, 'one line, terminated');

  assert.equal(gen2.spawns.length, 1, 'the launch was re-driven, not merely reported');
  assert.equal(gen2.spawns[0].command, 'pi', 'as the command the user actually asked for');
  assert.ok(
    gen2.spawns[0].pid > 2 * PID_GEN_STRIDE,
    'under a pid of this generation — the one the reset instance held is gone',
  );
  assert.notEqual(gen2.spawns[0].pid, started.pid);
  assert.equal(
    gen2.processes.get(gen2.spawns[0].pid)?.state, 'running',
    'and the process is live in this instance',
  );
  assert.equal(gen2.world.configs.size, 1, 'the re-driven launch built its module map and booted');

  // The launch settled, but the RESIDENT is still running — and the resets
  // measured live strike exactly there, seconds after settle. A row therefore
  // outlives the launch: an instance that replaces gen2 owes the user the
  // running process, with a fresh re-drive budget (its launch proved itself).
  const gen3 = createInstance(session, 3, { pumpWhile: () => true });
  await gen3.manager.pumpResidentLaunches();
  await settle(() => gen3.world.configs.size > 0);
  assert.equal(gen3.notices.length, 1, 'a running resident lost with its instance is reported');
  assert.match(
    gen3.notices[0], /the session restarted while .* was running — restarting it/,
    'and named as running, not starting — the user watched it boot',
  );
  assert.equal(gen3.spawns.length, 1, 'and re-driven');
  assert.equal(
    gen3.processes.get(gen3.spawns[0].pid)?.state, 'running',
    'back to a live process on the replacement instance',
  );

  // The process ends ON PURPOSE: the row is released with it, so a later
  // instance finds nothing — an exited resident must never respawn.
  gen3.manager.kill(gen3.spawns[0].pid);
  await settle(() => !session.storage.has('resident-launch:' + gen3.spawns[0].pid));
  const gen4 = createInstance(session, 4, { pumpWhile: () => true });
  await gen4.manager.pumpResidentLaunches();
  assert.deepEqual(gen4.notices, [], 'a resident that ended leaves nothing to report');
  assert.deepEqual(gen4.spawns, [], 'and nothing to re-drive');
}

// ── 2. the re-drive is not a retry loop ──────────────────────────────────
//
// The reset this recovers from is classified transient and is retryable
// (12/12 upstream, vfs/facet-resident-store.ts). The one that is NOT — the
// object crossing its storage budget, which the platform reports the same way
// — recurs, and a launch that came back from a reset only to be reset again is
// how that looks. It gets reported, not re-driven a second time.
{
  const session = createSession('reset-twice');

  let gen1Dead = false;
  const gen1 = createInstance(session, 1, {
    pumpWhile: () => !gen1Dead && readSupervisorAllocationBudget().current > 0,
    crashable: true,
  });
  await gen1.manager.spawnNode("require('dep');", {
    filename: '/home/user/run.js', cwd: '/home/user', command: 'pi', attachedTty: true,
  });
  await settle(() => parkedPastLease(gen1));
  gen1Dead = true;
  gen1.ctx.storage.crash();

  // Generation 2 re-drives, and is itself reset while doing so. The re-drive's
  // journal sync is a global durability barrier, so it also flushes the
  // recovery's delete of the row it consumed: what this crash leaves behind is
  // exactly one row — the re-drive's own, at attempt 1.
  let gen2Dead = false;
  const gen2 = createInstance(session, 2, {
    pumpWhile: () => !gen2Dead && readSupervisorAllocationBudget().current > 0,
    crashable: true,
  });
  await gen2.manager.pumpResidentLaunches();
  await settle(() => gen2.spawns.length > 0);
  await settle(() => parkedPastLease(gen2));
  gen2Dead = true;
  assert.equal(gen2.spawns.length, 1, 'the first reset earned the launch a re-drive');
  assert.equal(gen2.world.configs.size, 0, 'which this instance was reset out of in turn');
  gen2.ctx.storage.crash();

  const gen3 = createInstance(session, 3, { pumpWhile: () => true });
  await gen3.manager.pumpResidentLaunches();
  await settle(() => gen3.notices.length > 0);

  assert.equal(gen3.notices.length, 1, 'the second loss is reported');
  assert.match(
    gen3.notices[0], /restarted again while .* was starting — leaving it stopped/,
    'and says the command was left stopped rather than pretending it will come back',
  );
  assert.ok(gen3.notices[0].includes('pi'));
  assert.deepEqual(gen3.spawns, [], 'a reset that recurs is not the transient one — no second re-drive');

  const gen4 = createInstance(session, 4, { pumpWhile: () => true });
  await gen4.manager.pumpResidentLaunches();
  assert.deepEqual(gen4.notices, [], 'and the journal is cleared, so the report is not repeated');
}

console.log('resident-launch-survives-instance-reset: OK');
