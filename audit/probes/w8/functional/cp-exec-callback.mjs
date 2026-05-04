#!/usr/bin/env bun
// W8 functional: child_process.exec(cmd, cb) returns (err, stdout, stderr).

import { ok, eq, includes, summary, group } from '../_tap.mjs';
import { makeShimHost, makeMockSupervisor } from '../_shim-host.mjs';

await group('cp-exec-callback', async () => {
  const sup = makeMockSupervisor();
  const host = await makeShimHost(sup);
  const cp = host.childProcessMod;

  let received = null;
  cp.exec('echo from-exec', (err, stdout, stderr) => {
    received = { err, stdout: String(stdout || ''), stderr: String(stderr || '') };
  });

  await host.drainPending();
  await host.pause(50);
  await host.drainPending();
  await host.pause(50);
  await host.drainPending();

  ok('callback fired', received !== null);
  eq('err is null', received?.err, null);
  includes('stdout includes from-exec', received?.stdout, 'from-exec');
});

summary('cp-exec-callback');
