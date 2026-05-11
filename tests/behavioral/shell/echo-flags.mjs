#!/usr/bin/env bun
// shell/echo-flags — regression probe for BUG-SWEEP-4.
//
// Pre-fix: @lifo-sh/core builtinEcho is `t.write(args.join(' ') + '\n')`
// — flags are dumped verbatim. `echo -n hi` outputs `-n hi`,
// `echo -e "a\\tb"` outputs `-e "a\\tb"` literal.
//
// Post-fix: nimbusEcho override in src/session/init.ts handles
// POSIX flags -n (suppress newline), -e (interpret backslash escapes),
// -E (default; no interpretation), combined flags (-ne, -en, etc.).

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/echo-flags');
console.log(`shell/echo-flags — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Helper: extract the output line(s) BETWEEN the echoed command and
// the next shell prompt. The command echo always starts with `$ `;
// the prompt always ends with `$ `. Strip both.
function commandResult(raw) {
  const ansi = stripAnsi(raw);
  // Find the last `\r\n` BEFORE the trailing prompt and return the
  // segment between the command-echo line and that point.
  const lines = ansi.split(/\r?\n/);
  // Drop the last line if it's the prompt.
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  // Drop the first line (command echo with `$ cmd`).
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

// Probe 1: `echo hi` baseline.
const r1 = await t.run('echo hi', 5_000);
const c1 = commandResult(r1.output);
a.check(
  'echo hi → "hi" on its own line',
  c1 === 'hi',
  `result=${JSON.stringify(c1)}`,
);

// Probe 2: `echo -n nopfx` — no newline; prompt follows immediately.
// The result lines pop drops trailing-prompt line; what remains is
// the output line WITHOUT trailing newline. We check the buffer
// directly: after running, last 20 chars should NOT have `\r\n` between
// `nopfx` and prompt.
const r2 = await t.run('echo -n nopfx', 5_000);
const raw2 = stripAnsi(r2.output);
a.check(
  'echo -n suppresses trailing newline (prompt follows nopfx with no newline)',
  /nopfxuser@/.test(raw2) || /nopfx\$/.test(raw2),
  `tail: ${JSON.stringify(raw2.slice(-150))}`,
);

// Probe 3: `echo -e "a\\tb"` — output is `a<TAB>b\n`.
const r3 = await t.run('echo -e "a\\tb"', 5_000);
const c3 = commandResult(r3.output);
a.check(
  'echo -e interprets \\t as a real tab character',
  c3 === 'a\tb',
  `result=${JSON.stringify(c3)}`,
);

// Probe 4: combined `-ne` flag.
const r4 = await t.run('echo -ne "x\\ty"', 5_000);
const raw4 = stripAnsi(r4.output);
a.check(
  'echo -ne handles combined flags: tab interpreted AND no trailing newline',
  /x\ty(?:user@|\$)/.test(raw4),
  `tail: ${JSON.stringify(raw4.slice(-200))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
