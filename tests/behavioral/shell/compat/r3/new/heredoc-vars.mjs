#!/usr/bin/env bun
// shell/compat/r3/new/heredoc-vars — shell compatibility.
//
// Pre-fix: `cat <<EOF\nval=$X\nEOF` (unquoted delimiter) produced
// literal `val=$X`. Bash semantics expand $X in unquoted heredocs;
// quoted delimiters (`<<'EOF'`) preserve literals.
//
// Heredoc input is collected by the terminal wrapper and executed by
// the shell substrate, where unquoted heredoc bodies expand variables.

import { deleteSession, mintSession, Terminal, makeAsserter, sleep, termBody } from '../../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/compat/r3/new/heredoc-vars');
console.log(`shell/compat/r3/new/heredoc-vars — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
try {
await t.connect();
await t.waitForPrompt(60_000);

await t.run('export VARFOO=replaced', 3_000);
await t.run('rm -rf /tmp/hd1.txt', 2_000);
t.reset();
t.cmd('cat > /tmp/hd1.txt <<EOF');
await sleep(1_500);
t.cmd('val=$VARFOO');
await sleep(1_500);
t.cmd('EOF');
await sleep(3_000);
const r1 = await t.run('cat /tmp/hd1.txt', 5_000);
a.check(
  'unquoted heredoc (file) expands $VARFOO → replaced',
  termBody(r1.output) === 'val=replaced',
  `body=${JSON.stringify(termBody(r1.output))}`,
);

await t.run('rm -rf /tmp/hd2.txt', 2_000);
t.reset();
t.cmd("cat > /tmp/hd2.txt <<'EOF'");
await sleep(1_500);
t.cmd('val=$VARFOO');
await sleep(1_500);
t.cmd('EOF');
await sleep(3_000);
const r2 = await t.run('cat /tmp/hd2.txt', 5_000);
a.check(
  "<<'EOF' (file) preserves literal $VARFOO (no expansion)",
  termBody(r2.output) === 'val=$VARFOO',
  `body=${JSON.stringify(termBody(r2.output))}`,
);

await t.run('rm -rf /tmp/hd3.txt', 2_000);
t.reset();
t.cmd('cat > /tmp/hd3.txt <<EOF');
await sleep(1_500);
t.cmd('val=${VARFOO}-suffix');
await sleep(1_500);
t.cmd('EOF');
await sleep(3_000);
const r3 = await t.run('cat /tmp/hd3.txt', 5_000);
a.check(
  '${VARFOO}-suffix form expands inside unquoted heredoc',
  termBody(r3.output) === 'val=replaced-suffix',
  `body=${JSON.stringify(termBody(r3.output))}`,
);

} finally {
  try { await t.close(); } catch {}
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
