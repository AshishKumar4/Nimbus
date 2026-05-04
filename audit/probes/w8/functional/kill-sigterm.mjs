#!/usr/bin/env bun
// W8 functional: kill a long-running facet-direct child.
//   spawn `sleep-ms 5000` → kill SIGTERM → wait → exitCode 143, signal SIGTERM
//   spawn `sleep-ms 5000` → kill SIGKILL → wait → exitCode 137, signal SIGKILL
//   kill returns true the first time, false the second time (already exited).

import { ok, eq, summary, group } from '../_tap.mjs';
import { makeFpm } from '../_mocks.mjs';

await group('kill-sigterm', async () => {
  // SIGTERM → 143
  {
    const { fpm } = await makeFpm();
    const { childPid } = await fpm.spawn({
      command: 'sleep-ms',
      args: ['5000'],          // would block 5s if not killed
      env: {}, cwd: '/', stdio: ['pipe','pipe','pipe'],
    });
    // kill after a microtask tick so the spawn loop has dispatched
    await new Promise(r => setTimeout(r, 20));
    const t0 = Date.now();
    const ok1 = fpm.kill(childPid, 'SIGTERM');
    eq('first kill returns true', ok1, true);
    const wait = await fpm.wait(childPid, 500);
    eq('exitCode 143 (SIGTERM)', wait.exitCode, 143);
    eq('signal SIGTERM', wait.signal, 'SIGTERM');
    ok('wait resolved within 500ms', Date.now() - t0 < 500);

    const ok2 = fpm.kill(childPid, 'SIGTERM');
    eq('second kill returns false', ok2, false);
  }
  // SIGKILL → 137
  {
    const { fpm } = await makeFpm();
    const { childPid } = await fpm.spawn({
      command: 'sleep-ms', args: ['5000'],
      env: {}, cwd: '/', stdio: ['pipe','pipe','pipe'],
    });
    await new Promise(r => setTimeout(r, 20));
    fpm.kill(childPid, 'SIGKILL');
    const wait = await fpm.wait(childPid, 500);
    eq('SIGKILL → exitCode 137', wait.exitCode, 137);
    eq('SIGKILL → signal SIGKILL', wait.signal, 'SIGKILL');
  }
});

summary('kill-sigterm');
