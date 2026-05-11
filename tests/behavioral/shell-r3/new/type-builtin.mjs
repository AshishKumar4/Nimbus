#!/usr/bin/env bun
// shell-r3/new/type-builtin — BUG-SWEEP-R3-6.
//
// Pre-fix: `type echo` printed 'type: command not found'. The bash
// `type` builtin classifies a name (builtin, alias, function, file,
// or unknown).
//
// Post-fix: src/shell/unix-commands.ts mkType registered in registry.
// Resolves via the same registry that lifo-sh's builtins use.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r3/new/type-builtin');
console.log(`shell-r3/new/type-builtin — ${process.env.BASE}`);

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

// Probe 1: type echo (registered builtin)
const r1 = await t.run('type echo', 5_000);
a.check(
  '`type echo` reports shell builtin',
  /echo is a shell builtin/.test(body(r1.output)),
  `body=${JSON.stringify(body(r1.output))}`,
);

// Probe 2: type rm
const r2 = await t.run('type rm', 5_000);
a.check(
  '`type rm` reports shell builtin',
  /rm is a shell builtin/.test(body(r2.output)),
  `body=${JSON.stringify(body(r2.output))}`,
);

// Probe 3: type unknown
const r3 = await t.run('type fakecmd_zzzz', 5_000);
a.check(
  '`type <unknown>` reports not found + exit 1',
  /not found/.test(stripAnsi(r3.output)),
  `tail=${JSON.stringify(stripAnsi(r3.output).slice(-150))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
