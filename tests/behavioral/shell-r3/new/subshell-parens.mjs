#!/usr/bin/env bun
// shell-r3/new/subshell-parens — BUG-SWEEP-R3-2.
//
// Pre-fix: `(cmd1; cmd2)` raised `unexpected token '('`. Pipelined
// grouping and cd-scoped subshells all failed.
//
// Post-fix: SubshellNormalizer handles bare `(...)` groups —
// saves/restores cwd + env, runs inner sequence.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r3/new/subshell-parens');
console.log(`shell-r3/new/subshell-parens — ${process.env.BASE}`);

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

// Probe 1: bare subshell runs sequence
const r1 = await t.run('(echo a; echo b)', 5_000);
a.check(
  'bare `(echo a; echo b)` runs both (no parse error)',
  body(r1.output) === 'a\nb',
  `body=${JSON.stringify(body(r1.output))}`,
);

// Probe 2: cd inside subshell doesn't leak
await t.run('cd /home/user', 3_000);
const r2 = await t.run('(cd /tmp && pwd) && pwd', 5_000);
a.check(
  '`(cd /tmp && pwd) && pwd` shows /tmp then /home/user (cd-scoped)',
  body(r2.output) === '/tmp\n/home/user',
  `body=${JSON.stringify(body(r2.output))}`,
);

// Probe 3: env var inside subshell doesn't leak
const r3 = await t.run('(X=insub; echo "X=$X") && echo "OUT=$X"', 5_000);
const b3 = body(r3.output);
a.check(
  'env set inside subshell is scoped',
  /X=insub/.test(b3) && /OUT=\s*$/m.test(b3 + '\n'),
  `body=${JSON.stringify(b3)}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
