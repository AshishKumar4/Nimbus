#!/usr/bin/env bun
// repl/python-syntax-error — invalid syntax surfaces SyntaxError and
// returns to REPL prompt (does NOT crash the session).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/python-syntax-error');
console.log(`repl/python-syntax-error — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

t.reset();
t.cmd('python');
await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python repl prompt');

// Invalid syntax (mismatched paren).
t.reset();
t.cmd('print("hi"');
await t.waitFor((b) => /SyntaxError|incomplete input|EOL/.test(b), 10_000, 'syntax error msg');
const out1 = stripAnsi(t.buf);
const hasErr = /SyntaxError|incomplete input|EOL/.test(out1);
a.check('invalid syntax surfaces SyntaxError', hasErr,
  hasErr ? '' : JSON.stringify(out1.slice(-200)));

// After the error, REPL should still respond. Send a valid statement.
t.reset();
t.cmd('print("alive")');
await t.waitFor((b) => /\balive\b/.test(b), 10_000, 'post-error alive');
const out2 = stripAnsi(t.buf);
const stillAlive = /\balive\b/.test(out2);
a.check('REPL recovers from syntax error', stillAlive,
  stillAlive ? '' : JSON.stringify(out2.slice(-200)));

t.cmd('exit()');
await t.waitForPrompt(15_000);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
