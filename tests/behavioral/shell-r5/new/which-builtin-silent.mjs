#!/usr/bin/env bun
// shell-r5/new/which-builtin-silent — SHELL-FOLLOWUPS-1 builtin path.
//
// GNU which default: builtins are NOT printed (exits 1 silently).
// With -a flag, builtin classification IS printed alongside any
// PATH match. Pre-fix our `which echo` printed 'echo: nimbus built-in'.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r5/new/which-builtin-silent');
console.log(`shell-r5/new/which-builtin-silent — ${process.env.BASE}`);

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

// Probe 1: `which echo` default → empty stdout, exit 1 (silent).
// echo is a shell builtin, not in canonical-bin map.
const r1 = await t.run('which echo', 5_000);
const r1ex = await t.run('echo "ex=$?"', 5_000);
a.check(
  'which echo default → empty stdout, exit 1',
  body(r1.output) === '' && body(r1ex.output) === 'ex=1',
  `out=${JSON.stringify(body(r1.output))} ex=${JSON.stringify(body(r1ex.output))}`,
);

// Probe 2: `which -a echo` → prints builtin marker, exit 0
const r2 = await t.run('which -a echo', 5_000);
const r2ex = await t.run('echo "ex=$?"', 5_000);
a.check(
  'which -a echo → "echo: shell built-in command", exit 0',
  /echo: shell built-in command/.test(body(r2.output)) && body(r2ex.output) === 'ex=0',
  `out=${JSON.stringify(body(r2.output))} ex=${JSON.stringify(body(r2ex.output))}`,
);

// Probe 3: `which clang` (canonical-bin entry) prints path, exit 0
const r3 = await t.run('which clang', 5_000);
const r3ex = await t.run('echo "ex=$?"', 5_000);
a.check(
  'which clang (canonical-bin) → path, exit 0',
  body(r3.output) === '/usr/local/bin/clang' && body(r3ex.output) === 'ex=0',
  `out=${JSON.stringify(body(r3.output))} ex=${JSON.stringify(body(r3ex.output))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
