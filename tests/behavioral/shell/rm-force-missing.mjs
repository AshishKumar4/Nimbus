#!/usr/bin/env bun
// shell/rm-force-missing — regression probe for BUG-SWEEP-R2-1.
//
// Pre-fix: `rm -rf /tmp/nonexistent` returned exit 1 (lifo-sh's rm
// caught only `e instanceof VFSError`, but SqliteVFSProvider.stat
// throws raw `Error("ENOENT: ...")`, so the error propagated to
// executeCommand which set exit=1). Every `rm -rf X && next` thus
// short-circuited and silently dropped subsequent commands in the
// chain — the most common cleanup idiom in shell scripts.
//
// Post-fix: src/shell/unix-commands.ts mkRm registered in the
// registry's `commands` map (precedence over lifo-sh's lazy).
// POSIX -f semantics: silent success on missing target. -r required
// for directory delete (uses internal recursive helper that walks
// SqliteVFS readdir).

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/rm-force-missing');
console.log(`shell/rm-force-missing — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Probe 1: `rm -rf <missing> && echo after` runs `echo after`.
const r1 = await t.run('rm -rf /tmp/nimbus-bsr2-no-such && echo CHAIN_OK', 10_000);
const out1 = stripAnsi(r1.output);
a.check(
  '`rm -rf <missing>` returns 0; chained `&& echo X` runs',
  /CHAIN_OK/.test(out1),
  `tail: ${JSON.stringify(out1.slice(-200))}`,
);

// Probe 2: $? after `rm -rf <missing>` is 0.
await t.run('rm -rf /tmp/nimbus-bsr2-also-missing', 10_000);
const r2 = await t.run('echo "EX=$?"', 5_000);
const m2 = stripAnsi(r2.output).match(/EX=(\d+)/);
a.check(
  '`rm -rf <missing>`: $? === 0',
  m2 && m2[1] === '0',
  `output: ${JSON.stringify(stripAnsi(r2.output).slice(-150))}`,
);

// Probe 3: `rm` (no -f) on missing file errors AND $? === 1.
const r3 = await t.run('rm /tmp/nimbus-bsr2-no-such-strict', 10_000);
const out3 = stripAnsi(r3.output);
const r3ex = await t.run('echo "EX=$?"', 5_000);
const m3 = stripAnsi(r3ex.output).match(/EX=(\d+)/);
a.check(
  '`rm` (no -f) on missing: stderr message + $? === 1',
  /No such file/.test(out3) && m3 && m3[1] === '1',
  `out: ${JSON.stringify(out3.slice(-150))}, ex: ${JSON.stringify(stripAnsi(r3ex.output).slice(-100))}`,
);

// Probe 4: real-world cleanup idiom — `rm -rf build && mkdir build && touch build/x`.
const r4 = await t.run(
  'rm -rf /tmp/bsr2-build && mkdir /tmp/bsr2-build && touch /tmp/bsr2-build/x && ls /tmp/bsr2-build',
  15_000,
);
const out4 = stripAnsi(r4.output);
a.check(
  'cleanup idiom `rm -rf X && mkdir X && touch X/y && ls X` chains correctly',
  /\bx\b/.test(out4),
  `tail: ${JSON.stringify(out4.slice(-200))}`,
);

// Probe 5: `rm -rf` actually deletes a populated directory recursively.
await t.run('mkdir -p /tmp/bsr2-recur/sub && touch /tmp/bsr2-recur/sub/f.txt /tmp/bsr2-recur/g.txt', 10_000);
const before = await t.run('ls /tmp/bsr2-recur', 5_000);
const r5 = await t.run('rm -rf /tmp/bsr2-recur && echo GONE && ls /tmp/bsr2-recur 2>&1', 10_000);
const out5 = stripAnsi(r5.output);
a.check(
  '`rm -rf <dir>` actually removes a populated directory',
  /\bsub\b/.test(stripAnsi(before.output)) && /GONE/.test(out5) && /(No such file|cannot)/.test(out5),
  `tail: ${JSON.stringify(out5.slice(-250))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
