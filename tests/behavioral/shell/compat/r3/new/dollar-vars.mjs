#!/usr/bin/env bun
// shell/compat/r3/new/dollar-vars — shell compatibility.
//
// Pre-fix: `echo $$` printed literal `$$`; `echo $0` printed empty.
// Common shell-script idioms (PID-based lockfiles, $0-aware behaviour)
// broken.
//
// Post-fix: the shell substrate expands $$ from its process env and
// $0 from invocation env. Quote-aware: single-quoted strings preserved.

import { deleteSession, mintSession, Terminal, makeAsserter, termBody } from '../../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/compat/r3/new/dollar-vars');
console.log(`shell/compat/r3/new/dollar-vars — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  // Probe 1: $$ expands to a numeric pid
  const r1 = await t.run('echo "pid=$$"', 5_000);
  a.check(
    '$$ expands to numeric PID',
    /^pid=\d+$/m.test(termBody(r1.output)),
    `body=${JSON.stringify(termBody(r1.output))}`,
  );

  // Probe 2: $0 expands to nimbus-sh
  const r2 = await t.run('echo "shell=$0"', 5_000);
  a.check(
    '$0 expands to nimbus-sh',
    termBody(r2.output) === 'shell=nimbus-sh',
    `body=${JSON.stringify(termBody(r2.output))}`,
  );

  // Probe 3: single-quoted $$ preserved literal
  const r3 = await t.run("echo 'literal $$ $0'", 5_000);
  a.check(
    "single-quoted $$ and $0 preserved literal",
    termBody(r3.output) === 'literal $$ $0',
    `body=${JSON.stringify(termBody(r3.output))}`,
  );

  // Probe 4: $$ stable within same session
  const r4a = await t.run('echo $$', 5_000);
  const r4b = await t.run('echo $$', 5_000);
  a.check(
    '$$ stable within same session',
    termBody(r4a.output) === termBody(r4b.output) && /^\d+$/.test(termBody(r4a.output)),
    `r4a=${JSON.stringify(termBody(r4a.output))} r4b=${JSON.stringify(termBody(r4b.output))}`,
  );
} finally {
  try { await t.close(); } catch {}
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
