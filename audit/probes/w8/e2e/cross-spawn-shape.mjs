#!/usr/bin/env bun
// W8 e2e: cross-spawn-shape. cross-spawn's spawn() returns a ChildProcess
// with a specific shape; spawnSync() returns {status, stdout, stderr}.
//
// We don't run real cross-spawn here (would need it installed in VFS);
// we replay the calls cross-spawn would make and verify the shapes line
// up.

import { ok, eq, includes, summary, group } from '../_tap.mjs';
import { makeShimHost, makeMockSupervisor } from '../_shim-host.mjs';

await group('cross-spawn shape', async () => {
  const sup = makeMockSupervisor();
  const host = await makeShimHost(sup);
  const cp = host.childProcessMod;

  // 1. cross-spawn-style: spawn returns synchronously
  const child = cp.spawn('echo', ['cross-spawn-test'], {
    cwd: '/home/user',
    env: { PATH: '/usr/bin' },
    stdio: 'inherit',                // common cross-spawn invocation
  });
  ok('child has pid getter', 'pid' in child);
  ok('child has kill method', typeof child.kill === 'function');
  ok('child has on method', typeof child.on === 'function');
  ok('child has stdio', Array.isArray(child.stdio));

  // 2. cross-spawn-style: child events
  let exitFired = false;
  child.on('exit', () => { exitFired = true; });
  let closeFired = false;
  child.on('close', () => { closeFired = true; });
  let errorFired = false;
  child.on('error', () => { errorFired = true; });

  await host.drainPending();
  await host.pause(50);
  await host.drainPending();
  await host.pause(50);
  await host.drainPending();

  ok('exit event fired', exitFired);
  ok('close event fired', closeFired);
  ok('error event NOT fired', errorFired === false);

  // 3. cross-spawn.sync — { status, stdout, stderr } shape
  const r = cp.spawnSync('echo', ['sync-test']);
  await host.drainPending();
  await host.pause(50);
  await host.drainPending();

  // Resolve fake-sync return
  let result = r;
  if (result && typeof result.then === 'function') result = await result;
  else if (result && result.__deferred) result = await result.__deferred;

  ok('result has status', 'status' in result);
  ok('result has stdout', 'stdout' in result);
  ok('result has stderr', 'stderr' in result);
  eq('status 0', result.status, 0);
  includes('stdout includes sync-test', String(result.stdout || ''), 'sync-test');
});

summary('cross-spawn-shape');
