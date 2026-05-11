#!/usr/bin/env bun
// shell-r4/new/unset-actually-unsets — BUG-SWEEP-R4-1.
//
// Pre-fix: `unset VAR` deleted from a copy of shell.env (the
// per-command ctx.env), so the variable persisted in shell.env.
//   user@nimbus:~$ export FOO=hi && unset FOO && echo "[$FOO]"
//   [hi]      ← still set
//
// Post-fix: override shell.builtins.set('unset', ...) in init.ts to
// delete from shell.env directly.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r4/new/unset-actually-unsets');
console.log(`shell-r4/new/unset-actually-unsets — ${process.env.BASE}`);

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

// Probe 1: simple unset clears the variable
await t.run('export R4VAR1=hi', 3_000);
await t.run('unset R4VAR1', 3_000);
const r1 = await t.run('echo "[${R4VAR1:-empty}]"', 3_000);
a.check(
  'unset clears the variable (subsequent reads see :- default)',
  body(r1.output) === '[empty]',
  `body=${JSON.stringify(body(r1.output))}`,
);

// Probe 2: chained `export X && unset X && echo`
const r2 = await t.run('export R4VAR2=hi && unset R4VAR2 && echo "v=[$R4VAR2]"', 3_000);
a.check(
  'chained `export X && unset X` actually unsets',
  body(r2.output) === 'v=[]',
  `body=${JSON.stringify(body(r2.output))}`,
);

// Probe 3: unset on missing var is silent + exit 0
const r3 = await t.run('unset R4_NEVER_SET && echo OK', 3_000);
a.check(
  'unset on missing var returns 0 (idempotent)',
  /\bOK\b/.test(body(r3.output)),
  `body=${JSON.stringify(body(r3.output))}`,
);

// Probe 4: unset multiple vars
await t.run('export R4A=1 R4B=2 R4C=3', 3_000);
await t.run('unset R4A R4B R4C', 3_000);
const r4 = await t.run('echo "A=[$R4A] B=[$R4B] C=[$R4C]"', 3_000);
a.check(
  'unset accepts multiple var names',
  body(r4.output) === 'A=[] B=[] C=[]',
  `body=${JSON.stringify(body(r4.output))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
