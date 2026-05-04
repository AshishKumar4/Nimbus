#!/usr/bin/env bun
// W8 functional: stdout vs stderr separation.

import { ok, eq, summary, group } from '../_tap.mjs';
import { makeFpm } from '../_mocks.mjs';

await group('split-streams', async () => {
  const { fpm } = await makeFpm();

  const { childPid } = await fpm.spawn({
    command: 'split-streams', args: [], env: {}, cwd: '/',
    stdio: ['pipe','pipe','pipe'],
  });
  await fpm.wait(childPid, 1000);
  const drain = await fpm.drainOutput(childPid);
  eq('stdout is "out-line\\n"', drain.stdout, 'out-line\n');
  eq('stderr is "err-line\\n"', drain.stderr, 'err-line\n');
});

summary('split-streams');
