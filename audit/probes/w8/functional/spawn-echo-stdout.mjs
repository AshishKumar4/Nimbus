#!/usr/bin/env bun
// W8 functional probe: spawn 'echo hello world', drain stdout, assert content.
//
// Exercises FacetProcessManager.spawn → cpDrainOutput path for a
// pure-builtin synchronously-completing command.

import { ok, eq, includes, summary, group } from '../_tap.mjs';
import { makeFpm } from '../_mocks.mjs';

await group('spawn-echo-stdout', async () => {
  const { fpm } = await makeFpm();

  const { childPid } = await fpm.spawn({
    command: 'echo',
    args: ['hello', 'world'],
    env: {},
    cwd: '/home/user',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  ok('childPid is a positive number', typeof childPid === 'number' && childPid > 0);

  // Wait for completion.
  const wait = await fpm.wait(childPid, 1000);
  eq('exitCode is 0', wait.exitCode, 0);
  eq('signal is null', wait.signal, null);

  // Drain final output.
  const drain = await fpm.drainOutput(childPid);
  eq('stdout is "hello world\\n"', drain.stdout, 'hello world\n');
  eq('stderr is ""', drain.stderr, '');
  ok('stdout closed flag', drain.stdoutClosed === true);
  ok('stderr closed flag', drain.stderrClosed === true);
});

summary('spawn-echo-stdout');
