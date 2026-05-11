#!/usr/bin/env bun
// repl/python-ctrl-d — Ctrl-D (EOT, 0x04) on empty line closes the
// REPL cleanly and returns shell exit 0.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/python-ctrl-d');
console.log(`repl/python-ctrl-d — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

t.reset();
t.cmd('python');
await t.waitFor((b) => /^>>> /m.test(b), 30_000, 'python repl prompt');

// Send Ctrl-D (0x04). Note: no \r — single byte.
t.send('\x04');
await t.waitForPrompt(15_000);
const out = stripAnsi(t.buf);
const backToShell = /[$#>]\s*$/.test(out.trimEnd().slice(-3));
a.check('Ctrl-D closes REPL + returns to shell prompt', backToShell,
  backToShell ? '' : JSON.stringify(out.slice(-200)));

const { output: ex } = await t.run('echo "EX=$?"', 10_000);
const m = stripAnsi(ex).match(/EX=(\d+)/);
const got = m ? parseInt(m[1], 10) : -1;
a.check('Ctrl-D → shell $? === 0', got === 0, `got=${got}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
