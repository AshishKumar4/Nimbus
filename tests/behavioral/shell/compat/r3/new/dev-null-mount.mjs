#!/usr/bin/env bun
// shell/compat/r3/new/dev-null-mount — shell compatibility.
//
// Pre-fix: `cmd > /dev/null` and `cmd 2>/dev/null` errored with
// `ENOENT: '/dev': no such file or directory`. Every standard
// Unix discard-output idiom broken.
//
// Post-fix: /dev mounted as DevProvider with null/zero/random/etc.
// Writes to /dev/null silently succeed (real Unix semantics).

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/compat/r3/new/dev-null-mount');
console.log(`shell/compat/r3/new/dev-null-mount — ${process.env.BASE}`);

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

// Probe 4: /dev/zero is a character device — a bounded read gets exactly the
// bytes it asked for. (An unbounded read has no answer and must not invent
// one; probe 5 covers that.)
const r4 = await t.run('head -c 65536 /dev/zero | wc -c', 15_000);
const out4 = body(r4.output);
a.check(
  'head -c 65536 /dev/zero reads exactly 65536 bytes',
  /\b65536\b/.test(out4),
  `body=${JSON.stringify(out4)}`,
);

// Probe 5: an unbounded read of /dev/zero fails loudly rather than silently
// returning whatever one buffer happened to hold.
const r5 = await t.run('cat /dev/zero > /tmp/zeros; echo RC=$?', 15_000);
const out5 = body(r5.output);
a.check(
  'cat /dev/zero fails instead of truncating silently',
  /RC=[1-9]/.test(out5),
  `body=${JSON.stringify(out5)}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
