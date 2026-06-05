#!/usr/bin/env bun
// shell/wrap-stdin-no-deadlock — regression probe for BUG-SWEEP-1.
//
// Pre-fix: every command registered by src/shell/unix-commands.ts hung
// indefinitely because wrap() awaited stdinObj.readAll() on lifo-sh's
// terminalStdin (an Ls instance), which only closes AFTER the command
// returns → deadlock. Repro on prod 2cdf458f: `seq 5` produced no
// output and never returned to the prompt.
//
// Post-fix: wrap() detects Ls (via the presence of `feed` method) and
// drains its already-buffered bytes synchronously without awaiting EOF.
// Pipe readers (Oi.reader from `echo X | cmd`) still use readAll()
// because the upstream closes the pipe after writing.
//
// This probe asserts BOTH:
//   1. A simple non-piped wrap'd command completes and produces output
//      within a reasonable time budget.
//   2. A piped wrap'd command (with real upstream data) still works.
//
// Charter contract (PROBE-QUALITY.md): only fail when a real user would
// see the bug. The 8s wait + prompt check captures the "shell hangs"
// experience verbatim.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/wrap-stdin-no-deadlock');
console.log(`shell/wrap-stdin-no-deadlock — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Probe 1: non-piped wrap'd command. Pre-fix hung; post-fix completes.
t.reset();
t.cmd('seq 5');
let promptOk = false;
try {
  await t.waitFor(
    (b) => /^1[\r\n]+2[\r\n]+3[\r\n]+4[\r\n]+5/m.test(b) && /[$#]\s*$/.test(b.trimEnd().slice(-3)),
    10_000,
    'seq 5 output + prompt',
  );
  promptOk = true;
} catch (_e) { /* assertion below records failure */ }
const seqOut = stripAnsi(t.buf);
a.check(
  'non-piped wrap\'d cmd `seq 5` produces 1..5 and returns to prompt (no deadlock)',
  promptOk && /1[\r\n]+2[\r\n]+3[\r\n]+4[\r\n]+5/.test(seqOut),
  `tail: ${JSON.stringify(seqOut.slice(-200))}`,
);

// Probe 2: another wrap'd cmd that USES vfs (touch). Pre-fix hung.
t.reset();
t.cmd('touch /tmp/sweep-probe.txt && ls /tmp/sweep-probe.txt');
let touchOk = false;
try {
  await t.waitFor(
    (b) => /sweep-probe\.txt/.test(b) && /[$#]\s*$/.test(b.trimEnd().slice(-3)),
    10_000,
    'touch + ls output + prompt',
  );
  touchOk = true;
} catch (_e) {}
const touchOut = stripAnsi(t.buf);
a.check(
  'wrap\'d `touch <file>` completes and file is visible to `ls`',
  touchOk && /sweep-probe\.txt/.test(touchOut),
  `tail: ${JSON.stringify(touchOut.slice(-200))}`,
);

// Probe 3: piped wrap'd cmd still works. The pipe reader has no `feed`
// method, so the wrap awaits readAll() on the bounded pipe stream.
t.reset();
t.cmd('echo "hello world" | wc -w');
let pipeOk = false;
try {
  await t.waitFor(
    (b) => /\b2\b/.test(b) && /[$#]\s*$/.test(b.trimEnd().slice(-3)),
    10_000,
    'wc -w piped output',
  );
  pipeOk = true;
} catch (_e) {}
const pipeOut = stripAnsi(t.buf);
a.check(
  'piped `echo X | wc -w` still works (pipe reader path unchanged)',
  pipeOk && /\b2\b/.test(pipeOut),
  `tail: ${JSON.stringify(pipeOut.slice(-200))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
