#!/usr/bin/env bun
// shell/compat/r3/new/brace-expansion — shell compatibility.
//
// Pre-fix `ls *.{js,ts}` did not expand the brace list. Common idioms
// (`rm -rf {dist,build,node_modules}`, `cp src/{a,b,c}.txt dst/`) broken.
//
// Brace expansion is owned by the shell substrate expander, before
// glob expansion and after the lexer preserves quoted literals.

import { deleteSession, mintSession, Terminal, makeAsserter, termBody } from '../../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/compat/r3/new/brace-expansion');
console.log(`shell/compat/r3/new/brace-expansion — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
try {
await t.connect();
await t.waitForPrompt(60_000);

await t.run('mkdir -p /tmp/r3be && touch /tmp/r3be/a.js /tmp/r3be/b.ts /tmp/r3be/c.md', 5_000);

const r1 = await t.run('echo a{1,2,3}b', 5_000);
a.check(
  'echo a{1,2,3}b → a1b a2b a3b',
  termBody(r1.output) === 'a1b a2b a3b',
  `body=${JSON.stringify(termBody(r1.output))}`,
);

const r2 = await t.run('ls /tmp/r3be/*.{js,ts}', 5_000);
const b2 = termBody(r2.output);
a.check(
  'ls /tmp/r3be/*.{js,ts} finds both files',
  /a\.js/.test(b2) && /b\.ts/.test(b2),
  `body=${JSON.stringify(b2)}`,
);

const r3 = await t.run("echo 'a{1,2}b'", 5_000);
a.check(
  "single-quoted '{...}' preserved literal",
  termBody(r3.output) === 'a{1,2}b',
  `body=${JSON.stringify(termBody(r3.output))}`,
);

const r4 = await t.run('FOO=hello && echo "${FOO}"', 5_000);
a.check(
  '${VAR} parameter expansion still works (not brace-expanded)',
  termBody(r4.output) === 'hello',
  `body=${JSON.stringify(termBody(r4.output))}`,
);

} finally {
  try { await t.close(); } catch {}
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
