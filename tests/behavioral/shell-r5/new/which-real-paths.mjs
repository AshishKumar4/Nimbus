#!/usr/bin/env bun
// shell-r5/new/which-real-paths — SHELL-FOLLOWUPS-1.
//
// Pre-fix: `which clang` → 'clang: nimbus built-in'. Broken for
// scripts that consume which output (PATH_PREFIX=$(dirname $(which X))).
// Post-fix: POSIX path output for runtimes; exit 1 silently for
// builtins (default); -a flag shows all forms.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r5/new/which-real-paths');
console.log(`shell-r5/new/which-real-paths — ${process.env.BASE}`);

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

// Probe 1: `which clang` returns POSIX absolute path
const r1 = await t.run('which clang', 5_000);
a.check('which clang → /usr/local/bin/clang', body(r1.output) === '/usr/local/bin/clang', `body=${JSON.stringify(body(r1.output))}`);

// Probe 2: which node
const r2 = await t.run('which node', 5_000);
a.check('which node → /usr/local/bin/node', body(r2.output) === '/usr/local/bin/node', `body=${JSON.stringify(body(r2.output))}`);

// Probe 3: which python
const r3 = await t.run('which python', 5_000);
a.check('which python → /usr/bin/python3', body(r3.output) === '/usr/bin/python3', `body=${JSON.stringify(body(r3.output))}`);

// Probe 4: which bun
const r4 = await t.run('which bun', 5_000);
a.check('which bun → /usr/local/bin/bun', body(r4.output) === '/usr/local/bin/bun', `body=${JSON.stringify(body(r4.output))}`);

// Probe 5: which ruby
const r5 = await t.run('which ruby', 5_000);
a.check('which ruby → /usr/bin/ruby', body(r5.output) === '/usr/bin/ruby', `body=${JSON.stringify(body(r5.output))}`);

// Probe 6: which git
const r6 = await t.run('which git', 5_000);
a.check('which git → /usr/bin/git', body(r6.output) === '/usr/bin/git', `body=${JSON.stringify(body(r6.output))}`);

// Probe 7: script pattern `dirname $(which X)`
const r7 = await t.run('dirname $(which clang)', 5_000);
a.check('`dirname $(which clang)` → /usr/local/bin', body(r7.output) === '/usr/local/bin', `body=${JSON.stringify(body(r7.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
