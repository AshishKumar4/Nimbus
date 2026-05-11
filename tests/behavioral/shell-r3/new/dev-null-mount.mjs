#!/usr/bin/env bun
// shell-r3/new/dev-null-mount — BUG-SWEEP-R3-1.
//
// Pre-fix: `cmd > /dev/null` and `cmd 2>/dev/null` errored with
// `ENOENT: '/dev': no such file or directory`. Every standard
// Unix discard-output idiom broken.
//
// Post-fix: /dev mounted as DevProvider with null/zero/random/etc.
// Writes to /dev/null silently succeed (real Unix semantics).

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r3/new/dev-null-mount');
console.log(`shell-r3/new/dev-null-mount — ${process.env.BASE}`);

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

// Probe 1: `echo X > /dev/null` doesn't error
const r1 = await t.run('echo hidden > /dev/null && echo after', 5_000);
a.check(
  '`echo X > /dev/null && echo after` runs (no ENOENT)',
  /\bafter\b/.test(body(r1.output)) && !/ENOENT/.test(body(r1.output)),
  `body=${JSON.stringify(body(r1.output))}`,
);

// Probe 2: `cat /dev/null` returns empty (succeeds)
const r2 = await t.run('cat /dev/null && echo EMPTY_OK', 5_000);
a.check(
  '`cat /dev/null` succeeds (empty output)',
  body(r2.output) === 'EMPTY_OK',
  `body=${JSON.stringify(body(r2.output))}`,
);

// Probe 3: /dev/null exists per `test -e`
const r3 = await t.run('ls -la /dev/ 2>&1', 5_000);
a.check(
  'ls /dev/ lists virtual device files (null at minimum)',
  /\bnull\b/.test(body(r3.output)),
  `body=${JSON.stringify(body(r3.output))}`,
);

// Probe 4: cat /dev/zero produces non-empty content (we cap at 64KiB
// so the read returns 65536 NUL bytes — `wc -c` counts them).
const r4 = await t.run('wc -c < /dev/zero 2>&1 || cat /dev/zero | wc -c', 8_000);
const out4 = body(r4.output);
a.check(
  '/dev/zero reads return non-empty content (capped)',
  /\b65536\b/.test(out4) || /\b\d{4,}\b/.test(out4),
  `body=${JSON.stringify(out4)}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
