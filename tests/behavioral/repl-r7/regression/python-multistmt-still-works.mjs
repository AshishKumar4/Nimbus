#!/usr/bin/env bun
// repl-r7/regression/python-multistmt-still-works — multi-statement
// REPL behavior preserved.
//
// Verifies that:
//   - import + use works across pushes
//   - print() output reaches stdout
//   - sys.exit(N) from a separate import works
// All should still function after R7 fixes (B2's PyodideConsole.buffer
// reset must not break inter-push state).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl-r7/regression/python-multistmt-still-works');
console.log(`repl-r7/regression/python-multistmt-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install python', 300_000);

t.reset();
t.cmd('python');
await t.waitFor((b) => />>>\s*$/.test(b.trimEnd()), 30_000, '>>> prompt');

function tail(s, n = 250) { return s.length > n ? '…' + s.slice(-n) : s; }

// import + use across pushes.
await t.run('import math', 15_000);
{
  const r = await t.run('math.pi', 15_000);
  const out = stripAnsi(r.output);
  a.check('REPL: math.pi printed (3.14...)',
    /3\.14159/.test(out),
    `output=${JSON.stringify(tail(out))}`);
}

// print() side-effect.
{
  const r = await t.run('print("hello-multistmt")', 15_000);
  const out = stripAnsi(r.output);
  a.check('REPL: print("hello-multistmt") → output present',
    /hello-multistmt/.test(out),
    `output=${JSON.stringify(tail(out))}`);
}

// def + call within REPL. PyodideConsole treats `def x(): body` as
// incomplete (needs a blank line to terminate the compound block) —
// pattern: send def line (expect `... `), then blank line (expect
// `>>> `). Real CPython REPL accepts single-line def directly; this
// is a known PyodideConsole quirk we work around the same way the
// user would.
t.reset();
t.cmd('def double(x): return x * 2');
await t.waitFor((b) => /\.\.\.\s*$/.test(b.trimEnd()), 15_000, '... after def');
t.reset();
t.cmd('');  // blank line terminates the block
await t.waitFor((b) => />>>\s*$/.test(b.trimEnd()), 15_000, '>>> after def block');
{
  const r = await t.run('double(21)', 15_000);
  const out = stripAnsi(r.output);
  a.check('REPL: def double + call → 42',
    /\b42\b/.test(out),
    `output=${JSON.stringify(tail(out))}`);
}

// sys.exit(5) via import.
await t.run('import sys', 15_000);
{
  t.reset();
  t.cmd('sys.exit(5)');
  await t.waitFor((b) => /\$\s*$/.test(b.trimEnd().slice(-3)), 15_000, 'shell prompt after sys.exit');
  const r = await t.run('echo "EXIT=$?"', 10_000);
  const m = /EXIT=(\d+)/.exec(stripAnsi(r.output));
  a.check('REPL: sys.exit(5) → shell $? === 5',
    m && parseInt(m[1], 10) === 5,
    `got=${m ? m[1] : 'no-match'}`);
}

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
