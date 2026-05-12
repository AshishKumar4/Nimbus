#!/usr/bin/env bun
// shell-r5/new/command-v-equivalent — SHELL-FOLLOWUPS-3.
// POSIX `command -v X` is the portable alternative to `which X`.
// Many install scripts use it: `command -v node >/dev/null || install_node`

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r5/new/command-v-equivalent');
console.log(`shell-r5/new/command-v-equivalent — ${process.env.BASE}`);

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

// Probe 1: `command -v clang` matches `which clang`
const r1 = await t.run('command -v clang', 5_000);
a.check('command -v clang → /usr/local/bin/clang', body(r1.output) === '/usr/local/bin/clang', `body=${JSON.stringify(body(r1.output))}`);

// Probe 2: `command -v echo` (registered builtin) → "echo" (name)
const r2 = await t.run('command -v echo', 5_000);
a.check('command -v echo → "echo" (registered name)', body(r2.output) === 'echo', `body=${JSON.stringify(body(r2.output))}`);

// Probe 3: `command -v missing` exit 1
await t.run('command -v nonexistent_zzz', 3_000);
const r3 = await t.run('echo "ex=$?"', 5_000);
a.check('command -v missing → exit 1', body(r3.output) === 'ex=1', `body=${JSON.stringify(body(r3.output))}`);

// Probe 4: install-script idiom
const r4 = await t.run('command -v clang >/dev/null && echo "clang installed" || echo "clang missing"', 5_000);
a.check('install-script idiom: `command -v X >/dev/null && Y || Z`', body(r4.output) === 'clang installed', `body=${JSON.stringify(body(r4.output))}`);

// Probe 5: `command -V` verbose
const r5 = await t.run('command -V clang', 5_000);
a.check('command -V clang → "clang is /usr/local/bin/clang"', body(r5.output) === 'clang is /usr/local/bin/clang', `body=${JSON.stringify(body(r5.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
