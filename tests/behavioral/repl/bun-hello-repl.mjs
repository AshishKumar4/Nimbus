#!/usr/bin/env bun
// repl/bun-hello-repl — `bun` with no args drops into REPL.
// console.log("hi") prints "hi". .exit returns to shell.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/bun-hello-repl');
console.log(`repl/bun-hello-repl — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

t.reset();
t.cmd('bun');
try {
  await t.waitFor((b) => /^> /m.test(b), 30_000, 'bun repl prompt');
  a.check('bun no-args drops into REPL with > prompt', true,
    JSON.stringify(stripAnsi(t.buf).slice(-200)));
} catch (e) {
  a.check('bun no-args drops into REPL with > prompt', false, `${e.message}`);
  await t.close();
  process.exit(1);
}

t.reset();
t.cmd('console.log("hi")');
await t.waitFor((b) => /\bhi\b/m.test(b), 15_000, 'console.log("hi") output');
const out1 = stripAnsi(t.buf);
const hasHi = /\bhi\b/m.test(out1);
a.check('console.log("hi") prints "hi" in REPL', hasHi,
  hasHi ? '' : JSON.stringify(out1.slice(-200)));

// Bare expression → util.inspect via displayhook
t.reset();
t.cmd('1 + 2');
await t.waitFor((b) => /^3\b/m.test(b), 10_000, 'expression value');
const out2 = stripAnsi(t.buf);
const has3 = /^3\b/m.test(out2);
a.check('bare expression 1+2 prints 3 (displayhook)', has3,
  has3 ? '' : JSON.stringify(out2.slice(-200)));

t.reset();
t.cmd('.exit');
await t.waitFor((b) => /[$#]\s*$/.test(b.trimEnd().slice(-3)), 15_000, 'shell prompt');
const out3 = stripAnsi(t.buf);
const backToShell = /user@nimbus:.+\$/.test(out3);
a.check('.exit returns to shell prompt', backToShell,
  backToShell ? '' : JSON.stringify(out3.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
