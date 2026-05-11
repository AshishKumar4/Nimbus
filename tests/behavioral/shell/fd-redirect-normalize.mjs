#!/usr/bin/env bun
// shell/fd-redirect-normalize — regression probe for BUG-SWEEP-2.
//
// Pre-fix: lifo-sh's parser raised "Expected Word but got Amp ('&')"
// on any line containing `2>&1`, `>&2`, `<&0`, or other fd-to-fd
// redirects. Real-world impact: `cmd 2>&1 | tail` (extremely common
// idiom) failed at parse time, killing the pipeline.
//
// Post-fix: FdRedirectNormalizer strips these operators from the
// line before passing to lifo-sh. Stdout and stderr already share
// the terminal sink in Nimbus so the rewrite is semantically a
// no-op for the user.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/fd-redirect-normalize');
console.log(`shell/fd-redirect-normalize — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Probe 1: `cmd 2>&1` no longer triggers parse error
t.reset();
t.cmd('echo hello 2>&1');
await sleep(3000);
const out1 = stripAnsi(t.buf);
a.check(
  '`echo hello 2>&1` runs without parse error',
  /hello/.test(out1) && !/Expected.*but got/.test(out1),
  `tail: ${JSON.stringify(out1.slice(-200))}`,
);

// Probe 2: piped form `cmd 2>&1 | cat` works
t.reset();
t.cmd('echo "world" 2>&1 | cat');
await sleep(3000);
const out2 = stripAnsi(t.buf);
a.check(
  '`echo X 2>&1 | cat` pipeline runs without parse error',
  /world/.test(out2) && !/Expected.*but got/.test(out2),
  `tail: ${JSON.stringify(out2.slice(-200))}`,
);

// Probe 3: `>&2` (stderr redirect form)
t.reset();
t.cmd('echo to-stderr >&2');
await sleep(3000);
const out3 = stripAnsi(t.buf);
a.check(
  '`echo X >&2` runs without parse error (no-op rewrite)',
  /to-stderr/.test(out3) && !/Expected.*but got/.test(out3),
  `tail: ${JSON.stringify(out3.slice(-200))}`,
);

// Probe 4: single-quoted literal `'2>&1'` is NOT rewritten — the user
// explicitly typed that string as data, not as an operator.
t.reset();
t.cmd("echo '2>&1 literal'");
await sleep(3000);
const out4 = stripAnsi(t.buf);
a.check(
  "single-quoted '2>&1' literal is preserved (not rewritten)",
  /2>&1 literal/.test(out4),
  `tail: ${JSON.stringify(out4.slice(-200))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
