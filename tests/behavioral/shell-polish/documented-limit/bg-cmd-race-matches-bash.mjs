#!/usr/bin/env bun
// shell-polish/documented-limit/bg-cmd-race-matches-bash —
// `cmd &` racing past the next prompt is INTENTIONAL POSIX behaviour
// matching real bash. We do NOT consider this a bug; users wanting
// deterministic ordering MUST use `cmd & wait` instead.
//
// Real bash on Linux (verified locally):
//   $ echo hello &
//   [1] 12345
//   $ hello                 <-- output interleaves with prompt
//
// Nimbus:
//   $ echo hello &
//   [1] 14 (background)
//   user@nimbus:~$ hello    <-- same race, slightly different banner
//
// Fixing this would require either:
//   (a) Buffer all bg stdout until the next prompt finishes — breaks
//       long-running background tasks; the user would see no output
//       until they press Enter.
//   (b) Reissue the prompt after bg output drains — visually janky
//       and contradicts POSIX semantics.
//
// The reliable user-facing path is `cmd & wait`, which DOES emit
// output deterministically before returning to prompt (verified
// in `wait` builtin shell-r6).
//
// Category: R (runtime-behavioral) — documents the intentional race.
//           Test passes when output DOES land within a bounded window.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-polish/bg-cmd-race-matches-bash');
console.log(`shell-polish/bg-cmd-race-matches-bash — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. naked `cmd &`: emit the job banner AND eventually the output.
//    The output may race past the prompt — that's intentional. We
//    just assert both appear within a bounded window.
{
  t.reset();
  t.cmd('echo bg-race-marker-7842 &');
  // Wait for the (background) banner.
  await t.waitFor((b) => /\(background\)/.test(b), 5_000, 'bg banner');
  // Now poll for the actual output up to 3s.
  let sawOutput = false;
  for (let i = 0; i < 30; i++) {
    if (/\bbg-race-marker-7842\b/.test(stripAnsi(t.buf))) { sawOutput = true; break; }
    await sleep(100);
  }
  a.check('naked cmd & emits the (background) banner', /\(background\)/.test(stripAnsi(t.buf)),
    JSON.stringify(stripAnsi(t.buf).slice(-400)));
  a.check('naked cmd & eventually emits its stdout (race ok)', sawOutput,
    sawOutput ? '' : JSON.stringify(stripAnsi(t.buf).slice(-400)));
}

// 2. `cmd & wait` — deterministic. Output MUST land before the next
//    prompt. This is the reliable user-facing path.
{
  // First flush any stragglers from the previous test.
  await t.run('echo flush-marker', 5_000);
  const r = await t.run('echo wait-marker-9156 & wait', 10_000);
  const out = stripAnsi(r.output);
  const has = out.split(/\r?\n/).some((l) => l.trim() === 'wait-marker-9156');
  a.check('cmd & wait emits stdout deterministically before next prompt', has,
    has ? '' : JSON.stringify(out.slice(-400)));
}

// 3. The `wait` builtin exits 0 when there are no jobs.
{
  const r = await t.run('wait; echo "wait-done=$?"', 10_000);
  const out = stripAnsi(r.output);
  const has = out.split(/\r?\n/).some((l) => l.trim() === 'wait-done=0');
  a.check('bare `wait` (no jobs) exits 0', has,
    has ? '' : JSON.stringify(out.slice(-400)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
