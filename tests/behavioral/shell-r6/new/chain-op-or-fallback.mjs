#!/usr/bin/env bun
// shell-r6/new/chain-op-or-fallback — SHELL-R6-B1 regression-sibling.
//
// Simple `||` and `cmd || fallback` chains must keep working. These
// were the forms that worked pre-fix; probe ensures we didn't break
// them with the new executeListEntries.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r6/new/chain-op-or-fallback');
console.log(`shell-r6/new/chain-op-or-fallback — ${process.env.BASE}`);

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

const r1 = await t.run('false || echo M', 5_000);
a.check('false || M → "M"', body(r1.output) === 'M', `body=${JSON.stringify(body(r1.output))}`);

const r2 = await t.run('true || echo M', 5_000);
a.check('true || M → empty', body(r2.output) === '', `body=${JSON.stringify(body(r2.output))}`);

// Triple chain: false || false || M
const r3 = await t.run('false || false || echo M', 5_000);
a.check('false || false || M → "M"', body(r3.output) === 'M', `body=${JSON.stringify(body(r3.output))}`);

// false || true || M (short-circuit at true)
const r4 = await t.run('false || true || echo M', 5_000);
a.check('false || true || M → empty (short-circuit)',
  body(r4.output) === '',
  `body=${JSON.stringify(body(r4.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
