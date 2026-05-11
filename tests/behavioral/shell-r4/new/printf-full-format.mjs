#!/usr/bin/env bun
// shell-r4/new/printf-full-format — BUG-SWEEP-R4-2.
//
// Pre-fix mkPrintf only supported %s and %d. `printf "%x\\n" 255`
// output literal '%x'; `printf "%5d" 7` output literal '%5d'.
//
// Post-fix: full POSIX printf set (%s %d %u %f %F %e %E %g %G %x %X
// %o %c %b %q + flags - + 0 # space + width + .prec). Format string
// re-runs if extra args remain (bash printf semantics).

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r4/new/printf-full-format');
console.log(`shell-r4/new/printf-full-format — ${process.env.BASE}`);

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

// Probe 1: %x hex conversion
const r1 = await t.run('printf "%x\\n" 255', 5_000);
a.check('%x → hex', body(r1.output) === 'ff', `body=${JSON.stringify(body(r1.output))}`);

// Probe 2: %X uppercase hex
const r2 = await t.run('printf "%X\\n" 255', 5_000);
a.check('%X → uppercase hex', body(r2.output) === 'FF', `body=${JSON.stringify(body(r2.output))}`);

// Probe 3: %o octal
const r3 = await t.run('printf "%o\\n" 8', 5_000);
a.check('%o → octal', body(r3.output) === '10', `body=${JSON.stringify(body(r3.output))}`);

// Probe 4: %5d width padding (space-padded)
const r4 = await t.run('printf "%5d\\n" 7', 5_000);
a.check('%5d → space-padded width', body(r4.output) === '    7', `body=${JSON.stringify(body(r4.output))}`);

// Probe 5: %05d zero-pad
const r5 = await t.run('printf "%05d\\n" 7', 5_000);
a.check('%05d → zero-padded width', body(r5.output) === '00007', `body=${JSON.stringify(body(r5.output))}`);

// Probe 6: %.2f precision
const r6 = await t.run('printf "%.2f\\n" 3.14159', 5_000);
a.check('%.2f → precision', body(r6.output) === '3.14', `body=${JSON.stringify(body(r6.output))}`);

// Probe 7: format re-runs when extra args (bash semantics)
const r7 = await t.run('printf "%s\\n" a b c', 5_000);
a.check('format re-runs over extra args (a b c → 3 lines)', body(r7.output) === 'a\nb\nc', `body=${JSON.stringify(body(r7.output))}`);

// Probe 8: multiple specifiers in one run
const r8 = await t.run('printf "%s=%d\\n" name 42', 5_000);
a.check('multiple specifiers consume in order', body(r8.output) === 'name=42', `body=${JSON.stringify(body(r8.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
