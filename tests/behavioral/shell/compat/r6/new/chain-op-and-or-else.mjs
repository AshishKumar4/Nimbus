#!/usr/bin/env bun
// shell/compat/r6/new/chain-op-and-or-else — SHELL-R6-B1.
//
// Pre-fix: `false && A || B` produces NEITHER A nor B.
// Root cause: lifo-sh's executeListEntries does `break` on the first
// short-circuit instead of "skip the immediately-next entry, keep
// evaluating the remaining chain".
//
// Post-fix: skip-flag carries through; B prints.

import { mintSession, Terminal, makeAsserter, termBody } from '../../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/compat/r6/new/chain-op-and-or-else');
console.log(`shell/compat/r6/new/chain-op-and-or-else — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Probe 1: canonical bug
const r1 = await t.run('false && echo F || echo M', 5_000);
a.check('false && F || M → "M"', termBody(r1.output) === 'M', `body=${JSON.stringify(termBody(r1.output))}`);

// Probe 2: shouldn't print F
a.check('false && F || M → NOT "F"', !termBody(r1.output).includes('F'), `body=${JSON.stringify(termBody(r1.output))}`);

// Probe 3: true && F || M (should print F only)
const r3 = await t.run('true && echo F || echo M', 5_000);
a.check('true && F || M → "F"', termBody(r3.output) === 'F', `body=${JSON.stringify(termBody(r3.output))}`);

// Probe 4: longer chain — false && A || B && C (per POSIX, false fails,
// skip A; result still 1, || B runs; B succeeds → 0; && C runs → C).
const r4 = await t.run('false && echo A || echo B && echo C', 5_000);
a.check('false && A || B && C → "B" and "C"',
  termBody(r4.output).split(/\r?\n/).filter(Boolean).join(',') === 'B,C',
  `body=${JSON.stringify(termBody(r4.output))}`);

// Probe 5: false || true && C (per POSIX: false fails, || true runs → 0;
// && C runs → C).
const r5 = await t.run('false || true && echo C', 5_000);
a.check('false || true && C → "C"', termBody(r5.output) === 'C', `body=${JSON.stringify(termBody(r5.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
