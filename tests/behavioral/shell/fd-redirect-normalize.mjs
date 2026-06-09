#!/usr/bin/env bun
// shell/fd-redirect-normalize — regression probe for shell fd duplication.
//
// The lifo parser/interpreter owns these operators structurally.
// The probe intentionally includes an apostrophe in a comment before
// `2>&1`, matching real installer scripts that broke brittle line
// preprocessors.

import { deleteSession, mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/fd-redirect-normalize');
console.log(`shell/fd-redirect-normalize — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  {
    const { output } = await t.run('echo hello 2>&1', 20_000);
    const stripped = stripAnsi(output);
    a.check(
      '`echo hello 2>&1` runs without parse error',
      /hello/.test(stripped) && !/Expected.*but got/.test(stripped),
      `tail: ${JSON.stringify(stripped.slice(-200))}`,
    );
  }

  {
    const { output } = await t.run('echo "world" 2>&1 | cat', 20_000);
    const stripped = stripAnsi(output);
    a.check(
      '`echo X 2>&1 | cat` pipeline runs without parse error',
      /world/.test(stripped) && !/Expected.*but got/.test(stripped),
      `tail: ${JSON.stringify(stripped.slice(-200))}`,
    );
  }

  {
    const { output } = await t.run('echo to-stderr >&2', 20_000);
    const stripped = stripAnsi(output);
    a.check(
      '`echo X >&2` writes through duplicated stderr',
      /to-stderr/.test(stripped) && !/Expected.*but got/.test(stripped),
      `tail: ${JSON.stringify(stripped.slice(-200))}`,
    );
  }

  {
    const { output } = await t.run('echo explicit-fd 1>&2', 20_000);
    const stripped = stripAnsi(output);
    a.check(
      '`echo X 1>&2` uses explicit stdout fd duplication',
      /explicit-fd/.test(stripped) && !/Expected.*but got/.test(stripped),
      `tail: ${JSON.stringify(stripped.slice(-200))}`,
    );
  }

  {
    const { output } = await t.run('rm -f /tmp/fd-order.txt; echo ordered > /tmp/fd-order.txt 2>&1; cat /tmp/fd-order.txt', 20_000);
    const stripped = stripAnsi(output);
    a.check(
      'ordered file redirect followed by fd duplication works',
      hasOutputLine(stripped, 'ordered') && !/Expected.*but got/.test(stripped),
      `tail: ${JSON.stringify(stripped.slice(-500))}`,
    );
  }

  {
    const { output } = await t.run("echo '2>&1 literal'", 20_000);
    const stripped = stripAnsi(output);
    a.check(
      "single-quoted '2>&1' literal is preserved",
      /2>&1 literal/.test(stripped),
      `tail: ${JSON.stringify(stripped.slice(-200))}`,
    );
  }

  {
    const script = "# npm's comment\\ncommand -v node >/dev/null 2>&1 && echo COMMENT_FD_OK\\n";
    const { output } = await t.run(`printf ${JSON.stringify(script)} | sh`, 20_000);
    const stripped = stripAnsi(output);
    a.check(
      'stdin sh scripts parse fd redirects after apostrophe comments',
      hasOutputLine(stripped, 'COMMENT_FD_OK') && !/Expected Word/.test(stripped),
      `tail: ${JSON.stringify(stripped.slice(-800))}`,
    );
  }
} finally {
  try { await t.close(); } catch {}
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);

function hasOutputLine(output, expected) {
  return output
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .includes(expected);
}
