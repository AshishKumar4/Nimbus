#!/usr/bin/env bun
// repl/python-typeerror — TypeError from runtime operation surfaces
// on stderr with verbatim CPython message.
//
// REPL Stream A regression coverage: same exception-routing path as
// python-nameerror.mjs but with TypeError. User reported `1 + "a"`
// was silent; post-fix it emits full traceback to stderr.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/python-typeerror');
console.log(`repl/python-typeerror — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install python', 180_000);

t.reset();
t.cmd('python');
await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python prompt');

t.reset();
t.cmd('1 + "a"');
await t.waitFor((b) => /TypeError/.test(b), 15_000, 'TypeError on stderr');
const out = stripAnsi(t.buf);
const hasType = /TypeError: unsupported operand type\(s\) for \+: 'int' and 'str'/.test(out);
a.check('TypeError from 1 + "a" surfaces with CPython message',
  hasType, hasType ? '' : JSON.stringify(out.slice(-300)));

t.cmd('exit()');
await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
