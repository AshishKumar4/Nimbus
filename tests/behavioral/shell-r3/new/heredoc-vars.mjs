#!/usr/bin/env bun
// shell-r3/new/heredoc-vars — BUG-SWEEP-R3-5.
//
// Pre-fix: `cat <<EOF\nval=$X\nEOF` (unquoted delimiter) produced
// literal `val=$X`. Bash semantics expand $X in unquoted heredocs;
// quoted delimiters (`<<'EOF'`) preserve literals.
//
// Post-fix: HeredocHandler._finishHeredoc invokes expandHeredocVars
// (from features.ts) on accumulated content when delimiter is not
// quoted. ${NAME} and $NAME forms supported.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r3/new/heredoc-vars');
console.log(`shell-r3/new/heredoc-vars — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function body(raw) {
  const ansi = stripAnsi(raw);
  const lines = ansi.split(/\r?\n/);
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

// Probe 1: unquoted heredoc expands $X
await t.run('export VARFOO=replaced', 3_000);
t.reset();
t.cmd('cat <<EOF');
await sleep(500);
t.cmd('val=$VARFOO');
await sleep(500);
t.cmd('EOF');
await sleep(3_000);
const out1 = stripAnsi(t.buf);
a.check(
  'unquoted heredoc expands $VARFOO',
  /val=replaced/.test(out1),
  `tail=${JSON.stringify(out1.slice(-300))}`,
);

// Probe 2: single-quoted-delimiter preserves literal
t.reset();
t.cmd("cat <<'EOF'");
await sleep(500);
t.cmd('val=$VARFOO');
await sleep(500);
t.cmd('EOF');
await sleep(3_000);
const out2 = stripAnsi(t.buf);
a.check(
  "<<'EOF' preserves literal $VARFOO",
  /val=\$VARFOO/.test(out2) && !/val=replaced/.test(out2),
  `tail=${JSON.stringify(out2.slice(-300))}`,
);

// Probe 3: ${NAME} form
t.reset();
t.cmd('cat <<EOF');
await sleep(500);
t.cmd('val=${VARFOO}-suffix');
await sleep(500);
t.cmd('EOF');
await sleep(3_000);
const out3 = stripAnsi(t.buf);
a.check(
  '${VARFOO}-suffix form expands inside unquoted heredoc',
  /val=replaced-suffix/.test(out3),
  `tail=${JSON.stringify(out3.slice(-300))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
