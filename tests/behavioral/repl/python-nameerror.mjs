#!/usr/bin/env bun
// repl/python-nameerror — referencing an undefined name surfaces
// NameError traceback on stderr.
//
// REPL Stream A regression coverage: pre-fix the future's rejection
// was swallowed; runtime exceptions were silent. Post-fix
// __nimbus_repl_finish catches BaseException + emits
// traceback.format_exception via stderr_callback.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/python-nameerror');
console.log(`repl/python-nameerror — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install python', 180_000);

t.reset();
t.cmd('python');
await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python prompt');

t.reset();
t.cmd('undefined_var');
await t.waitFor((b) => /NameError/.test(b), 15_000, 'NameError on stderr');
const out = stripAnsi(t.buf);
const hasName = /NameError: name 'undefined_var' is not defined/.test(out);
a.check('NameError surfaces with verbatim CPython message',
  hasName, hasName ? '' : JSON.stringify(out.slice(-300)));

t.cmd('exit()');
await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
