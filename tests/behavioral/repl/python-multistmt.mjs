#!/usr/bin/env bun
// repl/python-multistmt — multi-line statements share state.
//   x = 1
//   y = 2
//   print(x + y)
// → "3"

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/python-multistmt');
console.log(`repl/python-multistmt — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

t.reset();
t.cmd('python');
await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python repl prompt');

t.reset();
t.cmd('x = 1');
await t.waitFor((b) => /^>>> /m.test(b.split(/\r?\n/).slice(-3).join('\n')), 10_000, '>>> after x=1');

t.cmd('y = 2');
await t.waitFor((b) => {
  const tail = b.split(/\r?\n/).slice(-3).join('\n');
  return (tail.match(/>>> /g) || []).length >= 2;
}, 10_000, '>>> after y=2');

t.reset();
t.cmd('print(x + y)');
await t.waitFor((b) => /^3$/m.test(b), 10_000, 'print(x+y) output');
const out = stripAnsi(t.buf);
const has3 = /^3$/m.test(out);
a.check('multi-statement state persistence: print(x+y) == 3', has3,
  has3 ? '' : JSON.stringify(out.slice(-200)));

// An import and its use in separate pushes, and print()'s side effect.
const tail = (text, n = 250) => (text.length > n ? '…' + text.slice(-n) : text);
await t.run('import math', 15_000);
const pi = stripAnsi((await t.run('math.pi', 15_000)).output);
a.check('import math, then math.pi prints 3.14159…', /3\.14159/.test(pi), `output=${JSON.stringify(tail(pi))}`);
const printed = stripAnsi((await t.run('print("hello-multistmt")', 15_000)).output);
a.check('print("hello-multistmt") writes it', /hello-multistmt/.test(printed), `output=${JSON.stringify(tail(printed))}`);

// A one-line def is a compound statement: `...` until a blank line ends it
// (the REPL's, and CPython's, continuation rule), then it is callable.
t.reset();
t.cmd('def double(x): return x * 2');
await t.waitFor((b) => /\.\.\.\s*$/.test(b.trimEnd()), 15_000, '... after def');
t.reset();
t.cmd('');
await t.waitFor((b) => />>>\s*$/.test(b.trimEnd()), 15_000, '>>> after def block');
const doubled = stripAnsi((await t.run('double(21)', 15_000)).output);
a.check('def double, then double(21) → 42', /\b42\b/.test(doubled), `output=${JSON.stringify(tail(doubled))}`);

// sys.exit(5) ends the REPL with that status.
await t.run('import sys', 15_000);
t.reset();
t.cmd('sys.exit(5)');
await t.waitFor((b) => /\$\s*$/.test(b.trimEnd().slice(-3)), 15_000, 'shell prompt after sys.exit');
const exited = /EXIT=(\d+)/.exec(stripAnsi((await t.run('echo "EXIT=$?"', 10_000)).output));
a.check('sys.exit(5) → shell $? === 5', exited?.[1] === '5', `got=${exited?.[1] ?? 'no-match'}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
