#!/usr/bin/env bun
// W8 functional: incremental output via cpReadOutput long-poll.
//   spawn `slow-output 4 50` → 4 chunks at 50ms intervals.
//   First poll with sinceSeq=0, waitMs=200 → returns 1+ chunks.
//   Subsequent polls with rolling sinceSeq → returns next chunks.
//   Final poll after wait() → returns closed=true.

import { ok, eq, gte, includes, summary, group } from '../_tap.mjs';
import { makeFpm } from '../_mocks.mjs';

await group('incremental-read', async () => {
  const { fpm } = await makeFpm();

  const { childPid } = await fpm.spawn({
    command: 'slow-output', args: ['4', '50'],
    env: {}, cwd: '/', stdio: ['pipe','pipe','pipe'],
  });

  let sinceSeq = 0;
  let collected = '';
  let closed = false;
  let polls = 0;
  while (!closed && polls < 30) {
    polls++;
    const r = await fpm.readOutput(childPid, 1, sinceSeq, 100);
    for (const c of r.chunks) {
      collected += c.data;
      sinceSeq = Math.max(sinceSeq, c.seq);
    }
    closed = r.closed;
  }
  eq('all 4 chunks collected', collected, 'chunk0\nchunk1\nchunk2\nchunk3\n');
  ok('eventually closed', closed === true);

  const wait = await fpm.wait(childPid, 100);
  eq('exit 0', wait.exitCode, 0);
});

summary('incremental-read');
