#!/usr/bin/env bun
// editor/monaco/regression/terminal-still-works — terminal keystroke
// + multi-byte echo + paste preserved post-editor.
//
// editor adds fs-* WS messages and a new fs-callback on the
// WebSocketTerminal. handleMessage's switch now has new cases. This
// probe ensures the existing 'input' / 'resize' cases STILL work
// (no regression of the shell input path). It is the one terminal
// baseline: each check reads a command's output lines, never its echo,
// so a command that prints nothing cannot pass on its own text.

import { hasOutputLine, mintSession, Terminal, makeAsserter, stripAnsi, termBody } from '../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('editor/monaco/regression/terminal-still-works');
console.log(`editor/monaco/regression/terminal-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Probe 0: a fresh shell starts in the user's home, which has entries.
const r0 = await t.run('pwd', 10_000);
a.check('a fresh shell starts in /home/user',
  hasOutputLine(r0.output, '/home/user'),
  `output=${JSON.stringify(stripAnsi(r0.output).slice(-200))}`);
const lsRun = await t.run('ls -1 /home/user', 10_000);
const listed = termBody(lsRun.output).split('\n').map((line) => line.trim()).filter(Boolean);
a.check('ls /home/user lists entries',
  lsRun.exitCode === 0 && listed.length > 0,
  `exit=${lsRun.exitCode} output=${JSON.stringify(stripAnsi(lsRun.output).slice(-300))}`);

// Probe 1: single-line echo.
const r1 = await t.run('echo hello-wave-a', 10_000);
a.check('echo single-line', hasOutputLine(r1.output, 'hello-wave-a'),
  `output=${JSON.stringify(stripAnsi(r1.output).slice(-200))}`);

// Probe 2: multi-byte (UTF-8) echo.
const r2 = await t.run('echo "héllo-naïve-世界"', 10_000);
a.check('echo multi-byte UTF-8',
  hasOutputLine(r2.output, 'héllo-naïve-世界'),
  `output=${JSON.stringify(stripAnsi(r2.output).slice(-200))}`);

// Probe 3: paste-like multi-line (rapid `send` with embedded \r).
t.reset();
t.send('echo line1\recho line2\recho line3\r');
await t.waitFor((b) => hasOutputLine(b, 'line3') && /\$\s*$/.test(b.trimEnd().slice(-3)), 15_000, 'paste-complete');
const buf = stripAnsi(t.buf);
a.check('paste 3-line block — all lines appear',
  hasOutputLine(buf, 'line1') && hasOutputLine(buf, 'line2') && hasOutputLine(buf, 'line3'),
  `buf=${JSON.stringify(buf.slice(-300))}`);

// Probe 4: cd + cwd preservation (existing snapshot path).
await t.run('mkdir -p /home/user/regr-mw-a && cd /home/user/regr-mw-a', 10_000);
const r4 = await t.run('pwd', 10_000);
a.check('cd + pwd still works',
  hasOutputLine(r4.output, '/home/user/regr-mw-a'),
  `output=${JSON.stringify(stripAnsi(r4.output).slice(-200))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
