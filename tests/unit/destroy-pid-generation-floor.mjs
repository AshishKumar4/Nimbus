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
import { rpcDestroy } from '../../packages/worker/src/session/programmatic.ts';
import { _rpcStdout, _rpcReportExit, PRIOR_GENERATION_EXIT_REASON }
  from '../../packages/worker/src/session/rpc.ts';
import { SessionProcessSupervisor }
  from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { ISOLATE_GEN_KEY } from '../../packages/fabric/src/alarms.ts';

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
      hasExclusiveMutation: () => false,
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
    _w9IsolateGen: GEN,
    _w9IsolateGenPersisted: true,
    ensureSqliteFs() {},
    ensureFacetManager() {},
    initSession() {},
  };
  // Mirror what the DO constructor does at boot for generation GEN.
  host.processes.setPidBase(GEN * PID_GEN_STRIDE);
  storage.set(ISOLATE_GEN_KEY, GEN);
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

// ── Storage keeps the pre-destroy generation ────────────────────────────
// rpcDestroy re-persists it AFTER deleteAll so the next boot bumps to
// GEN + 1. This assertion pins that the in-memory fix did not corrupt the
// persisted value on its way through the destroy path.
assert.equal(storage.get(ISOLATE_GEN_KEY), GEN,
  're-persisted isolate generation must be the PRE-destroy one');

// ── Memory now agrees with storage ──────────────────────────────────────
// The next boot will floor pids at (GEN + 1) * STRIDE. This instance must
// use the same floor for the rest of its life.
assert.equal(host.processes.pidBase, (GEN + 1) * PID_GEN_STRIDE,
  'post-destroy pid floor must match what the next boot will use');
assert.equal(host._w9IsolateGen, GEN + 1,
  'in-memory generation must match the pid floor it implies');
assert.equal(host._w9IsolateGenPersisted, false,
  'the adopted generation is re-derived from storage on the next init');

// ── The behaviour that floor exists to produce ──────────────────────────
// A facet spawned before the destroy is still alive and still calling back.
// Its output must be dropped, not merged into the recreated session's logs.
await _rpcStdout(host, straggler, 'output from a destroyed session\n');
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
assert.ok(fresh.pid > (GEN + 1) * PID_GEN_STRIDE,
  'a post-destroy spawn allocates above the new floor');
await _rpcStdout(host, fresh.pid, 'hello\n');
const freshLogs = host.processes.tailLogs(fresh.pid, { lines: 10 });
assert.equal(freshLogs.length, 1, 'current-generation output is still buffered');
assert.equal(freshLogs[0].data, 'hello\n');

console.log('destroy-pid-generation-floor: OK');
