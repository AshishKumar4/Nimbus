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

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { handleProcessesListRequest } from '../../packages/worker/src/runtime/process-logs-api.ts';
import { RESIDENT_PROVEN_MS } from '../../packages/fabric/src/fenced-work.ts';
import { launchManager, launchSession } from './lib/facet-launch-harness.mjs';

// The proof a resident ran (fenced-work.ts RESIDENT_PROVEN_MS) is its own
// instance's timer: captured here, and run when a test says the process has
// been up that long. Every other timer runs as it would.
const proofs = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms !== RESIDENT_PROVEN_MS) return realSetTimeout(fn, ms, ...args);
  proofs.push(() => fn(...args));
  return proofs.length;
};
/** Every captured proof timer fires: each process it was set for has run RESIDENT_PROVEN_MS. */
async function runFor(gen) {
  for (const prove of proofs.splice(0)) prove();
  await gen.ctx.storage.sync();
}

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

/** The durable half of a session: its storage rows and its filesystem. */
function createSession(label) {
  const session = launchSession();
  const fs = session.vfs.as(CRED_KERNEL);
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
  return { label, ...session };
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
  return gen.waitingForTurn() && readSupervisorAllocationBudget().current === 0;
}

/** One instance of the session Durable Object. `crashable` marks the one a
 *  test will reset: its storage writes stay pending until a `sync()`, and
 *  `ctx.storage.crash()` — the reset — drops what was never synced, which is
 *  what the platform's rollback did to the journal of a mid-launch death. */
