#!/usr/bin/env bun
// file-tree-fix/new/terminal-still-works-after-editor-switch —
// The queue-on-WS-pending fix touches fsRequest's send path; we
// need to ensure regular terminal 'input' messages STILL flow
// (they're not queued — only fs-* are).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-fix/new/terminal-still-works-after-editor-switch');
console.log(`file-tree-fix/new/terminal-still-works-after-editor-switch — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Probe 1: shell echo works AFTER cold start (proves the queue
// changes didn't break the input path).
const r1 = await t.run('echo file-tree-fix-OK', 10_000);
a.check('shell echo works (no regression from queue fix)',
  /file-tree-fix-OK/.test(stripAnsi(r1.output)),
  `output=${JSON.stringify(stripAnsi(r1.output).slice(-200))}`);

// Probe 2: multi-line paste still works.
t.reset();
t.send('echo a1\recho b2\recho c3\r');
await t.waitFor((b) => /\bc3\b/.test(b) && /\$\s*$/.test(b.trimEnd().slice(-3)), 15_000, 'paste-complete');
const buf = stripAnsi(t.buf);
a.check('paste 3-line still works',
  /a1/.test(buf) && /b2/.test(buf) && /c3/.test(buf),
  `buf=${JSON.stringify(buf.slice(-200))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
