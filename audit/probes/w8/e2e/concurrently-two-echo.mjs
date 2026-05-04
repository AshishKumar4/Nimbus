#!/usr/bin/env bun
// W8 e2e: concurrently 'echo a' 'echo b' shape.
//
// Replays what `concurrently` does internally: spawn N children with
// shell semantics, multiplex their stdout into the parent. We don't
// invoke npx concurrently directly (would need network); we do verify
// that our spawn machinery handles 2 simultaneous children correctly.

import { ok, eq, includes, summary, group } from '../_tap.mjs';
import { makeFpm } from '../_mocks.mjs';

await group('concurrently-two-echo', async () => {
  const { fpm } = await makeFpm();

  const a = await fpm.spawn({
    command: 'echo', args: ['a'],
    env: {}, cwd: '/', stdio: ['pipe','pipe','pipe'],
  });
  const b = await fpm.spawn({
    command: 'echo', args: ['b'],
    env: {}, cwd: '/', stdio: ['pipe','pipe','pipe'],
  });

  ok('two distinct PIDs', a.childPid !== b.childPid);

  const [wa, wb] = await Promise.all([
    fpm.wait(a.childPid, 1000),
    fpm.wait(b.childPid, 1000),
  ]);
  eq('a exit 0', wa.exitCode, 0);
  eq('b exit 0', wb.exitCode, 0);

  const [da, db] = await Promise.all([
    fpm.drainOutput(a.childPid),
    fpm.drainOutput(b.childPid),
  ]);
  includes('a stdout has "a"', da.stdout, 'a');
  includes('b stdout has "b"', db.stdout, 'b');
});

summary('concurrently-two-echo');
