#!/usr/bin/env bun
// repl/python-state-persistence — variables/imports defined in one
// REPL line persist into subsequent lines.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/python-state-persistence');
console.log(`repl/python-state-persistence — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

t.reset();
t.cmd('python');
await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python repl prompt');

// Import json across multiple lines + use it.
t.reset();
t.cmd('import json');
await t.waitFor((b) => (b.match(/>>> /g) || []).length >= 1, 10_000, '>>> after import');

t.cmd('data = {"answer": 42}');
await t.waitFor((b) => (b.match(/>>> /g) || []).length >= 2, 10_000, '>>> after data=');

t.reset();
t.cmd('print(json.dumps(data))');
await t.waitFor((b) => /\{"answer":\s*42\}/.test(b), 10_000, 'json.dumps output');
const out = stripAnsi(t.buf);
const hasJson = /\{"answer":\s*42\}/.test(out);
a.check('imported module + variable persist across REPL lines',
  hasJson, hasJson ? '' : JSON.stringify(out.slice(-200)));

t.cmd('exit()');
await t.waitForPrompt(15_000);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
