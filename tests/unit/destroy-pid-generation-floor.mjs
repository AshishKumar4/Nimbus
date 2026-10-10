#!/usr/bin/env bun
// destroy-pid-generation-floor — after rpcDestroy, a straggler facet from
// the destroyed session must still be refused IN MEMORY, not just on the
// next boot.
//
// rpcDestroy deliberately re-persists the pre-destroy isolate generation
// after storage.deleteAll(), with a comment explaining why: otherwise the
// next boot restarts at generation 1 and "a straggler facet from a HIGHER
// pre-destroy generation would classify as current-generation (pid >
// pidBase)", landing its output on the destroyed/recreated session.
//
// Pre-fix, that is exactly the state the LIVE instance was left in.
// resetInMemorySessionState installed a fresh SessionProcessSupervisor —
// which starts at pidBase 0 — and never called setPidBase. Since
// isPriorGenerationPid(pid) is `pid > 0 && pid <= pidBase`, a floor of 0
// classifies NOTHING as prior-generation. Storage was correct; memory was
// not.
//
// This test drives the real destroy path and then makes the real straggler
// callbacks (_rpcStdout / _rpcReportExit), rather than asserting on the
// setter, because the setter is not the contract — the refusal is.

import assert from 'node:assert/strict';
import { rpcDestroy, sessionProcesses } from '../../packages/worker/src/session/programmatic.ts';
import { _rpcStdout, _rpcReportExit, PRIOR_GENERATION_EXIT_REASON }
  from '../../packages/worker/src/session/rpc.ts';
import { SessionProcessSupervisor }
  from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { GENERATION_KEY, adoptGeneration, assumeGeneration, generation }
  from '../../packages/fabric/src/generation.ts';

const GEN = 3;

function makeHost() {
  const storage = new Map();
  let deletedAll = false;
  const host = {
    _w1SessionDestroyed: false,
    env: {},
    ctx: {
      getWebSockets: () => [],
      storage: {
        async get(k) { return storage.get(k); },
        async put(k, v) { storage.set(k, v); },
        async delete(k) { storage.delete(k); },
        async deleteAll() { deletedAll = true; storage.clear(); },
        async deleteAlarm() {},
      },
    },
    shell: null,
    shellProcessPid: null,
    // rpcDestroy only needs the exclusive-mutation lease surface.
    sqliteFs: {
      publishedFor: () => null, hasExclusiveMutation: () => false,
      acquireGlobalExclusiveMutation: () => ({ owner: Symbol('destroy') }),
      releaseExclusiveMutation: () => {},
    },
    processes: new SessionProcessSupervisor(),
    portRegistry: new PortRegistry(),
    facetManager: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: null,
    _viteShimPid: null,
    _viteShimPort: null,
    terminal: null,
    runtimeFsBridges: new Map(),
    ensureSqliteFs() {},
    ensureFacetManager() {},
    initSession() {},
  };
  // Mirror what the DO constructor does at boot for generation GEN.
  host.processes.setPidBase(GEN * PID_GEN_STRIDE);
  assumeGeneration(host.ctx, GEN);
  storage.set(GENERATION_KEY, GEN);
  return { host, storage, deletedAll: () => deletedAll };
}

const { host, storage } = makeHost();

// A process spawned by the live, pre-destroy session. Its pid is in this
// generation's range: (GEN * STRIDE, (GEN + 1) * STRIDE].
const victim = host.processes.spawn('node', ['server.js'], '/home/user', { longRunning: true });
assert.ok(victim.pid > GEN * PID_GEN_STRIDE, 'spawned pid is in the current generation range');
assert.ok(victim.pid <= (GEN + 1) * PID_GEN_STRIDE, 'spawned pid is below the next generation');

const straggler = victim.pid;
const result = await rpcDestroy(host, { reason: 'test' });
assert.equal(result.ok, true);

