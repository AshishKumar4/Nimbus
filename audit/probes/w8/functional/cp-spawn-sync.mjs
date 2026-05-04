#!/usr/bin/env bun
// W8 functional: child_process.spawnSync — fake-sync.
// Not real-sync (V8 + Workers can't true-block) but returns the
// {stdout, stderr, status} shape cross-spawn.sync expects.

import { ok, eq, includes, summary, group } from '../_tap.mjs';
import { makeShimHost, makeMockSupervisor } from '../_shim-host.mjs';

await group('cp-spawn-sync', async () => {
  const sup = makeMockSupervisor();
  const host = await makeShimHost(sup);
  const cp = host.childProcessMod;

  // Note: spawnSync is "fake sync" — to drain the underlying async work
  // the test driver is expected to do at least one `await` after the
  // call. Real facets see this same drain via __pendingIO settling.
  const result = cp.spawnSync('echo', ['hi-from-sync']);
  // Allow async tail to complete (this is the documented Phase-1 limit)
  await host.drainPending();
  await host.pause(50);
  await host.drainPending();

  // Either the result is fully populated synchronously OR has a
  // .__deferred promise the host can await. Tests support both:
  if (result && typeof result.then === 'function') {
    const r2 = await result;
    eq('status 0', r2.status, 0);
    includes('stdout has hi-from-sync', String(r2.stdout || ''), 'hi-from-sync');
  } else if (result && result.__deferred) {
    const r2 = await result.__deferred;
    eq('status 0', r2.status, 0);
    includes('stdout has hi-from-sync', String(r2.stdout || ''), 'hi-from-sync');
  } else {
    eq('status 0', result.status, 0);
    includes('stdout has hi-from-sync', String(result.stdout || ''), 'hi-from-sync');
  }
});

summary('cp-spawn-sync');
