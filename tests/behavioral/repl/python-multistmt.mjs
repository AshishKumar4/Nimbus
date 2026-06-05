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

t.cmd('exit()');
await t.waitForPrompt(15_000);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
