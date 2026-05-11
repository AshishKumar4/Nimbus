#!/usr/bin/env bun
// shell-r4/regression/r1-r3-fixes-preserved — verify R1-R3 fixes
// remain GREEN after R4's additional preprocessors + grep/printf/find
// rewrites. R4 adds a 5th executeLine wrapper (BacktickNormalizer)
// and rewrites mkGrep / mkFind / mkPrintf / mkDu.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r4/regression/r1-r3-fixes-preserved');
console.log(`shell-r4/regression — ${process.env.BASE}`);

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

// R1: wrap'd command (seq) doesn't deadlock
const r1 = await t.run('seq 5', 5_000);
a.check('R1 seq 5 → 1..5 (wrap-stdin no-deadlock preserved)', body(r1.output) === '1\n2\n3\n4\n5', `body=${JSON.stringify(body(r1.output))}`);

// R1: 2>&1 normalizer
const r2 = await t.run('echo hi 2>&1', 5_000);
a.check('R1 2>&1 normalizer preserved', /hi/.test(body(r2.output)) && !/Expected/.test(body(r2.output)), `body=${JSON.stringify(body(r2.output))}`);

// R2: rm -rf chain
const r3 = await t.run('rm -rf /tmp/r4-nx && echo CHAIN', 5_000);
a.check('R2 rm -rf <missing> chain preserved', /CHAIN/.test(body(r3.output)), `body=${JSON.stringify(body(r3.output))}`);

// R2: xargs cross-cmd dispatch
const r4 = await t.run('seq 3 | xargs echo', 5_000);
a.check('R2 xargs echo preserved', body(r4.output) === '1 2 3', `body=${JSON.stringify(body(r4.output))}`);

// R2: awk BEGIN+END
const r5 = await t.run("seq 3 | awk 'BEGIN {print \"s\"} END {print \"e\"}'", 5_000);
a.check('R2 awk BEGIN+END preserved', body(r5.output) === 's\ne', `body=${JSON.stringify(body(r5.output))}`);

// R2: date +%Y
const r6 = await t.run('date +%Y', 5_000);
a.check('R2 date strftime preserved', /^20\d\d$/.test(body(r6.output)), `body=${JSON.stringify(body(r6.output))}`);

// R3: /dev/null write
const r7 = await t.run('echo X > /dev/null && echo OK', 5_000);
a.check('R3 /dev/null write preserved', /\bOK\b/.test(body(r7.output)), `body=${JSON.stringify(body(r7.output))}`);

// R3: brace expansion
await t.run('mkdir -p /tmp/r4be && touch /tmp/r4be/a.js /tmp/r4be/b.ts', 3_000);
const r8 = await t.run('ls /tmp/r4be/*.{js,ts}', 5_000);
a.check('R3 brace expansion preserved', /a\.js/.test(body(r8.output)) && /b\.ts/.test(body(r8.output)), `body=${JSON.stringify(body(r8.output))}`);

// R3: $$ expansion
const r9 = await t.run('echo "p=$$"', 5_000);
a.check('R3 $$ expansion preserved', /^p=\d+$/.test(body(r9.output)), `body=${JSON.stringify(body(r9.output))}`);

// R3: subshell bare
const r10 = await t.run('(echo a; echo b)', 5_000);
a.check('R3 bare subshell preserved', body(r10.output) === 'a\nb', `body=${JSON.stringify(body(r10.output))}`);

// R3: type builtin
const r11 = await t.run('type echo', 5_000);
a.check('R3 type builtin preserved', /shell builtin/.test(body(r11.output)), `body=${JSON.stringify(body(r11.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
