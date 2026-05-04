#!/usr/bin/env bun
// W8 functional: kill + reportExit idempotency. First writer wins.
//   1. spawn long-running cmd
//   2. fpm.kill(pid, 'SIGTERM') stamps exitCode=143 immediately
//   3. fpm.reportExit(pid, 0, null) — should be a no-op
//   4. fpm.wait → still {143, SIGTERM}

import { ok, eq, summary, group } from '../_tap.mjs';
import { makeFpm } from '../_mocks.mjs';

await group('exit-idempotency', async () => {
  const { fpm } = await makeFpm();
  const { childPid } = await fpm.spawn({
    command: 'sleep-ms', args: ['5000'],
    env: {}, cwd: '/', stdio: ['pipe','pipe','pipe'],
  });
  await new Promise(r => setTimeout(r, 20));

  fpm.kill(childPid, 'SIGTERM');
  // simulate a late-arriving reportExit from the facet
  fpm.reportExit(childPid, 0, null);
  const wait = await fpm.wait(childPid, 200);
  eq('exitCode stays 143', wait.exitCode, 143);
  eq('signal stays SIGTERM', wait.signal, 'SIGTERM');
});

summary('exit-idempotency');
