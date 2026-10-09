#!/usr/bin/env bun
// The hand-off of a one-shot that stopped at its first listen to the resident
// that runs it on (FacetManager._promote), with only preparation, the Worker
// call and the resident's launch replaced:
//   - the stdin the one-shot took is put back in front of its channel, and the
//     resident is told to take at least that much before it replays;
//   - a resident that ended while it booted is that exit, not a server;
//   - the command's abort during the hand-off ends the process.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { ReadAheadBudget, STDIN_SYNC_READ_BYTES } from '../../packages/core/src/runtime/stdin-read.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {}, DurableObject: class {} }));
const { FacetManager } = await import('../../packages/worker/src/facets/manager.ts');

const TAPE = { seed: [1, 2, 3, 4], now: [], perf: [], random: '', reads: [5], writes: [] };

function handoff({ took = null, resident = async () => {}, signal } = {}) {
  const processes = new SessionProcessSupervisor();
  const entry = processes.spawn('node srv.js', ['node', 'srv.js'], '/');
  const unread = [], spawned = [], announced = [], learned = [];
  const manager = Object.assign(Object.create(FacetManager.prototype), {
    ctx: {}, processes, filesystem: null,
    hooks: {
      rewindProcessFiles: async () => {},
      onSpawn: (pid) => announced.push(pid),
      stdinChannel: () => ({ read: () => new Promise(() => {}), unread: (back) => unread.push(...back) }),
    },
    stdinReadAhead: new ReadAheadBudget(STDIN_SYNC_READ_BYTES + 1),
    outputGates: new Map(), journals: new Map(), stdinTaken: new Map(),
    netTargets: new Map(), fetchTickets: new Map(), launchBundles: new Map(),
    learnedServers: { learn: async (server) => { learned.push(server); } },
    _launchPacer: () => ({ settle() {}, chunks: 0 }),
    _buildProcessBundle: async () => ({ generatedSourcesReleased: false, bundleKey: 'test' }),
    _staticReadPlan: async () => ({}),
    _installedManifests: async () => '{"files":{}}',
    _recordLaunchLearning: async () => {},
    _w5RecordTermination: () => {},
    portRegistry: new PortRegistry(), processRpcResources: new Map(),
    journalDraining: new Set(), endsAfterDrain: new Map(), _pairedServeFacet: new Map(),
    revokeProcessVfsWriters: () => {},
    _execViaLoader: async () => {
      // The run took stdin before it listened, as the session saw it.
      const taken = manager.stdinTaken.get(entry.pid);
      if (took !== null) { taken.start('run-1'); taken.note(new TextEncoder().encode(took)); }
      return { stop: { v: 3, kind: 'listen', run: 1, out: [], tape: TAPE } };
    },
    // The resident's launch: one whose process ended while its facet was
    // being created is refused, as _spawnResident refuses it; one that
    // ended during its boot returns (`ended`).
    spawnNode: async (_code, opts) => {
      spawned.push(opts);
      const outcome = await resident(entry);
      if (outcome !== 'ended' && processes.get(entry.pid)?.state !== 'running') throw new Error('the process ended while its facet was being created');
      return { pid: entry.pid };
    },
  });
  const done = manager.exec('', {
    skipSpawn: true, callerPid: entry.pid, command: 'node srv.js',
    env: { NIMBUS_CP_CHILD_PID: String(entry.pid) }, signal,
    server: { package: 'srv@1.0.0', bin: 'srv', arg0: '' },
  });
  return { processes, entry, done, unread, spawned, announced, learned };
}

// The stdin it took goes back in front of its channel, and the resident
// takes at least that much before it replays its reads.
{
  const h = handoff({ took: 'hello' });
  const result = await h.done;
  assert.equal(result.promotedPid, h.entry.pid);
  assert.deepEqual(h.unread.map((p) => new TextDecoder().decode(p.data)), ['hello'], 'what the one-shot took is put back');
  assert.equal(h.spawned[0].replay.listen, true);
  assert.equal(h.spawned[0].stdinAtLeast, 5, 'the resident takes it again before it replays');
  assert.deepEqual(h.announced, [h.entry.pid]);
  assert.equal(h.learned.length, 1);
}

// A resident that ended while it booted: its exit, no server.
{
  let processes;
  const ended = handoff({ resident: async (entry) => { processes.exit(entry.pid, 3); return 'ended'; } });
  processes = ended.processes;
  const result = await ended.done;
  assert.equal(result.exitCode, 3, `its exit status: ${JSON.stringify(result)}`);
  assert.equal(result.promotedPid, undefined, 'not a server');
  assert.deepEqual(ended.announced, [], 'not announced as one');
  assert.deepEqual(ended.learned, [], 'and not learned as one');
}

// The command's abort during the hand-off ends the process, killed.
{
  const controller = new AbortController();
  let release;
  const h = handoff({ signal: controller.signal, resident: () => new Promise((resolve) => { release = resolve; }) });
  while (!release) await null;
  controller.abort();
  release();
  const result = await h.done;
  assert.equal(result.exitCode, 130, `aborted: ${JSON.stringify(result)}`);
  assert.equal(h.processes.get(h.entry.pid).state, 'killed');
  assert.deepEqual(h.announced, []);
}

console.log('server-promotion-handoff: stdin taken is put back, a boot that ended is its exit, and an abort ends the process');
