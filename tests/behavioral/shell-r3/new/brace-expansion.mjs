#!/usr/bin/env bun
// shell-r3/new/brace-expansion — BUG-SWEEP-R3-3.
//
// Pre-fix `ls *.{js,ts}` did not expand the brace list. Common idioms
// (`rm -rf {dist,build,node_modules}`, `cp src/{a,b,c}.txt dst/`) broken.
//
// Post-fix: BraceExpander wraps Shell.executeLine and rewrites
// `prefix{a,b,c}suffix` into space-separated `prefixasuffix prefixbsuffix
// prefixcsuffix` tokens BEFORE lifo-sh's parser sees the line.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r3/new/brace-expansion');
console.log(`shell-r3/new/brace-expansion — ${process.env.BASE}`);

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

await t.run('mkdir -p /tmp/r3be && touch /tmp/r3be/a.js /tmp/r3be/b.ts /tmp/r3be/c.md', 5_000);

// Probe 1: echo a{1,2,3}b
const r1 = await t.run('echo a{1,2,3}b', 5_000);
a.check(
  'echo a{1,2,3}b → a1b a2b a3b',
  body(r1.output) === 'a1b a2b a3b',
  `body=${JSON.stringify(body(r1.output))}`,
);

// Probe 2: glob with brace
const r2 = await t.run('ls /tmp/r3be/*.{js,ts}', 5_000);
const b2 = body(r2.output);
a.check(
  'ls /tmp/r3be/*.{js,ts} finds both files',
  /a\.js/.test(b2) && /b\.ts/.test(b2),
  `body=${JSON.stringify(b2)}`,
);

// Probe 3: nested braces? skip — bash supports but our impl is flat.
// Single-quotes preserve literal braces.
const r3 = await t.run("echo 'a{1,2}b'", 5_000);
a.check(
  "single-quoted '{...}' preserved literal",
  body(r3.output) === 'a{1,2}b',
  `body=${JSON.stringify(body(r3.output))}`,
);

// Probe 4: parameter expansion `${VAR}` NOT mistakenly brace-expanded.
const r4 = await t.run('FOO=hello && echo "${FOO}"', 5_000);
a.check(
  '${VAR} parameter expansion still works (not brace-expanded)',
  body(r4.output) === 'hello',
  `body=${JSON.stringify(body(r4.output))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
