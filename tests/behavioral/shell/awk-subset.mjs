#!/usr/bin/env bun
// shell/awk-subset — regression probe for shell compatibility.
//
// Pre-fix mkAwk supported only `{print $N}` and `/pattern/`. Common
// real-world awk patterns (BEGIN/END, $NF, sum += $N, printf) all
// produced 'awk: unsupported program'.
//
// Post-fix: expanded subset with BEGIN/END blocks, $0..$N, $NF, NR,
// NF, simple expressions, printf, compound assignments.

import { mintSession, Terminal, makeAsserter, termBody } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/awk-subset');
console.log(`shell/awk-subset — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Probe 1: $NF
const r1 = await t.run("echo 'a b c' | awk '{print $NF}'", 5_000);
a.check('$NF prints last field', termBody(r1.output) === 'c', `body=${JSON.stringify(termBody(r1.output))}`);

// Probe 2: -F separator
const r2 = await t.run("echo 'a,b,c' | awk -F, '{print $2}'", 5_000);
a.check('-F field separator works', termBody(r2.output) === 'b', `body=${JSON.stringify(termBody(r2.output))}`);

// Probe 3: BEGIN block
const r3 = await t.run("echo 'x' | awk 'BEGIN {print \"start\"} {print $0}'", 5_000);
a.check('BEGIN block runs before input', termBody(r3.output) === 'start\nx', `body=${JSON.stringify(termBody(r3.output))}`);

// Probe 4: END block + sum accumulator
const r4 = await t.run("seq 5 | awk '{sum += $1} END {print sum}'", 8_000);
a.check('END block + sum compound assignment', termBody(r4.output) === '15', `body=${JSON.stringify(termBody(r4.output))}`);

// Probe 5: NR (record number)
const r5 = await t.run("seq 3 | awk '{print NR, $1}'", 5_000);
a.check('NR record number', termBody(r5.output) === '1 1\n2 2\n3 3', `body=${JSON.stringify(termBody(r5.output))}`);

// Probe 6: printf
const r6 = await t.run("echo '42' | awk '{printf \"value=%d hex=%x\\n\", $1, $1}'", 5_000);
a.check('printf with %d and %x', termBody(r6.output) === 'value=42 hex=2a', `body=${JSON.stringify(termBody(r6.output))}`);

// Probe 7: pattern match still works (legacy behaviour preserved)
const r7 = await t.run("printf 'foo\\nbar\\nbaz\\n' | awk '/ba/ {print}'", 5_000);
a.check('pattern /ba/ matches bar and baz', termBody(r7.output) === 'bar\nbaz', `body=${JSON.stringify(termBody(r7.output))}`);

// Probe 8: field arithmetic
const r8 = await t.run("echo '10 20' | awk '{print $1 + $2}'", 5_000);
a.check('field arithmetic: $1 + $2', termBody(r8.output) === '30', `body=${JSON.stringify(termBody(r8.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
