#!/usr/bin/env bun
// W8 functional: execFile(file, args, cb) — same as exec but no shell.

import { ok, eq, includes, summary, group } from '../_tap.mjs';
import { makeShimHost, makeMockSupervisor } from '../_shim-host.mjs';

await group('cp-execfile', async () => {
  const sup = makeMockSupervisor();
  const host = await makeShimHost(sup);
  const cp = host.childProcessMod;

  let received = null;
  cp.execFile('echo', ['file-arg'], (err, stdout, stderr) => {
    received = { err, stdout: String(stdout || '') };
  });

  await host.drainPending();
  await host.pause(50);
  await host.drainPending();
  await host.pause(50);
  await host.drainPending();

  ok('callback fired', received !== null);
  eq('err is null', received?.err, null);
  includes('stdout includes file-arg', received?.stdout || '', 'file-arg');

  // Verify cpSpawn was called with shell=false (we don't run via shell)
  const spawn = sup.calls.find(c => c.method === 'cpSpawn');
  ok('cpSpawn was issued', spawn !== undefined);
  // execFile should NOT route through a shell wrapper:
  ok('cpSpawn shell flag is falsy', !spawn?.args?.shell);
});

summary('cp-execfile');
