#!/usr/bin/env bun
// shell-r6/new/yes-pipe-head — SHELL-R6-B2.
//
// Pre-fix: `yes | head -n 5` hangs forever because lifo-sh's
// executePipelineCommands awaits Promise.all without aborting
// producers when consumers finish. `yes` watches e.signal which is
// never aborted; head's readAll() never returns (yes writes
// infinitely).
//
// Post-fix: per-pipeline AbortController; when the consumer (last
// command) resolves, the controller aborts, cascading to producers'
// e.signal — `yes` sees signal.aborted and exits.
//
// Each test runs in a FRESH session because a hung yes-pipe pollutes
// the session for subsequent commands.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r6/new/yes-pipe-head');
console.log(`shell-r6/new/yes-pipe-head — ${process.env.BASE}`);

function body(raw) {
  const ansi = stripAnsi(raw);
  const lines = ansi.split(/\r?\n/);
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

async function runIsolated(cmd, timeoutMs) {
  const sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  let failed = false;
  let bodyText = '';
  try {
    const r = await t.run(cmd, timeoutMs);
    bodyText = body(r.output);
  } catch (e) {
    failed = true;
    bodyText = `TIMEOUT: ${e.message}`;
  }
  try { await t.close(); } catch {}
  return { failed, body: bodyText };
}

// Probe 1: yes | head -n 5 — terminates with 5 lines of "y".
const r1 = await runIsolated('yes | head -n 5', 6_000);
a.check('yes | head -n 5 — terminates (does not time out)',
  !r1.failed,
  `failed=${r1.failed} body=${JSON.stringify(r1.body)}`);
if (!r1.failed) {
  const lines = r1.body.split(/\r?\n/).filter(Boolean);
  a.check('yes | head -n 5 — exactly 5 lines',
    lines.length === 5,
    `lines=${lines.length} body=${JSON.stringify(r1.body)}`);
  a.check('yes | head -n 5 — every line is "y"',
    lines.every(l => l === 'y'),
    `body=${JSON.stringify(r1.body)}`);
}

// Probe 2: yes nimbus | head -n 3 — custom string.
const r2 = await runIsolated('yes nimbus | head -n 3', 6_000);
a.check('yes nimbus | head -n 3 — terminates',
  !r2.failed,
  `failed=${r2.failed} body=${JSON.stringify(r2.body)}`);
if (!r2.failed) {
  const lines = r2.body.split(/\r?\n/).filter(Boolean);
  a.check('yes nimbus | head -n 3 — 3 lines of "nimbus"',
    lines.length === 3 && lines.every(l => l === 'nimbus'),
    `lines=${JSON.stringify(lines)}`);
}

// Probe 3: regression — non-blocking producer (printf | head) still works.
const r3 = await runIsolated('printf "1\\n2\\n3\\n4\\n5\\n" | head -n 3', 5_000);
a.check('printf | head -n 3 — first 3 lines (regression control)',
  !r3.failed && r3.body === '1\n2\n3',
  `body=${JSON.stringify(r3.body)}`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
