#!/usr/bin/env bun
// shell-r5/regression/r1-r4-fixes-preserved — verify R1-R4 fixes
// remain GREEN after R5's symlink/which/dump changes.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r5/regression/r1-r4-fixes-preserved');
console.log(`shell-r5/regression — ${process.env.BASE}`);

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

// R1
const r1 = await t.run('seq 5', 5_000);
a.check('R1 seq 5 preserved', body(r1.output) === '1\n2\n3\n4\n5', `body=${JSON.stringify(body(r1.output))}`);

// R2
const r2 = await t.run('rm -rf /tmp/r5-nx && echo CHAIN', 5_000);
a.check('R2 rm -rf chain preserved', /CHAIN/.test(body(r2.output)), `body=${JSON.stringify(body(r2.output))}`);

// R2: xargs
const r3 = await t.run('seq 3 | xargs echo', 5_000);
a.check('R2 xargs preserved', body(r3.output) === '1 2 3', `body=${JSON.stringify(body(r3.output))}`);

// R3: /dev/null
const r4 = await t.run('echo X > /dev/null && echo OK', 5_000);
a.check('R3 /dev/null preserved', /\bOK\b/.test(body(r4.output)), `body=${JSON.stringify(body(r4.output))}`);

// R3: subshell
const r5 = await t.run('(echo a; echo b)', 5_000);
a.check('R3 subshell preserved', body(r5.output) === 'a\nb', `body=${JSON.stringify(body(r5.output))}`);

// R3: type (now `type echo` exits 1 with no output, but `type rm` is via registry — kept as builtin classification)
// type behaviour: R3 added type. After R5's `which` and `command` impl, `type X` still works through the
// registry resolution path that mkType uses. Sanity check.
const r6 = await t.run('type rm', 5_000);
a.check('R3 type rm preserved', /shell builtin/.test(body(r6.output)), `body=${JSON.stringify(body(r6.output))}`);

// R4: grep -n
const r7 = await t.run("printf 'a\\nfoo\\nb\\n' | grep -n foo", 5_000);
a.check('R4 grep -n preserved', body(r7.output) === '2:foo', `body=${JSON.stringify(body(r7.output))}`);

// R4: backtick
const r8 = await t.run('echo `echo hi`', 5_000);
a.check('R4 backtick preserved', body(r8.output) === 'hi', `body=${JSON.stringify(body(r8.output))}`);

// R4: find -size
await t.run('rm -rf /tmp/r5f && mkdir -p /tmp/r5f && touch /tmp/r5f/empty', 5_000);
const r9 = await t.run('find /tmp/r5f -size 0 -type f', 5_000);
a.check('R4 find -size preserved', /empty/.test(body(r9.output)), `body=${JSON.stringify(body(r9.output))}`);

// R4: printf %x
const r10 = await t.run('printf "%x\\n" 255', 5_000);
a.check('R4 printf %x preserved', body(r10.output) === 'ff', `body=${JSON.stringify(body(r10.output))}`);

// R4: unset
await t.run('export R5VAR=hi', 3_000);
await t.run('unset R5VAR', 3_000);
const r11 = await t.run('echo "[${R5VAR:-empty}]"', 3_000);
a.check('R4 unset preserved', body(r11.output) === '[empty]', `body=${JSON.stringify(body(r11.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
