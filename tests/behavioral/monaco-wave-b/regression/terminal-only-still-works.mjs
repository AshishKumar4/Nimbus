#!/usr/bin/env bun
// monaco-wave-b/regression/terminal-only-still-works — pre-Wave-A
// terminal-only mode + keystroke/echo path preserved.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/regression/terminal-only-still-works');
console.log(`monaco-wave-b/regression/terminal-only-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const r1 = await t.run('echo hello-wave-b', 10_000);
a.check('echo single-line',
  /hello-wave-b/.test(stripAnsi(r1.output)),
  `output=${JSON.stringify(stripAnsi(r1.output).slice(-200))}`);

const r2 = await t.run('echo "héllo-世界"', 10_000);
a.check('echo multi-byte UTF-8',
  /héllo-世界/.test(stripAnsi(r2.output)),
  `output=${JSON.stringify(stripAnsi(r2.output).slice(-200))}`);

// Paste-style multi-line.
t.reset();
t.send('echo a\recho b\recho c\r');
await t.waitFor((b) => /\bc\b/.test(b) && /\$\s*$/.test(b.trimEnd().slice(-3)), 15_000, 'paste-complete');
const buf = stripAnsi(t.buf);
a.check('paste 3-line block — all lines appear',
  /\ba\b/.test(buf) && /\bb\b/.test(buf) && /\bc\b/.test(buf),
  `buf=${JSON.stringify(buf.slice(-200))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
