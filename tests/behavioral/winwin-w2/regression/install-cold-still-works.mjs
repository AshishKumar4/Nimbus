#!/usr/bin/env bun
// winwin-w2/install-cold-still-works — basic python cold install end-to-end.
//
// Regression target: after W2 parallelizes the blob loop, a cold install
// must still complete successfully + leave runtime functional. We use
// python (smaller blob set than clang) for a faster regression probe.
//
// Asserts:
//   1. `nimbus install python` exits 0 with "installed at" line.
//   2. `nimbus install --list` reports python.
//   3. `python -c "print(7)"` produces `7\n` (runtime works).

import { mintSession, Terminal, makeAsserter, stripAnsi, BASE } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('winwin-w2/install-cold-still-works');
console.log(`winwin-w2/install-cold-still-works — ${BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. Cold install.
const { output: ir } = await t.run('nimbus install python', 180_000);
const s1 = stripAnsi(ir);
a.check('install reports "installed at" line', /installed at/.test(s1),
  `tail=${JSON.stringify(s1.slice(-300))}`);

// 2. nimbus install --list mentions python.
const { output: lo } = await t.run('nimbus install --list', 15_000);
const s2 = stripAnsi(lo);
a.check('--list reports python', /python/.test(s2),
  `tail=${JSON.stringify(s2.slice(-200))}`);

// 3. Runtime functional.
const { output: po } = await t.run('python -c "print(7)"', 30_000);
const s3 = stripAnsi(po);
a.check('python -c works post-install', /\b7\b/.test(s3),
  `output=${JSON.stringify(s3.slice(-200))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
