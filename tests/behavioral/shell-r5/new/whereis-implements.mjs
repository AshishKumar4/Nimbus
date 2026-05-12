#!/usr/bin/env bun
// shell-r5/new/whereis-implements — SHELL-FOLLOWUPS-2.
// Pre-fix: `whereis` → 'whereis: command not found'.
// Post-fix: print 'NAME: PATH' for findable runtimes; 'NAME:' for missing.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r5/new/whereis-implements');
console.log(`shell-r5/new/whereis-implements — ${process.env.BASE}`);

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

// Probe 1: whereis clang
const r1 = await t.run('whereis clang', 5_000);
a.check('whereis clang → "clang: /usr/local/bin/clang"', body(r1.output) === 'clang: /usr/local/bin/clang', `body=${JSON.stringify(body(r1.output))}`);

// Probe 2: whereis git
const r2 = await t.run('whereis git', 5_000);
a.check('whereis git → "git: /usr/bin/git"', body(r2.output) === 'git: /usr/bin/git', `body=${JSON.stringify(body(r2.output))}`);

// Probe 3: whereis missing → "name:"
const r3 = await t.run('whereis nonexistent_xyz', 5_000);
a.check('whereis missing → "name:"', body(r3.output) === 'nonexistent_xyz:', `body=${JSON.stringify(body(r3.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
