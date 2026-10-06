#!/usr/bin/env bun
// shell/compat/r6/new/chain-op-or-fallback — SHELL-R6-B1 regression-sibling.
//
// Simple `||` and `cmd || fallback` chains must keep working. These
// were the forms that worked pre-fix; probe ensures we didn't break
// them with the new executeListEntries.

import { mintSession, Terminal, makeAsserter, termBody } from '../../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/compat/r6/new/chain-op-or-fallback');
console.log(`shell/compat/r6/new/chain-op-or-fallback — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const r1 = await t.run('false || echo M', 5_000);
a.check('false || M → "M"', termBody(r1.output) === 'M', `body=${JSON.stringify(termBody(r1.output))}`);

const r2 = await t.run('true || echo M', 5_000);
a.check('true || M → empty', termBody(r2.output) === '', `body=${JSON.stringify(termBody(r2.output))}`);

// Triple chain: false || false || M
const r3 = await t.run('false || false || echo M', 5_000);
a.check('false || false || M → "M"', termBody(r3.output) === 'M', `body=${JSON.stringify(termBody(r3.output))}`);

// false || true || M (short-circuit at true)
const r4 = await t.run('false || true || echo M', 5_000);
a.check('false || true || M → empty (short-circuit)',
  termBody(r4.output) === '',
  `body=${JSON.stringify(termBody(r4.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
