#!/usr/bin/env bun
// Regression: pid-keyed state OUTLIVES a DO instance reset (hibernatable
// process-terminal WS attachments, persisted w9_proc_logs rows, named loader
// isolate keys, still-running facets), while ProcessTable pids used to restart
// at 1 in every fresh instance — so a surviving tab attached to old pid N
// silently received the NEW pid N's output, persisted logs merged across
// processes, and a named loader key could hand a new spawn the OLD isolate.
// Pids are now allocated per instance generation (isolateGen * PID_GEN_STRIDE)
// so cross-generation collision is impossible by construction.

import assert from 'node:assert/strict';
import { ProcessTable, PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { wireProcessLogSocketBroadcast } from '../../packages/worker/src/runtime/process-logs-api.ts';

// ── generation-disjoint allocation ────────────────────────────────────────
{
  const gen1 = new ProcessTable();
  gen1.setPidBase(1 * PID_GEN_STRIDE);
  const gen1Pids = [gen1.spawn('a', [], '/').pid, gen1.spawn('b', [], '/').pid];

  // A reset: fresh table, next generation.
  const gen2 = new ProcessTable();
  gen2.setPidBase(2 * PID_GEN_STRIDE);
  const gen2Pids = [gen2.spawn('c', [], '/').pid, gen2.spawn('d', [], '/').pid];

  for (const p of gen1Pids) {
    assert.ok(p > 1 * PID_GEN_STRIDE && p <= gen1.pidBase + PID_GEN_STRIDE, `gen1 pid in range: ${p}`);
    assert.ok(p <= gen2.pidBase, `gen1 pid ${p} classified prior-generation by gen2 (pidBase=${gen2.pidBase})`);
  }
  for (const p of gen2Pids) {
    assert.ok(p > gen2.pidBase, `gen2 pid above its base: ${p}`);
    assert.ok(!gen1Pids.includes(p), 'no cross-generation pid collision');
  }
  console.log('  [1] pids are disjoint across instance generations; old pids sit at/below the new base');
}

// ── base is monotonic + idempotent, and default behavior is unchanged ─────
{
  const t = new ProcessTable();
  assert.equal(t.spawn('x', [], '/').pid, 1, 'no base set → legacy pid 1 (unit-test/back-compat behavior)');
  t.setPidBase(PID_GEN_STRIDE);
  assert.equal(t.spawn('y', [], '/').pid, PID_GEN_STRIDE + 1);
  t.setPidBase(PID_GEN_STRIDE); // idempotent
  t.setPidBase(0); // never backwards
  assert.equal(t.spawn('z', [], '/').pid, PID_GEN_STRIDE + 2, 'base never moves backwards');
  console.log('  [2] setPidBase is monotonic and idempotent');
}

// ── surviving WS attachment does not receive the new generation's chunks ──
{
  // Old-generation instance: a socket attached to its pid.
  const oldSup = new SessionProcessSupervisor();
  oldSup.setPidBase(1 * PID_GEN_STRIDE);
  const oldPid = oldSup.spawn('tui', [], '/').pid;

  const makeSocket = (pid) => ({
    pid,
    frames: [],
    deserializeAttachment() { return { kind: 'process-logs', pid: this.pid }; },
    send(s) { this.frames.push(JSON.parse(s)); },
  });
  const survivor = makeSocket(oldPid);

  // The reset: a NEW instance with a fresh supervisor, next generation. The
  // hibernatable socket (attachment keyed on the OLD pid) survives into it.
  const newSup = new SessionProcessSupervisor();
  newSup.setPidBase(2 * PID_GEN_STRIDE);
  const fresh = makeSocket(0);
  const newPid = newSup.spawn('tui', [], '/').pid;
  fresh.pid = newPid;
  wireProcessLogSocketBroadcast(newSup, { getWebSockets: () => [survivor, fresh] });

  newSup.appendOutput(newPid, 'stdout', 'new generation frame');
  assert.equal(survivor.frames.length, 0, 'old-generation attachment receives nothing from the new pid');
  assert.equal(fresh.frames.length, 1, 'the new pid’s own attachment receives its chunk');
  assert.equal(fresh.frames[0].data, 'new generation frame');
  console.log('  [3] a surviving old-generation WS attachment cannot receive the new generation’s output');
}

console.log('pid-generation-uniqueness OK: instance resets can no longer alias pid-keyed state');
