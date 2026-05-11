#!/usr/bin/env bun
// shell-r3/regression/r1-r2-fixes-still-green — verify R1+R2 fixes
// remain GREEN after R3's preprocessor additions.
//
// R3 adds 4 new executeLine wrappers (BraceExpander, DollarVarShim,
// SubshellNormalizer, plus the existing FdRedirectNormalizer chain).
// The wrap pattern composes onto Shell.executeLine; bugs in one
// wrapper could break others. This probe asserts that prior fixes
// still produce expected output:
//   - R1: seq 5 outputs 1..5 (wrap'd-command no-deadlock)
//   - R1: 2>&1 doesn't trigger parse error (FdRedirectNormalizer)
//   - R1: echo -n suppresses newline (BUG-SWEEP-4 override)
//   - R2: rm -rf <missing> returns 0 (BUG-SWEEP-R2-1)
//   - R2: xargs actually executes (BUG-SWEEP-R2-3)
//   - R2: awk BEGIN/END/$NF (BUG-SWEEP-R2-4b)
//   - R2: date +%Y (BUG-SWEEP-R2-5)

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r3/regression/r1-r2-fixes-still-green');
console.log(`shell-r3/regression — ${process.env.BASE}`);

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

// R1: seq 5 still works
const r1 = await t.run('seq 5', 5_000);
a.check('R1 seq 5 still outputs 1..5', body(r1.output) === '1\n2\n3\n4\n5', `body=${JSON.stringify(body(r1.output))}`);

// R1: 2>&1 doesn't break parser
const r2 = await t.run('echo hi 2>&1', 5_000);
a.check('R1 2>&1 not parser-error', /hi/.test(body(r2.output)) && !/Expected/.test(body(r2.output)), `body=${JSON.stringify(body(r2.output))}`);

// R1: echo -n still works
const r3 = await t.run('echo -n nopfx', 5_000);
const raw3 = stripAnsi(r3.output);
a.check('R1 echo -n still suppresses newline', /nopfxuser@|nopfx\$/.test(raw3), `tail=${JSON.stringify(raw3.slice(-100))}`);

// R2: rm -rf <missing> exit 0
await t.run('rm -rf /tmp/r3-nx && echo OK', 5_000);
const r4 = await t.run('rm -rf /tmp/r3-nx && echo CHAIN', 5_000);
a.check('R2 rm -rf <missing> chain still works', /CHAIN/.test(body(r4.output)), `body=${JSON.stringify(body(r4.output))}`);

// R2: xargs actually executes (echo via registry)
const r5 = await t.run('seq 3 | xargs echo', 8_000);
a.check('R2 xargs echo still runs the cmd', body(r5.output) === '1 2 3', `body=${JSON.stringify(body(r5.output))}`);

// R2: awk BEGIN/END
const r6 = await t.run("seq 3 | awk 'BEGIN {print \"start\"} END {print \"end\"}'", 8_000);
a.check('R2 awk BEGIN+END still runs', body(r6.output) === 'start\nend', `body=${JSON.stringify(body(r6.output))}`);

// R2: date +%Y
const r7 = await t.run('date +%Y', 5_000);
a.check('R2 date +%Y still emits 4-digit year', /^20\d\d$/.test(body(r7.output)), `body=${JSON.stringify(body(r7.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
