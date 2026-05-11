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

// Probe 1: `echo hi` baseline.
const r1 = await t.run('echo hi', 5_000);
a.check('echo hi → "hi\\n"', /\bhi\b/.test(stripAnsi(r1.output)) && !/-/.test(stripAnsi(r1.output).split('\n').find(l => l === 'hi') || '-'),
  `tail: ${JSON.stringify(stripAnsi(r1.output).slice(-150))}`);

// Probe 2: `echo -n nopfx` — flag should be consumed.
const r2 = await t.run('echo -n nopfx', 5_000);
const out2 = stripAnsi(r2.output);
// We assert no `-n nopfx` literal in output AND `nopfx` present.
a.check(
  'echo -n consumes the flag (no `-n` in output)',
  /\bnopfx\b/.test(out2) && !/-n nopfx/.test(out2),
  `tail: ${JSON.stringify(out2.slice(-150))}`,
);

// Probe 3: `echo -e "a\\tb"` — interpret tab escape.
const r3 = await t.run('echo -e "a\\tb"', 5_000);
const out3 = stripAnsi(r3.output);
// Tab between a and b after the echo command line.
a.check(
  'echo -e interprets \\\\t as tab',
  /a\tb/.test(out3) && !/-e "a/.test(out3),
  `tail: ${JSON.stringify(out3.slice(-200))}`,
);

// Probe 4: combined `-ne` flag.
const r4 = await t.run('echo -ne "x\\ty"', 5_000);
const out4 = stripAnsi(r4.output);
a.check(
  'echo -ne handles combined flags (tab interp + no-newline)',
  /x\ty/.test(out4) && !/-ne/.test(out4.split('\n').find(l => l.startsWith('-ne')) || ''),
  `tail: ${JSON.stringify(out4.slice(-200))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
