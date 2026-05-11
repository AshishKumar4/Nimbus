#!/usr/bin/env bun
// repl/node-hello-repl — `node` with no args drops into REPL.
// Tests:
//   1. REPL launches with `> ` prompt
//   2. console.log routes correctly
//   3. .exit returns to shell
//
// Stateful eval NOT supported in workerd (CSP). See bun-hello-repl
// for the architectural rationale.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl/node-hello-repl');
console.log(`repl/node-hello-repl — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

t.reset();
t.cmd('node');
try {
  await t.waitFor((b) => /^> /m.test(b), 30_000, 'node repl prompt');
  a.check('node no-args drops into REPL with > prompt', true,
    JSON.stringify(stripAnsi(t.buf).slice(-200)));
} catch (e) {
  a.check('node no-args drops into REPL with > prompt', false, `${e.message}`);
  await t.close();
  process.exit(1);
}

t.reset();
t.cmd('console.log("hi")');
await t.waitFor((b) => /\bhi\b/m.test(b), 15_000, 'console.log("hi") output');
const out1 = stripAnsi(t.buf);
a.check('console.log("hi") prints "hi" in REPL', /\bhi\b/m.test(out1),
  JSON.stringify(out1.slice(-200)));

t.reset();
t.cmd('.exit');
await t.waitFor((b) => /[$#]\s*$/.test(b.trimEnd().slice(-3)) && /user@nimbus/.test(b), 15_000, 'shell prompt');
const out3 = stripAnsi(t.buf);
a.check('.exit returns to shell prompt', /user@nimbus:.+\$/.test(out3),
  JSON.stringify(out3.slice(-200)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
