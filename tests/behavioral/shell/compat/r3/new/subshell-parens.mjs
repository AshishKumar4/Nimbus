#!/usr/bin/env bun
// shell/compat/r3/new/subshell-parens — shell compatibility.
//
// Pre-fix: `(cmd1; cmd2)` raised `unexpected token '('`. Pipelined
// grouping and cd-scoped subshells all failed.
//
// Post-fix: the shell parser/interpreter handles `(...)` groups and
// restores cwd/env for subshell execution.

import { deleteSession, mintSession, Terminal, makeAsserter, stripAnsi } from '../../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/compat/r3/new/subshell-parens');
console.log(`shell/compat/r3/new/subshell-parens — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);

function body(raw) {
  const ansi = stripAnsi(raw);
  const lines = ansi.split(/\r?\n/);
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  // Probe 1: bare subshell runs sequence
  const r1 = await t.run('(echo a; echo b)', 5_000);
  a.check(
    'bare `(echo a; echo b)` runs both (no parse error)',
    body(r1.output) === 'a\nb',
    `body=${JSON.stringify(body(r1.output))}`,
  );

  // Probe 2: cd inside bare subshell doesn't leak.
  await t.run('cd /home/user', 3_000);
  await t.run('(cd /tmp && pwd)', 5_000);  // expect /tmp printed, cwd unchanged
  const r2 = await t.run('pwd', 5_000);
  a.check(
    'cd inside bare subshell does NOT leak to parent (cwd restored)',
    body(r2.output) === '/home/user',
    `body=${JSON.stringify(body(r2.output))}`,
  );

  // Probe 3: env var inside bare subshell doesn't leak.
  await t.run('unset SUBVAR', 3_000);
  await t.run('(SUBVAR=insub; echo "X=$SUBVAR")', 5_000);
  const r3 = await t.run('echo "PARENT=$SUBVAR"', 5_000);
  a.check(
    'env var set inside bare subshell is scoped (parent SUBVAR empty)',
    body(r3.output) === 'PARENT=',
    `body=${JSON.stringify(body(r3.output))}`,
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
