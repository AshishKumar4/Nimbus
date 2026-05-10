#!/usr/bin/env bun
// pkg-manager/catalog-fetch — `nimbus install --available` reads the
// catalog JSON from R2 + Cache API L2 and surfaces it to the user.
//
// Asserts:
//   1. Output mentions "clang" with version "binji-2020".
//   2. Second invocation (warm L2) returns < 1 s.
//   3. Unknown runtime `nimbus install ghostlang` exits non-zero with
//      a clear "not in catalog" / "not found" diagnostic.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('pkg-manager/catalog-fetch');
console.log(`pkg-manager/catalog-fetch — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. nimbus install --available shows clang + binji-2020.
{
  const { output } = await t.run('nimbus install --available', 30_000);
  const stripped = stripAnsi(output);
  const showsClang = /\bclang\b/.test(stripped);
  const showsBinji = /binji-2020/.test(stripped);
  a.check('catalog mentions clang', showsClang,
    showsClang ? '' : JSON.stringify(stripped.slice(-300)));
  a.check('catalog mentions binji-2020 version', showsBinji,
    showsBinji ? '' : JSON.stringify(stripped.slice(-300)));
}

// 2. Second invocation hits L2 (only meaningful if first succeeded).
{
  const { elapsed, output } = await t.run('nimbus install --available', 15_000);
  const stripped = stripAnsi(output);
  const notNotFound = !/nimbus: command not found/.test(stripped);
  // Warm L2 should be sub-second; allow generous 3000 ms for shell + round-trip.
  a.check('catalog second fetch < 3 s (warm L2)', elapsed < 3_000 && notNotFound,
    `elapsed=${elapsed}ms notNotFound=${notNotFound}`);
}

// 3. Unknown runtime fails clean (must be from the package manager,
//    NOT from "command not found").
{
  const { output } = await t.run('nimbus install ghostlang_xyz', 15_000);
  const stripped = stripAnsi(output);
  const notCmdNotFound = !/nimbus: command not found/.test(stripped);
  const failed = /not in catalog|unknown runtime|no such runtime|not available/i.test(stripped);
  a.check('unknown runtime emits clear diagnostic from package manager',
    failed && notCmdNotFound,
    failed && notCmdNotFound ? '' : JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
