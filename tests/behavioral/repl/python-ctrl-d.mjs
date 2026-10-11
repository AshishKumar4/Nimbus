#!/usr/bin/env bun
// repl/python-ctrl-d — Ctrl-D (EOT, 0x04) on empty line closes the
// REPL cleanly and returns shell exit 0.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';
import { terminalCommandRunner } from '../../unit/lib/workerd-probe.mjs';

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
const beforeExit = stripAnsi(t.buf).length;
t.send('\x04');
// A Python >>> prompt also ends in >. It is still in the buffer when EOT
// is sent, so the generic prompt helper would accept it before exit runs.
await t.waitFor(b => b.length > beforeExit && /[$#]\s*$/.test(stripAnsi(b)), 15_000, 'new shell prompt after Ctrl-D');
const out = stripAnsi(t.buf);
const backToShell = /[$#]\s*$/.test(out.trimEnd().slice(-3));
a.check('Ctrl-D closes REPL + returns to shell prompt', backToShell,
  backToShell ? '' : JSON.stringify(out.slice(-200)));

const { stdout: ex } = await terminalCommandRunner(t)('echo "EX=$?"', 10_000);
const m = stripAnsi(ex).match(/^EX=(\d+)\r?$/m);
const got = m ? parseInt(m[1], 10) : -1;
a.check('Ctrl-D → shell $? === 0', got === 0, `got=${got}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
