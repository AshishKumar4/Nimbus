#!/usr/bin/env bun
// monaco-wave-a/regression/terminal-still-works — terminal keystroke
// + multi-byte echo + paste preserved post-Wave-A.
//
// Wave-A adds fs-* WS messages and a new fs-callback on the
// WebSocketTerminal. handleMessage's switch now has new cases. This
// probe ensures the existing 'input' / 'resize' cases STILL work
// (no regression of the shell input path).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/regression/terminal-still-works');
console.log(`monaco-wave-a/regression/terminal-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Probe 1: single-line echo.
const r1 = await t.run('echo hello-wave-a', 10_000);
a.check('echo single-line', /hello-wave-a/.test(stripAnsi(r1.output)),
  `output=${JSON.stringify(stripAnsi(r1.output).slice(-200))}`);

// Probe 2: multi-byte (UTF-8) echo.
const r2 = await t.run('echo "héllo-naïve-世界"', 10_000);
a.check('echo multi-byte UTF-8',
  /héllo-naïve-世界/.test(stripAnsi(r2.output)),
  `output=${JSON.stringify(stripAnsi(r2.output).slice(-200))}`);

// Probe 3: paste-like multi-line (rapid `send` with embedded \r).
t.reset();
t.send('echo line1\recho line2\recho line3\r');
await t.waitFor((b) => /line3/.test(b) && /\$\s*$/.test(b.trimEnd().slice(-3)), 15_000, 'paste-complete');
const buf = stripAnsi(t.buf);
a.check('paste 3-line block — all lines appear',
  /line1/.test(buf) && /line2/.test(buf) && /line3/.test(buf),
  `buf=${JSON.stringify(buf.slice(-300))}`);

// Probe 4: cd + cwd preservation (existing snapshot path).
await t.run('mkdir -p /home/user/regr-mw-a && cd /home/user/regr-mw-a', 10_000);
const r4 = await t.run('pwd', 10_000);
a.check('cd + pwd still works',
  /\/home\/user\/regr-mw-a/.test(stripAnsi(r4.output)),
  `output=${JSON.stringify(stripAnsi(r4.output).slice(-200))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
