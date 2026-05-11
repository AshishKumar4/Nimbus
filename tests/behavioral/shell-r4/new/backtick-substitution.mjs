#!/usr/bin/env bun
// shell-r4/new/backtick-substitution — BUG-SWEEP-R4-4.
//
// Pre-fix: `echo \`date +%Y\`` printed literal '`date +%Y`'. bash
// supports both backtick and $() command substitution; lifo-sh
// only honoured $(). Many shell scripts use backticks.
//
// Post-fix: BacktickNormalizer in features.ts rewrites `cmd` →
// $(cmd) before lifo-sh's parser sees the line. Quote-aware.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r4/new/backtick-substitution');
console.log(`shell-r4/new/backtick-substitution — ${process.env.BASE}`);

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

// Probe 1: bare backtick
const r1 = await t.run('echo `echo hi`', 5_000);
a.check('bare `echo hi` substitutes', body(r1.output) === 'hi', `body=${JSON.stringify(body(r1.output))}`);

// Probe 2: backtick with date (numeric year, R3 strftime)
const r2 = await t.run('echo `date +%Y`', 5_000);
a.check('backtick with date +%Y', /^20\d\d$/.test(body(r2.output)), `body=${JSON.stringify(body(r2.output))}`);

// Probe 3: assign result of backtick
const r3 = await t.run('X=`echo world` && echo "hello $X"', 5_000);
a.check('assign via backtick result', body(r3.output) === 'hello world', `body=${JSON.stringify(body(r3.output))}`);

// Probe 4: double-quoted backtick expands
const r4 = await t.run('echo "year=`date +%Y`"', 5_000);
a.check('double-quoted backtick expands', /^year=20\d\d$/.test(body(r4.output)), `body=${JSON.stringify(body(r4.output))}`);

// Probe 5: single-quoted backtick preserved literal
const r5 = await t.run("echo 'literal `cmd` here'", 5_000);
a.check('single-quoted backtick preserved literal', body(r5.output) === 'literal `cmd` here', `body=${JSON.stringify(body(r5.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
