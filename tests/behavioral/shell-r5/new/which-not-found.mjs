#!/usr/bin/env bun
// shell-r5/new/which-not-found — SHELL-FOLLOWUPS-1 not-found path.
//
// Real `which` exits 1 + writes stderr 'no X in (PATH)' when target
// is neither in PATH nor a canonical-bin entry nor a registered
// builtin. Pre-fix our `which` printed 'X: not found' to stderr but
// always exited 0 (registered builtins absorbed all paths).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r5/new/which-not-found');
console.log(`shell-r5/new/which-not-found — ${process.env.BASE}`);

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

// Probe 1: which on bogus name exits 1
await t.run('which nonexistent_xyz_zzz', 5_000);
const r1 = await t.run('echo "ex=$?"', 5_000);
a.check('which <unknown> → exit 1', body(r1.output) === 'ex=1', `body=${JSON.stringify(body(r1.output))}`);

// Probe 2: stderr message format
const r2 = await t.run('which nonexistent_xyz_zzz 2>&1', 5_000);
const b2 = body(r2.output);
a.check('which <unknown> stderr: "no X in (...)"', /which: no nonexistent_xyz_zzz in/.test(b2), `body=${JSON.stringify(b2)}`);

// Probe 3: -s silent flag suppresses stderr
const r3 = await t.run('which -s nonexistent_xyz_zzz 2>&1 ; echo "ex=$?"', 5_000);
const b3 = body(r3.output);
a.check('which -s <unknown> silent (no stderr) + exit 1', b3 === 'ex=1', `body=${JSON.stringify(b3)}`);

// Probe 4: chained `which X && next` short-circuits on miss
const r4 = await t.run('which nonexistent_xyz_zzz && echo found || echo missed', 5_000);
const b4 = body(r4.output);
a.check('chain `which X && Y || Z` runs Z on miss', /\bmissed\b/.test(b4), `body=${JSON.stringify(b4)}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
