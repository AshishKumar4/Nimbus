#!/usr/bin/env bun
// file-tree-watch/regression/terminal-still-works — wave inserted
// new switch arms in wsMessage; verify the terminal echo + shell
// prompt path is unaffected.

import { mintSession, Terminal, makeAsserter, stripAnsi, BASE } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/regression/terminal-still-works');
console.log(`file-tree-watch/regression/terminal-still-works — ${BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

// pwd works.
const { output: po } = await t.run('pwd', 10_000);
a.check('pwd returns /home/user',
  /\/home\/user/.test(stripAnsi(po)),
  `output=${JSON.stringify(stripAnsi(po).slice(-200))}`);

// echo works (basic stdout path).
const { output: eo } = await t.run('echo terminal-still-works-marker', 10_000);
a.check('echo marker visible',
  /terminal-still-works-marker/.test(stripAnsi(eo)),
  `output=${JSON.stringify(stripAnsi(eo).slice(-200))}`);

// `ls /home/user` produces non-empty output.
const { output: lso } = await t.run('ls /home/user', 10_000);
const s = stripAnsi(lso);
a.check('ls /home/user produced some output',
  s.length > 0 && !/error/i.test(s) && /[a-zA-Z]/.test(s),
  `output=${JSON.stringify(s.slice(-300))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
