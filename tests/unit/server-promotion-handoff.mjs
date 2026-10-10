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

function handoff({ took = null, resident = async () => {}, signal, stdin, stdinFile, stat = () => ({ ino: 1, revision: 1, size: 5, mtime: 1, ctime: 1 }) } = {}) {
  const processes = new SessionProcessSupervisor();
  const entry = processes.spawn('node srv.js', ['node', 'srv.js'], '/');
  const unread = [], spawned = [], announced = [], learned = [];
  const manager = Object.assign(Object.create(FacetManager.prototype), {
    ctx: {}, processes, filesystem: { bind: () => ({ stat: (path) => stat(path) }) },
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
    env: stdin === undefined && stdinFile === undefined ? { NIMBUS_CP_CHILD_PID: String(entry.pid) } : {}, signal,
    ...(stdin !== undefined ? { stdin } : {}),
    ...(stdinFile !== undefined ? { stdinFile } : {}),
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
  assert.equal(h.spawned[0].resume.replay.listen, true);
  assert.equal(h.spawned[0].resume.stdinAtLeast, 5, 'the resident takes it again before it replays');
  assert.deepEqual(h.announced, [h.entry.pid]);
  assert.equal(h.learned.length, 1);
}

// Its stdin given whole: the resident is given it again.
{
  const h = handoff({ stdin: 'hello' });
  assert.equal((await h.done).promotedPid, h.entry.pid);
  assert.equal(h.spawned[0].stdin, 'hello', 'the resident reads the same stdin');
}

// Its \`< file\`: read again by the resident from where the run read it.
{
  const h = handoff({ stdinFile: { path: '/home/user/in.txt', offset: 3, syncRead: false } });
  assert.equal((await h.done).promotedPid, h.entry.pid);
  assert.deepEqual(h.spawned[0].resume.stdinFile, { path: '/home/user/in.txt', offset: 3, syncRead: true }, 'the resident reads the same file, from the same offset');
}

// The file changed between the run and the resident: it fails, naming that.
{
  let version = 1;
  const h = handoff({
    stdinFile: { path: '/home/user/in.txt', offset: 0, syncRead: false },
    stat: () => ({ ino: 1, revision: version, size: 5, mtime: version, ctime: version }),
    resident: async () => { version = 2; },
  });
  const result = await h.done;
  assert.equal(result.exitCode, 1, JSON.stringify(result));
  assert.match(h.processes.getExit(h.entry.pid)?.reason ?? '', /its stdin, \/home\/user\/in\.txt, changed while it was run again/);
}

// Its file's stat throws (EACCES), as the bridge throws it, synchronously:
// that is no identity, the same before and after, and the launch goes on
// through its own end; it never escapes it and leaves the process half run.
{
  const h = handoff({
    stdinFile: { path: '/home/user/in.txt', offset: 0, syncRead: false },
    stat: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
  });
  const result = await h.done.catch((error) => ({ error: error.message }));
  assert.equal(result.error, undefined, `the launch ended on its own path: ${JSON.stringify(result)}`);
  assert.equal(result.promotedPid, h.entry.pid);
  assert.equal(h.processes.get(h.entry.pid).state, 'running', 'its resident runs, as the process');
}

// Aborted while its file is checked after the resident booted: the resident
// is ended and the abort honored, not a live server returned.
{
  const controller = new AbortController();
  let calls = 0, release;
  const h = handoff({
    signal: controller.signal,
    stdinFile: { path: '/home/user/in.txt', offset: 0, syncRead: false },
    stat: () => (++calls === 1 ? { ino: 1, revision: 1, size: 5, mtime: 1, ctime: 1 }
      : new Promise((resolve) => { release = () => resolve({ ino: 1, revision: 1, size: 5, mtime: 1, ctime: 1 }); })),
  });
  while (!release) await null;
  controller.abort();
  release();
  const result = await h.done;
  assert.equal(result.promotedPid, undefined, `not a server: ${JSON.stringify(result)}`);
  assert.equal(result.exitCode, 130);
  assert.equal(h.processes.get(h.entry.pid).state, 'killed');
  assert.deepEqual(h.announced, []);
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
