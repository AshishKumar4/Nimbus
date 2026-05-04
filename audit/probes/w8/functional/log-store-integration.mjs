#!/usr/bin/env bun
// W8 functional: per-child logs land in ProcessLogStore so `logs <pid>`
// surfaces them after the child exits. Mirrors the supervisor's existing
// _rpcStdout / _rpcStderr → processLogs.append wiring for facet processes.

import { ok, eq, includes, summary, group } from '../_tap.mjs';
import { makeFpm } from '../_mocks.mjs';

await group('log-store-integration', async () => {
  const { fpm, processLogs } = await makeFpm();

  const { childPid } = await fpm.spawn({
    command: 'split-streams', args: [],
    env: {}, cwd: '/', stdio: ['pipe','pipe','pipe'],
  });
  await fpm.wait(childPid, 1000);
  await fpm.drainOutput(childPid); // forces the supervisor-side flush

  eq('logs.read(pid, "stdout")', processLogs.read(childPid, 'stdout'), 'out-line\n');
  eq('logs.read(pid, "stderr")', processLogs.read(childPid, 'stderr'), 'err-line\n');
  eq('exit slot marked in log store', processLogs.getExit(childPid), 0);
});

summary('log-store-integration');
