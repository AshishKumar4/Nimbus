#!/usr/bin/env bun
// repl/python-bare-expression — bare expression at REPL prints its
// repr via displayhook. Real CPython: `a = 5\na` → "5".
//
// REPL Stream A regression coverage for the displayhook fix. Pre-fix,
// the future's resolved value was discarded; result of `a` was silent.
// Post-fix __nimbus_repl_finish explicitly emits repr(result)+'\\n'.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/python-bare-expression');
console.log(`repl/python-bare-expression — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install python', 180_000);

t.reset();
t.cmd('python');
await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python prompt');

// Assignment then bare expression — expect repr(5) on stdout.
t.reset();
t.cmd('a = 5');
await t.waitFor((b) => (b.match(/>>> /g) || []).length >= 1, 10_000, '>>> after a=5');

t.cmd('a');
await t.waitFor((b) => /\b5\b/.test(b), 15_000, 'value of a printed');
const out = stripAnsi(t.buf);
const fiveSeen = /\b5\b/.test(out);
a.check('bare expression `a` prints repr (displayhook)', fiveSeen,
  fiveSeen ? '' : JSON.stringify(out.slice(-200)));

// Bare arithmetic expression also exercises displayhook.
t.reset();
t.cmd('2 + 2');
await t.waitFor((b) => /\b4\b/.test(b), 10_000, '2+2=4');
const out2 = stripAnsi(t.buf);
const fourSeen = /^4$/m.test(out2);
a.check('bare arithmetic `2 + 2` prints 4', fourSeen,
  fourSeen ? '' : JSON.stringify(out2.slice(-200)));

t.cmd('exit()');
await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
