#!/usr/bin/env bun
// repl/python-hello-repl — `python` with no args drops into REPL.
// Type `print("hi")<enter>` → "hi" on stdout. `exit()<enter>` → exit
// code 0 + shell prompt returns.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/python-hello-repl');
console.log(`repl/python-hello-repl — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

// `python` with no args → REPL. Use cmd() (fire-and-forget) because
// REPL keeps the terminal busy until exit().
t.reset();
t.cmd('python');

// Wait for Python REPL prompt `>>> `.
try {
  await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python repl prompt');
  a.check('python no-args drops into REPL with >>> prompt', true,
    JSON.stringify(stripAnsi(t.buf).slice(-200)));
} catch (e) {
  a.check('python no-args drops into REPL with >>> prompt', false,
    `${e.message}`);
  await t.close();
  process.exit(1);
}

// Send `print("hi")<enter>`.
t.reset();
t.cmd('print("hi")');
await t.waitFor((b) => /\bhi\b/m.test(b), 15_000, 'print("hi") output');
const out1 = stripAnsi(t.buf);
const hasHi = /\bhi\b/m.test(out1);
a.check('print("hi") prints "hi" in REPL', hasHi,
  hasHi ? '' : JSON.stringify(out1.slice(-200)));

// Send `exit()<enter>` → should return to shell prompt. `waitForPrompt`
// accepts `>` as a prompt, and Python's own `>>> ` satisfies it, so waiting
// on it here returns on the REPL prompt the probe is trying to leave. Wait
// for the SHELL prompt specifically, as the node/bun REPL probes do.
t.reset();
t.cmd('exit()');
await t.waitFor((b) => /[$#]\s*$/.test(b.trimEnd().slice(-3)) && /user@nimbus/.test(b),
  15_000, 'shell prompt after exit()');
const out2 = stripAnsi(t.buf);
const backToShell = /user@nimbus:.+\$/.test(out2);
a.check('exit() returns to shell prompt', backToShell,
  backToShell ? '' : JSON.stringify(out2.slice(-200)));

// Verify shell exit code via $?. Wait for the marker itself rather than for
// a prompt: the REPL teardown is still draining bytes, and any prompt-shaped
// tail of it would end the wait before this command's output arrives.
t.reset();
t.cmd('echo "EX=$?=END"');
await t.waitFor((b) => /EX=\d+=END/.test(b), 15_000, 'exit-code marker');
const exMatch = stripAnsi(t.buf).match(/EX=(\d+)=END/);
const exitCode = exMatch ? parseInt(exMatch[1], 10) : -1;
a.check('exit() → shell $? === 0', exitCode === 0, `got=${exitCode}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
