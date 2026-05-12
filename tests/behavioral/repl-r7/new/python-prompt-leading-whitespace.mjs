#!/usr/bin/env bun
// repl-r7/new/python-prompt-leading-whitespace — REPL-R7-2.
//
// Pre-fix: in the REPL, after `def foo():` (continuation prompt
// `... ` shown), typing `  return 42` and pressing Enter produced:
//   IndentationError: expected an indented block after function
//   definition on line 1
// Root cause: PyodideConsole inherits from CPython's
// code.InteractiveConsole, whose .push(line) APPENDS to self.buffer
// and joins with "\n". The host (python-repl.ts) re-sends the ENTIRE
// multi-line accumulated source on each push (not just the new
// line), so the buffer grows like:
//   buffer=["def foo():", "def foo():\n  return 42"]
//   joined="def foo():\ndef foo():\n  return 42"
// → first def on line 1, second def on line 2 (column 0, NOT
// indented), then `  return 42`. Python complains the line-1 def
// has no indented body.
//
// Post-fix: __nimbus_repl_step calls
// __nimbus_repl_console.buffer.clear() before each push so the
// host-provided full source IS the entire buffer state.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl-r7/new/python-prompt-leading-whitespace');
console.log(`repl-r7/new/python-prompt-leading-whitespace — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install python', 300_000);

function tail(s, n = 400) { return s.length > n ? '…' + s.slice(-n) : s; }

// Enter REPL.
t.reset();
t.cmd('python');
await t.waitFor((b) => />>>\s*$/.test(b.trimEnd()), 30_000, '>>> prompt');

// Type `def foo():` — expect continuation prompt `... `.
t.reset();
t.cmd('def foo():');
let line1Ok = true;
try {
  await t.waitFor((b) => /\.\.\.\s*$/.test(b.trimEnd()), 15_000, '... prompt after def');
} catch (e) {
  line1Ok = false;
}
a.check('def foo(): → continuation prompt `... `',
  line1Ok,
  `tail=${JSON.stringify(tail(stripAnsi(t.buf), 200))}`);

if (line1Ok) {
  // Type `  return 42` — expect another `... ` prompt.
  t.reset();
  t.cmd('  return 42');
  let line2Ok = true;
  let line2Tail = '';
  try {
    await t.waitFor((b) => /\.\.\.\s*$/.test(b.trimEnd()), 15_000, '... prompt after return 42');
  } catch (e) {
    line2Ok = false;
    line2Tail = tail(stripAnsi(t.buf), 400);
  }
  a.check('  return 42 → continuation prompt (no IndentationError)',
    line2Ok && !/IndentationError/.test(stripAnsi(t.buf)),
    `tail=${JSON.stringify(line2Tail || tail(stripAnsi(t.buf), 200))}`);

  if (line2Ok) {
    // Empty line terminates the block.
    t.reset();
    t.cmd('');
    await t.waitFor((b) => />>>\s*$/.test(b.trimEnd()), 15_000, '>>> after block');

    // Call foo() — should print 42.
    const r = await t.run('foo()', 15_000);
    const out = stripAnsi(r.output);
    a.check('foo() → "42"',
      /\b42\b/.test(out),
      `output=${JSON.stringify(tail(out, 200))}`);
  }
}

// Exit cleanly.
try {
  t.cmd('exit()');
  await t.waitFor((b) => /\$\s*$/.test(b.trimEnd().slice(-3)), 15_000, 'shell prompt');
} catch {}
await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
