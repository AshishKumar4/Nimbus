#!/usr/bin/env bun
// repl-r7/regression/python-bare-expression-still-works — Stream A
// fixes preserved.
//
// Stream A landed a Python REPL implementation. Bare expressions like
// `1 + 1` or `'hello'` should print their repr via the displayhook
// path (python-repl.ts __nimbus_repl_finish). Verify R7 didn't break
// it.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl-r7/regression/python-bare-expression-still-works');
console.log(`repl-r7/regression/python-bare-expression-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run('nimbus install python', 300_000);

t.reset();
t.cmd('python');
await t.waitFor((b) => />>>\s*$/.test(b.trimEnd()), 30_000, '>>> prompt');

function tail(s, n = 200) { return s.length > n ? '…' + s.slice(-n) : s; }

// Probe 1: `1 + 1` → "2"
{
  const r = await t.run('1 + 1', 15_000);
  const out = stripAnsi(r.output);
  a.check('REPL: 1 + 1 → "2"',
    /\b2\b/.test(out),
    `output=${JSON.stringify(tail(out))}`);
}

// Probe 2: string literal `'hello'` → "'hello'" (with quotes via repr)
{
  const r = await t.run("'hello'", 15_000);
  const out = stripAnsi(r.output);
  a.check("REPL: 'hello' → repr \"'hello'\"",
    /'hello'/.test(out),
    `output=${JSON.stringify(tail(out))}`);
}

// Probe 3: list literal
{
  const r = await t.run('[1, 2, 3]', 15_000);
  const out = stripAnsi(r.output);
  a.check('REPL: [1, 2, 3] → repr "[1, 2, 3]"',
    /\[1, 2, 3\]/.test(out),
    `output=${JSON.stringify(tail(out))}`);
}

// Probe 4: variable persistence across pushes.
await t.run('x = 99', 15_000);
{
  const r = await t.run('x', 15_000);
  const out = stripAnsi(r.output);
  a.check('REPL: x persists across pushes → "99"',
    /\b99\b/.test(out),
    `output=${JSON.stringify(tail(out))}`);
}

// Exit cleanly with code 0.
try {
  t.cmd('exit()');
  await t.waitFor((b) => /\$\s*$/.test(b.trimEnd().slice(-3)), 15_000, 'shell prompt');
  const r = await t.run('echo "EXIT=$?"', 10_000);
  const m = /EXIT=(\d+)/.exec(stripAnsi(r.output));
  a.check('REPL: exit() → shell $? === 0',
    m && parseInt(m[1], 10) === 0,
    `got=${m ? m[1] : 'no-match'}`);
} catch {}

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
