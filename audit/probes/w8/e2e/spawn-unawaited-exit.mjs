#!/usr/bin/env bun
// W8 e2e: spawn with parent that exits without awaiting — output must be
// captured. Per W8-plan §8.5 BLOCKER-1 fix: parent's exit path must
// drain children synchronously via cpDrainOutput.
//
// Test: we simulate a parent facet that calls spawn('echo','hi') then
// immediately exits. We then verify that the supervisor's child log
// captures the stdout — i.e., the drain happened before parent exit
// finalized.
//
// In the unit-test context "parent exit" maps to draining __pendingIO
// once and then snapshotting the supervisor's per-child log buffer.
// In the real-workerd context this corresponds to the facet's
// reportExit being preceded by a synchronous drain of all child PIDs.

import { ok, eq, includes, summary, group } from '../_tap.mjs';
import { makeShimHost, makeMockSupervisor } from '../_shim-host.mjs';

await group('spawn-unawaited-exit', async () => {
  const sup = makeMockSupervisor();
  const host = await makeShimHost(sup);
  const cp = host.childProcessMod;

  // Spawn but DON'T attach a 'data' listener and DON'T await.
  const child = cp.spawn('echo', ['lost-without-drain']);

  // Simulate parent exit-time drain: the implementation must walk
  // __pendingIO and any registered children and call cpDrainOutput.
  // We expose a hook __cpDrainAllChildren on the shim host to make this
  // testable. (Real impl does it from within the reportExit pre-drain.)
  await host.drainPending();
  await host.pause(20);
  await host.drainPending();

  // Now attempt the parent-exit drain.
  if (typeof host.childProcessMod.__cpDrainAllChildren === 'function') {
    await host.childProcessMod.__cpDrainAllChildren();
  }

  await host.drainPending();

  // Verify the supervisor saw a cpDrainOutput for our child.
  const drains = sup.calls.filter(c => c.method === 'cpDrainOutput');
  ok('cpDrainOutput was issued', drains.length >= 1);

  // Verify the supervisor's child state captured the stdout.
  const state = sup.childState.get(child.pid);
  ok('child state present in supervisor', state !== undefined);
  if (state) {
    const all = state.stdoutChunks.map(c => c.data).join('');
    includes('captured stdout', all, 'lost-without-drain');
  }
});

summary('spawn-unawaited-exit');
