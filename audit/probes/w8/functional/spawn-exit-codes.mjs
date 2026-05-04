#!/usr/bin/env bun
// W8 functional: exit code propagation.
//   true  → 0
//   false → 1
//   exit-code 42 → 42
//   exit-code 137 → 137

import { ok, eq, summary, group } from '../_tap.mjs';
import { makeFpm } from '../_mocks.mjs';

await group('spawn-exit-codes', async () => {
  const { fpm } = await makeFpm();

  for (const [cmd, args, expected] of [
    ['true', [], 0],
    ['false', [], 1],
    ['exit-code', ['42'], 42],
    ['exit-code', ['137'], 137],
    ['exit-code', ['0'], 0],
  ]) {
    const { childPid } = await fpm.spawn({
      command: cmd, args, env: {}, cwd: '/', stdio: ['pipe','pipe','pipe'],
    });
    const r = await fpm.wait(childPid, 1000);
    eq(`${cmd} ${args.join(' ')} → exitCode ${expected}`, r.exitCode, expected);
  }
});

summary('spawn-exit-codes');
