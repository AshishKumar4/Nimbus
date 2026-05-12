#!/usr/bin/env bun
// shell-r6/regression/r1-r5-fixes-preserved — R6 must not regress
// any of the R1-R5 fixes:
//   R5/SHELL-FOLLOWUPS-1: `which X` returns POSIX path.
//   R5/SHELL-FOLLOWUPS-2: `whereis X` exists.
//   R5/SHELL-FOLLOWUPS-3: `command -v X` works.
//   R5/SHELL-FOLLOWUPS-4: `ln -s` real symlink; `readlink` resolves.
//   R5/SHELL-FOLLOWUPS-5: exit-dump quiet on clean exits.
//   R1-R4: various shell builtins / parser fixes (seq, rm -rf chain,
//     /dev/null, subshell, type, grep -n, backtick, find -size,
//     printf %x, unset).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r6/regression');
console.log(`shell-r6/regression — ${process.env.BASE}`);

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

// R5: which/whereis/command
const r1 = await t.run('which clang', 5_000);
a.check('R5: which clang → /usr/local/bin/clang',
  body(r1.output) === '/usr/local/bin/clang',
  `body=${JSON.stringify(body(r1.output))}`);

const r2 = await t.run('whereis git', 5_000);
a.check('R5: whereis git → "git: /usr/bin/git"',
  body(r2.output) === 'git: /usr/bin/git',
  `body=${JSON.stringify(body(r2.output))}`);

const r3 = await t.run('command -v node', 5_000);
a.check('R5: command -v node → /usr/local/bin/node',
  body(r3.output) === '/usr/local/bin/node',
  `body=${JSON.stringify(body(r3.output))}`);

// R5: ln -s + readlink (basic — full symlink probe is in R6 new/).
await t.run('mkdir -p /tmp/r6reg && cd /tmp/r6reg', 5_000);
await t.run('echo regdata > rt.txt', 5_000);
await t.run('ln -s rt.txt rl.txt', 5_000);
const r4 = await t.run('readlink rl.txt', 5_000);
a.check('R5: readlink rl.txt → "rt.txt"',
  body(r4.output) === 'rt.txt',
  `body=${JSON.stringify(body(r4.output))}`);
const r5 = await t.run('cat rl.txt', 5_000);
a.check('R5: cat <symlink> dereferences → "regdata"',
  body(r5.output) === 'regdata',
  `body=${JSON.stringify(body(r5.output))}`);

// R5: exit-dump quiet on clean exit (node -e).
const r6 = await t.run('node -e "console.log(\'r6reg-mark\')"', 15_000);
const r6raw = stripAnsi(r6.output);
a.check('R5: node clean-exit — no "exited with code 0" banner',
  !/Process \d+ .* exited with code 0/.test(r6raw),
  `raw=${JSON.stringify(r6raw)}`);

// R1: seq
const r7 = await t.run('seq 1 3', 5_000);
a.check('R1: seq 1 3 → "1\\n2\\n3"',
  body(r7.output) === '1\n2\n3',
  `body=${JSON.stringify(body(r7.output))}`);

// R4: backtick
const r8 = await t.run('echo `echo backtick`', 5_000);
a.check('R4: backtick → "backtick"',
  body(r8.output) === 'backtick',
  `body=${JSON.stringify(body(r8.output))}`);

// R4: printf %x
const r9 = await t.run('printf "%x\\n" 255', 5_000);
a.check('R4: printf %x 255 → "ff"',
  body(r9.output) === 'ff',
  `body=${JSON.stringify(body(r9.output))}`);

// R3: /dev/null
const r10 = await t.run('echo hello > /dev/null; echo SEP', 5_000);
a.check('R3: > /dev/null — no hello, just SEP',
  body(r10.output) === 'SEP',
  `body=${JSON.stringify(body(r10.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