// ── The recreated session runs as a generation it reserved ─────────────
// Its supervisor reserved its generation durably (reserveSessionProcesses)
// before minting any pid, past every one this instance minted: storage
// holds the generation it runs as, and its pids start past it.
assert.ok(generation(host.ctx) > GEN, 'the recreated session runs past the destroyed generation');
assert.equal(storage.get(GENERATION_KEY), generation(host.ctx),
  'the generation the recreated session runs as is the persisted one');
assert.equal(host.processes.pidBase, generation(host.ctx) * PID_GEN_STRIDE,
  'its pid floor is its generation\'s');

// ── The behaviour that floor exists to produce ──────────────────────────
// A facet spawned before the destroy is still alive and still calling back.
// Its output must be dropped, not merged into the recreated session's logs.
await _rpcStdout(host, straggler, new TextEncoder().encode('output from a destroyed session\n'));
assert.deepEqual(host.processes.tailLogs(straggler, { lines: 10 }), [],
  'straggler stdout must be refused, not buffered into this generation');

// And its exit must be recorded as the attributed prior-generation death
// rather than running the full current-generation lifecycle plumbing.
await _rpcReportExit(host, straggler, 0, '');
const exit = host.processes.getExit(straggler);
assert.ok(exit, 'straggler exit is still recorded');
assert.equal(exit.reason, PRIOR_GENERATION_EXIT_REASON,
  'straggler exit must be attributed to the instance reset');

// ── A pid issued by the NEW generation is not refused ───────────────────
// The floor must reject the old range without swallowing the new one.
const fresh = host.processes.spawn('sh', [], '/home/user');
assert.ok(fresh.pid > generation(host.ctx) * PID_GEN_STRIDE,
  'a post-destroy spawn allocates above the new floor');
await _rpcStdout(host, fresh.pid, new TextEncoder().encode('hello\n'));
const freshLogs = host.processes.tailLogs(fresh.pid, { lines: 10 });
assert.equal(freshLogs.length, 1, 'current-generation output is still buffered');
assert.equal(freshLogs[0].data, 'hello\n');

// ── Pids never repeat through a destroy and a recreate ──────────────────
// Every live supervisor reserves its generation durably before it mints a
// pid (reserveSessionProcesses), and one minting into the next stride
// raises it. A fresh context (the next boot, after a crash) adopts past
// every pid either the destroyed or the recreated session minted. Red
// before: the recreated session ran as a generation storage did not hold,
// and the next boot adopted it again and reissued its first pid.
const freshContext = (storage) => ({ storage: { get: async (k) => storage.get(k), put: async (k, v) => { storage.set(k, v); } } });
for (const crossing of [false, true]) {
  const { host, storage } = makeHost();
  host.processes = sessionProcesses(host.ctx);
  host.processes.setPidBase((GEN + 1) * PID_GEN_STRIDE - 2);
  const minted = [];
  for (let i = 0; i < 4; i++) minted.push(host.processes.spawn('sh', [], '/home/user').pid);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rpcDestroy(host, { reason: 'test' });
  assert.ok(host.processes.pidBase >= Math.max(...minted), `the post-destroy floor ${host.processes.pidBase} is not past the last pid ${Math.max(...minted)}`);
  // One fresh pid; or, crossing, enough to reach the next stride.
  if (crossing) host.processes.setPidBase(host.processes.pidBase + PID_GEN_STRIDE - 2);
  for (let i = 0; i < (crossing ? 4 : 1); i++) minted.push(host.processes.spawn('sh', [], '/home/user').pid);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const next = freshContext(storage);
  await adoptGeneration(next);
  assert.ok(generation(next) * PID_GEN_STRIDE >= Math.max(...minted),
    `${crossing ? 'crossing: ' : ''}the next boot's base ${generation(next) * PID_GEN_STRIDE} is not past the last pid ${Math.max(...minted)}`);
}

console.log('destroy-pid-generation-floor: OK');
