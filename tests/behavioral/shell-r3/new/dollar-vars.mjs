#!/usr/bin/env bun
// shell-r3/new/dollar-vars — BUG-SWEEP-R3-4.
//
// Pre-fix: `echo $$` printed literal `$$`; `echo $0` printed empty.
// Common shell-script idioms (PID-based lockfiles, $0-aware behaviour)
// broken.
//
// Post-fix: DollarVarShim rewrites $$ → stable per-session pid and
// $0 → 'nimbus-sh' before lifo-sh sees the line. Quote-aware:
// single-quoted strings preserved.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r3/new/dollar-vars');
console.log(`shell-r3/new/dollar-vars — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function body(raw) {
  const ansi = stripAnsi(raw);
  const lines = ansi.split(/\r?\n/);
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

// Probe 1: $$ expands to a numeric pid
const r1 = await t.run('echo "pid=$$"', 5_000);
a.check(
  '$$ expands to numeric PID',
  /^pid=\d+$/m.test(body(r1.output)),
  `body=${JSON.stringify(body(r1.output))}`,
);

// Probe 2: $0 expands to nimbus-sh
const r2 = await t.run('echo "shell=$0"', 5_000);
a.check(
  '$0 expands to nimbus-sh',
  body(r2.output) === 'shell=nimbus-sh',
  `body=${JSON.stringify(body(r2.output))}`,
);

// Probe 3: single-quoted $$ preserved literal
const r3 = await t.run("echo 'literal $$ $0'", 5_000);
a.check(
  "single-quoted $$ and $0 preserved literal",
  body(r3.output) === 'literal $$ $0',
  `body=${JSON.stringify(body(r3.output))}`,
);

// Probe 4: $$ stable within same session
const r4a = await t.run('echo $$', 5_000);
const r4b = await t.run('echo $$', 5_000);
a.check(
  '$$ stable within same session',
  body(r4a.output) === body(r4b.output) && /^\d+$/.test(body(r4a.output)),
  `r4a=${JSON.stringify(body(r4a.output))} r4b=${JSON.stringify(body(r4b.output))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
