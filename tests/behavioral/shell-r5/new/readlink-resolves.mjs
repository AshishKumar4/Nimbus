#!/usr/bin/env bun
// shell-r5/new/readlink-resolves — SHELL-FOLLOWUPS-4.
//
// Pre-fix: `readlink` was either missing or always reported "not a
// symlink" (since ln -s did a copy, no symlink existed).
// Post-fix:
//   - `readlink LINK` → prints the target stored in SymlinkRegistry.
//   - exit 1 + no output for non-symlink paths.
//   - `readlink -f LINK` → resolves chain to canonical absolute path.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r5/new/readlink-resolves');
console.log(`shell-r5/new/readlink-resolves — ${process.env.BASE}`);

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

// Setup
await t.run('mkdir -p /tmp/rls && cd /tmp/rls', 5_000);
await t.run('echo data > real.txt', 5_000);
await t.run('ln -s real.txt l1.txt', 5_000);
await t.run('ln -s l1.txt l2.txt', 5_000);

// Probe 1: readlink prints target (one hop).
const r1 = await t.run('readlink l1.txt', 5_000);
a.check('readlink l1 → "real.txt"',
  body(r1.output) === 'real.txt',
  `body=${JSON.stringify(body(r1.output))}`);

// Probe 2: readlink on chained link prints immediate target (one hop, not -f).
const r2 = await t.run('readlink l2.txt', 5_000);
a.check('readlink l2 → "l1.txt" (one hop, not full chain)',
  body(r2.output) === 'l1.txt',
  `body=${JSON.stringify(body(r2.output))}`);

// Probe 3: readlink on real file: empty output, exit 1.
const r3 = await t.run('readlink real.txt; echo EXIT:$?', 5_000);
const r3body = body(r3.output);
a.check('readlink non-symlink → empty + EXIT:1',
  r3body === 'EXIT:1',
  `body=${JSON.stringify(r3body)}`);

// Probe 4: readlink -f resolves chain to canonical absolute path.
const r4 = await t.run('readlink -f l2.txt', 5_000);
a.check('readlink -f l2 → "/tmp/rls/real.txt"',
  body(r4.output) === '/tmp/rls/real.txt',
  `body=${JSON.stringify(body(r4.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
