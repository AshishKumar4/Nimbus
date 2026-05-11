#!/usr/bin/env bun
// shell/xargs-execute — regression probe for BUG-SWEEP-R2-3.
//
// Pre-fix: xargs printed the command-line that WOULD have been
// executed and returned 0. Output of `seq 5 | xargs echo` was
// "echo 1 2 3 4 5" (literal), not "1 2 3 4 5".
//
// Post-fix: src/shell/unix-commands.ts mkXargs takes a registry
// reference and actually invokes the resolved target command,
// passing stdin items as positional args. Supports -n (batch size),
// -I (substitution), -0 (null-separator).

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/xargs-execute');
console.log(`shell/xargs-execute — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Helper: extract command-output lines (between echo'd cmd and next prompt).
function bodyOf(raw) {
  const ansi = stripAnsi(raw);
  const lines = ansi.split(/\r?\n/);
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

// Probe 1: `seq 3 | xargs echo` executes echo with the items as args
// (single invocation, default batch=∞).
const r1 = await t.run('seq 3 | xargs echo', 10_000);
const b1 = bodyOf(r1.output);
a.check(
  '`seq 3 | xargs echo` runs echo with [1, 2, 3]',
  b1 === '1 2 3',
  `body=${JSON.stringify(b1)}`,
);

// Probe 2: `-n 1` runs echo once per item.
const r2 = await t.run('seq 3 | xargs -n 1 echo', 10_000);
const b2 = bodyOf(r2.output);
a.check(
  '`-n 1` runs the command once per item',
  /^1\n2\n3$/m.test(b2) || b2 === '1\n2\n3',
  `body=${JSON.stringify(b2)}`,
);

// Probe 3: `-I {}` replaces token (one invocation per item).
const r3 = await t.run('seq 2 | xargs -I {} echo "item-{}"', 10_000);
const b3 = bodyOf(r3.output);
a.check(
  '`-I {}` substitutes the token in args per item',
  /item-1[\r\n]+item-2/.test(b3),
  `body=${JSON.stringify(b3)}`,
);

// Probe 4: bare xargs (no cmd) defaults to echo. NOTE: real xargs
// defaults to `/bin/echo`; we default to the registry's echo.
const r4 = await t.run('echo "a b c" | xargs', 10_000);
const b4 = bodyOf(r4.output);
a.check(
  'bare xargs defaults to echo',
  b4 === 'a b c',
  `body=${JSON.stringify(b4)}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
