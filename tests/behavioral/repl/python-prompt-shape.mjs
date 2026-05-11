#!/usr/bin/env bun
// repl/python-prompt-shape — the REPL emits `>>> ` for primary and
// `... ` for continuation (after an open block).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/python-prompt-shape');
console.log(`repl/python-prompt-shape — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

t.reset();
t.cmd('python');
await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'primary >>> prompt');
const out1 = stripAnsi(t.buf);
const hasPrimary = />>> /.test(out1);
a.check('primary prompt is ">>> "', hasPrimary,
  hasPrimary ? '' : JSON.stringify(out1.slice(-200)));

// Trigger continuation prompt via incomplete block.
t.reset();
t.cmd('def f():');
await t.waitFor((b) => /^\.\.\. /m.test(b), 10_000, 'continuation ... prompt');
const out2 = stripAnsi(t.buf);
const hasCont = /\.\.\. /.test(out2);
a.check('continuation prompt is "... " after open block', hasCont,
  hasCont ? '' : JSON.stringify(out2.slice(-300)));

// Complete the block (indented return, then blank line).
t.cmd('    return 42');
// Wait briefly for the next `... ` then blank line.
await t.waitFor((b) => (b.match(/\.\.\. /g) || []).length >= 2, 10_000, 'second ... prompt');
t.cmd('');  // blank line completes the block
await t.waitFor((b) => {
  // After blank line, primary prompt returns
  const tail = b.split(/\r?\n/).slice(-3).join('\n');
  return />>> /.test(tail);
}, 10_000, 'back to >>> after block close');

// Call the function.
t.reset();
t.cmd('print(f())');
await t.waitFor((b) => /^42$/m.test(b), 10_000, 'f() output');
const out3 = stripAnsi(t.buf);
const has42 = /^42$/m.test(out3);
a.check('multi-line def works (print(f()) == 42)', has42,
  has42 ? '' : JSON.stringify(out3.slice(-200)));

t.cmd('exit()');
await t.waitForPrompt(15_000);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
