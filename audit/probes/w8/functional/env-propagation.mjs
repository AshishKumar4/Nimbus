#!/usr/bin/env bun
// W8 functional: env var propagation + recursion-depth counter.

import { ok, eq, gte, summary, group } from '../_tap.mjs';
import { makeFpm } from '../_mocks.mjs';

await group('env-propagation', async () => {
  const { fpm } = await makeFpm();

  // 1. Pass FOO=bar; child sees it.
  const { childPid } = await fpm.spawn({
    command: 'env-print', args: [],
    env: { FOO: 'bar', PATH: '/usr/bin' },
    cwd: '/', stdio: ['pipe','pipe','pipe'],
  });
  await fpm.wait(childPid, 1000);
  const drain = await fpm.drainOutput(childPid);
  const obj = JSON.parse(drain.stdout.trim());
  eq('FOO=bar visible to child', obj.FOO, 'bar');

  // 2. NIMBUS_CP_DEPTH starts at 0, increments on spawn.
  const { childPid: pid2 } = await fpm.spawn({
    command: 'env-print', args: [],
    env: {},
    cwd: '/', stdio: ['pipe','pipe','pipe'],
  });
  await fpm.wait(pid2, 1000);
  const drain2 = await fpm.drainOutput(pid2);
  const obj2 = JSON.parse(drain2.stdout.trim());
  eq('NIMBUS_CP_DEPTH=1 in fresh child', obj2.NIMBUS_CP_DEPTH, '1');

  // 3. Inherited NIMBUS_CP_DEPTH=7 → child sees 8 → still allowed.
  const { childPid: pid3 } = await fpm.spawn({
    command: 'env-print', args: [],
    env: { NIMBUS_CP_DEPTH: '7' },
    cwd: '/', stdio: ['pipe','pipe','pipe'],
  });
  await fpm.wait(pid3, 1000);
  const drain3 = await fpm.drainOutput(pid3);
  const obj3 = JSON.parse(drain3.stdout.trim());
  eq('NIMBUS_CP_DEPTH=8 at boundary', obj3.NIMBUS_CP_DEPTH, '8');

  // 4. NIMBUS_CP_DEPTH=8 → reject with EAGAIN, child never spawns.
  let rejected = false;
  try {
    await fpm.spawn({
      command: 'echo', args: ['x'],
      env: { NIMBUS_CP_DEPTH: '8' },
      cwd: '/', stdio: ['pipe','pipe','pipe'],
    });
  } catch (e) {
    rejected = true;
    ok('depth-cap error mentions EAGAIN', /EAGAIN|depth/i.test(e.message));
  }
  ok('spawn at depth 8 rejected', rejected);
});

summary('env-propagation');
