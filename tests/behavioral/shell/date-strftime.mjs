#!/usr/bin/env bun
// shell/date-strftime — regression probe for BUG-SWEEP-R2-5.
//
// Pre-fix `date +FMT` (anything except literal +%s) fell through to
// now.toString() — the FMT specifier was ignored.
//
// Post-fix: strftime subset implemented in src/shell/unix-commands.ts
// mkDate. Coverage: %Y %C %y %m %B %b %d %j %H %I %M %S %p %A %a %u
// %w %s %N %F %T %R %D %z %Z %% %n %t.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/date-strftime');
console.log(`shell/date-strftime — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function bodyOf(raw) {
  const ansi = stripAnsi(raw);
  const lines = ansi.split(/\r?\n/);
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

// Probe 1: %Y is a 4-digit year.
const r1 = await t.run('date +%Y', 5_000);
const b1 = bodyOf(r1.output);
a.check('%Y is a 4-digit year', /^20\d\d$/.test(b1), `body=${JSON.stringify(b1)}`);

// Probe 2: %F is YYYY-MM-DD.
const r2 = await t.run('date +%F', 5_000);
const b2 = bodyOf(r2.output);
a.check('%F is YYYY-MM-DD', /^20\d\d-\d{2}-\d{2}$/.test(b2), `body=${JSON.stringify(b2)}`);

// Probe 3: %T is HH:MM:SS.
const r3 = await t.run('date +%T', 5_000);
const b3 = bodyOf(r3.output);
a.check('%T is HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test(b3), `body=${JSON.stringify(b3)}`);

// Probe 4: %s is unix timestamp.
const r4 = await t.run('date +%s', 5_000);
const b4 = bodyOf(r4.output);
const nNow = Math.floor(Date.now() / 1000);
a.check('%s is unix timestamp', /^\d{10}$/.test(b4) && Math.abs(parseInt(b4, 10) - nNow) < 60, `body=${JSON.stringify(b4)}`);

// Probe 5: Combined format with literal text.
const r5 = await t.run('date "+date=%Y-%m-%d time=%H:%M"', 5_000);
const b5 = bodyOf(r5.output);
a.check('combined format with literal text', /^date=20\d\d-\d{2}-\d{2} time=\d{2}:\d{2}$/.test(b5), `body=${JSON.stringify(b5)}`);

// Probe 6: %% is literal %.
const r6 = await t.run('date "+%Y%%X"', 5_000);
const b6 = bodyOf(r6.output);
a.check('%% is literal percent', /^20\d\d%X$/.test(b6), `body=${JSON.stringify(b6)}`);

// Probe 7: %A weekday name is one of the 7 names.
const r7 = await t.run('date +%A', 5_000);
const b7 = bodyOf(r7.output);
a.check('%A is a weekday name', /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/.test(b7), `body=${JSON.stringify(b7)}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
