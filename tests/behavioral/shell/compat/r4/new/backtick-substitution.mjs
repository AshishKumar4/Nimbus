#!/usr/bin/env bun
// shell/compat/r4/new/backtick-substitution — shell compatibility.
//
// Pre-fix: `echo \`date +%Y\`` printed literal '`date +%Y`'. bash
// supports both backtick and $() command substitution; lifo-sh
// only honoured $(). Many shell scripts use backticks.
//
// Backticks are parsed by the shell lexer as command substitution,
// with single quotes preserving literals and double quotes expanding.

import { deleteSession, mintSession, Terminal, makeAsserter, termBody } from '../../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/compat/r4/new/backtick-substitution');
console.log(`shell/compat/r4/new/backtick-substitution — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
try {
await t.connect();
await t.waitForPrompt(60_000);

const r1 = await t.run('echo `echo hi`', 5_000);
a.check('bare `echo hi` substitutes', termBody(r1.output) === 'hi', `body=${JSON.stringify(termBody(r1.output))}`);

const r2 = await t.run('echo `date +%Y`', 5_000);
a.check('backtick with date +%Y', /^20\d\d$/.test(termBody(r2.output)), `body=${JSON.stringify(termBody(r2.output))}`);

const r3 = await t.run('X=`echo world` && echo "hello $X"', 5_000);
a.check('assign via backtick result', termBody(r3.output) === 'hello world', `body=${JSON.stringify(termBody(r3.output))}`);

const r4 = await t.run('echo "year=`date +%Y`"', 5_000);
a.check('double-quoted backtick expands', /^year=20\d\d$/.test(termBody(r4.output)), `body=${JSON.stringify(termBody(r4.output))}`);

const r5 = await t.run("echo 'literal `cmd` here'", 5_000);
a.check('single-quoted backtick preserved literal', termBody(r5.output) === 'literal `cmd` here', `body=${JSON.stringify(termBody(r5.output))}`);

} finally {
  try { await t.close(); } catch {}
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