function createInstance(session, generation, { pumpWhile, crashable = false }) {
  const notices = [];
  const spawns = [];
  let waiting = false;
  const { ctx, manager, processes, world } = launchManager(session.label, {
    session, generation, crashable,
    env: { NIMBUS_LAUNCH_CHUNK_BYTES: '2048' },
    hooks: {
      // A launch that asks for a turn this instance will not pump is parked,
      // waiting for one: what the platform's alarm would grant.
      requestLaunchTurn: () => {
        if (!pumpWhile()) { waiting = true; return; }
        waiting = false;
        setTimeout(() => {
          if (!pumpWhile()) return;
          void manager.pumpResidentLaunches();
        }, 0);
      },
      notify: (line) => { notices.push(line); },
      onSpawn: (pid, command) => { spawns.push({ pid, command }); },
    },
  });
  return { ctx, manager, processes, world, notices, spawns, waitingForTurn: () => waiting };
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
  // The journal row survives it only because the journal's write synced — measured
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

  // The restart is visible where the process is, not only in a terminal that
  // the reset disconnected: the process's own output says the session
  // restarted and which pid it was, and the process list reports it.
  const redrivenPid = gen2.spawns[0].pid;
  const firstOutput = gen2.processes.allLogs(redrivenPid).map((chunk) => chunk.data).join('');
  assert.match(
    firstOutput.split('\n')[0],
    new RegExp(`the session restarted while "pi" was starting, so this process restarted; it was pid ${started.pid}`),
    'the process\'s first line of output says the session restarted, and the pid it was',
  );
  const listed = await handleProcessesListRequest(gen2.processes).json();
  assert.deepEqual(
    listed.processes.find((entry) => entry.pid === redrivenPid)?.restartedFrom,
    { pid: started.pid, cause: 'session-restart' },
    'the process list says it is a restart of the lost pid, and why',
  );

  // The launch settled, but the RESIDENT is still running — and the resets
  // measured live strike exactly there, seconds after settle. A row therefore
  // outlives the launch: an instance that replaces gen2 owes the user the
  // running process, with a fresh re-drive budget once it has run for
  // RESIDENT_PROVEN_MS in gen2: then it proved itself, and this reset is not
  // one it causes again in a loop.
  await runFor(gen2);
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
  assert.deepEqual(
    gen3.processes.get(gen3.spawns[0].pid)?.restartedFrom,
    { pid: redrivenPid, cause: 'session-restart' },
    'a second restart names the pid it replaced, the one the first restart started',
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

// ── 3. a restart that keeps recurring is stopped, and the user told why ─────
//
// A process whose new isolate has used about a second of CPU makes Cloudflare
// restart the session (spike/isolate-move), and its re-drive is a new process
// in a new isolate, which does it again: re-driven every time it boots, it
// restarted the session forever. A running resident lost again before it has
// run RESIDENT_PROVEN_MS is left stopped, with the reason.
{
  const session = createSession('reset-loop');

  // Generation 1 boots the resident; the session restarts while it runs.
  const gen1 = createInstance(session, 1, { pumpWhile: () => true, crashable: true });
  const started = await gen1.manager.spawnNode("require('dep');", {
    filename: '/home/user/run.js', cwd: '/home/user', command: 'node server.js', attachedTty: true,
  });
  await settle(() => gen1.world.configs.size > 0);
  await gen1.ctx.storage.sync();
  gen1.ctx.storage.crash();

  // Generation 2 restarts it, and it boots; the session restarts again at once.
  const gen2 = createInstance(session, 2, { pumpWhile: () => true, crashable: true });
  await gen2.manager.pumpResidentLaunches();
  await settle(() => gen2.world.configs.size > 0);
  assert.equal(gen2.spawns.length, 1, 'the first restart re-drives it');
  assert.equal(gen2.processes.get(gen2.spawns[0].pid)?.restartedFrom?.pid, started.pid);
  await gen2.ctx.storage.sync();
  gen2.ctx.storage.crash();
  proofs.splice(0);

  // Time while the session is down is not time the process ran.
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * RESIDENT_PROVEN_MS;
  let gen3;
  try {
    gen3 = createInstance(session, 3, { pumpWhile: () => true });
    await gen3.manager.pumpResidentLaunches();
  } finally {
    Date.now = realNow;
  }
  await settle(() => gen3.notices.length > 0);
  assert.deepEqual(gen3.spawns, [], 'a second restart before it ran RESIDENT_PROVEN_MS is not re-driven, however long the session was down');
  assert.equal(gen3.notices.length, 1);
  assert.match(
    gen3.notices[0],
    new RegExp(`the session restarted again before "node server\\.js" had run ${RESIDENT_PROVEN_MS / 1000} s since its restart, so it is left stopped`),
    'the notice says the restart recurred, and that the process is stopped, not coming back',
  );
  assert.match(gen3.notices[0], /about a second of CPU/, 'and names the cause the platform gives no other sign of');
  assert.match(gen3.notices[0], /start it again with: node server\.js/, 'and how to start it again');
}

// ── 4. a reset storm, then a healthy run, then a storm again ────────────────
//
// The budget is the process's own: a restart it has proved itself after
// (RESIDENT_PROVEN_MS of uptime in one instance) is not counted against the
// next. A run that proves nothing spends it.
{
  const session = createSession('storm-then-healthy');
  const gen1 = createInstance(session, 1, { pumpWhile: () => true, crashable: true });
  await gen1.manager.spawnNode("require('dep');", {
    filename: '/home/user/run.js', cwd: '/home/user', command: 'node server.js', attachedTty: true,
  });
  await settle(() => gen1.world.configs.size > 0);
  await gen1.ctx.storage.sync();
  gen1.ctx.storage.crash();
  proofs.splice(0);

  // Restarted, and this time it runs: it proves itself in gen2.
  const gen2 = createInstance(session, 2, { pumpWhile: () => true, crashable: true });
  await gen2.manager.pumpResidentLaunches();
  await settle(() => gen2.world.configs.size > 0);
  await runFor(gen2);
  gen2.ctx.storage.crash();

  const gen3 = createInstance(session, 3, { pumpWhile: () => true, crashable: true });
  await gen3.manager.pumpResidentLaunches();
  await settle(() => gen3.world.configs.size > 0);
  assert.equal(gen3.spawns.length, 1, 'a restart after a run that proved itself is re-driven');
  assert.match(gen3.notices[0], /restarting it/);
  await gen3.ctx.storage.sync();
  gen3.ctx.storage.crash();
  proofs.splice(0);

  const gen4 = createInstance(session, 4, { pumpWhile: () => true });
  await gen4.manager.pumpResidentLaunches();
  await settle(() => gen4.notices.length > 0);
  assert.deepEqual(gen4.spawns, [], 'a restart after a run that proved nothing is not');
  assert.match(gen4.notices[0], /left stopped/);
}

console.log('resident-launch-survives-instance-reset: OK');
