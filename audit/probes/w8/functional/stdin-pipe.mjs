#!/usr/bin/env bun
// W8 functional: stdin queue. Spawn `cat`, write 3 chunks, end(), drain stdout.

import { ok, eq, summary, group } from '../_tap.mjs';
import { makeFpm } from '../_mocks.mjs';

await group('stdin-pipe', async () => {
  const { fpm } = await makeFpm();

  const { childPid } = await fpm.spawn({
    command: 'cat',
    args: [],
    env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'],
  });

  ok('childPid allocated', typeof childPid === 'number' && childPid > 0);

  // Note: in our test interpreter `cat` reads stdin once (synchronously).
  // We rely on the supervisor draining the stdin queue into the
  // payload.stdin field before invoking the interpreter — same pattern
  // a real cat would use via the cpReadStdin RPC.

  fpm.stdinWrite(childPid, 'line1\n');
  fpm.stdinWrite(childPid, 'line2\n');
  fpm.stdinWrite(childPid, 'line3\n');
  fpm.stdinEnd(childPid);

  const wait = await fpm.wait(childPid, 1000);
  eq('exit 0', wait.exitCode, 0);

  const drain = await fpm.drainOutput(childPid);
  eq('stdout echoes all 3 lines', drain.stdout, 'line1\nline2\nline3\n');
});

summary('stdin-pipe');
