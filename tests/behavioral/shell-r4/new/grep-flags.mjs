#!/usr/bin/env bun
// shell-r4/new/grep-flags — BUG-SWEEP-R4-3.
//
// Pre-fix: -c emitted matched lines (not count), -n didn't prepend
// line number, -w didn't word-bound regex, -l not implemented.
//
// Post-fix: unified processLines() honours every flag through one
// code path. Stdin + file + recursive all routed through the same
// renderer.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r4/new/grep-flags');
console.log(`shell-r4/new/grep-flags — ${process.env.BASE}`);

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

// Probe 1: grep -c (count) from stdin
const r1 = await t.run("printf 'x\\nx\\ny\\nx\\n' | grep -c x", 5_000);
a.check('grep -c (count from stdin) outputs count not lines', body(r1.output) === '3', `body=${JSON.stringify(body(r1.output))}`);

// Probe 2: grep -n (line numbers)
const r2 = await t.run("printf 'a\\nfoo\\nb\\n' | grep -n foo", 5_000);
a.check('grep -n prepends line number', body(r2.output) === '2:foo', `body=${JSON.stringify(body(r2.output))}`);

// Probe 3: grep -w (word match)
const r3 = await t.run("echo 'foo foobar foo' | grep -w foo", 5_000);
const b3 = body(r3.output);
// -w foo matches: line contains 'foo' as a whole word. The line
// 'foo foobar foo' has 'foo' at position 0 and at the end — it
// DOES match (-w doesn't filter out the line if ANY occurrence is
// word-bounded). To verify -w semantics, test a line WITHOUT
// word-bounded match.
a.check('grep -w foo matches line with word-bounded foo present', /foo/.test(b3) && /foobar/.test(b3), `body=${JSON.stringify(b3)}`);
// Negative case: grep -w foo against ONLY foobar (no whole-word foo)
const r3b = await t.run("echo 'foobar' | grep -w foo", 5_000);
const b3b = body(r3b.output);
a.check('grep -w foo does NOT match foobar alone (no word-bounded foo)', b3b === '', `body=${JSON.stringify(b3b)}`);

// Probe 4: grep -l (files-with-matches)
await t.run('mkdir -p /tmp/r4grep && echo found > /tmp/r4grep/a.txt && echo no > /tmp/r4grep/b.txt', 5_000);
const r4 = await t.run('grep -l found /tmp/r4grep/a.txt /tmp/r4grep/b.txt', 5_000);
const b4 = body(r4.output);
a.check('grep -l emits filename only (no "file:" prefix or matched line)', /\/tmp\/r4grep\/a\.txt/.test(b4) && !/found/.test(b4) && !/b\.txt/.test(b4), `body=${JSON.stringify(b4)}`);

// Probe 5: grep -v invert
const r5 = await t.run("printf 'x\\ny\\nz\\n' | grep -v y", 5_000);
a.check('grep -v inverts match', body(r5.output) === 'x\nz', `body=${JSON.stringify(body(r5.output))}`);

// Probe 6: grep -i case-insensitive
const r6 = await t.run("echo 'Hello' | grep -i hello", 5_000);
a.check('grep -i case-insensitive', body(r6.output) === 'Hello', `body=${JSON.stringify(body(r6.output))}`);

// Probe 7: combined flags
const r7 = await t.run("printf 'foo\\nFOO\\nbar\\n' | grep -in foo", 5_000);
a.check('combined -in (line nums + case-insensitive)', body(r7.output) === '1:foo\n2:FOO', `body=${JSON.stringify(body(r7.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
