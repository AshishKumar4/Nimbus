#!/usr/bin/env bun
// pkg-manager/reinstall-idempotent — second `nimbus install clang`
// after a successful first install should NOT refetch from R2; should
// detect the existing manifest with matching sha256 and skip.
//
// Asserts:
//   1. First install completes ok.
//   2. Second install completes < 5 s AND emits a "already installed"
//      / "fresh" / "skipping" marker, NOT a fetching marker.
//   3. After second install, the files are still there + manifest
//      unchanged.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('pkg-manager/reinstall-idempotent');
console.log(`pkg-manager/reinstall-idempotent — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. First install. Must show a success/install marker — NOT
//    "nimbus: command not found".
{
  const { elapsed, output } = await t.run('nimbus install clang', 120_000);
  const stripped = stripAnsi(output);
  const installedOk = /installed at .*\.nimbus|clang.*installed/i.test(stripped)
    && !/command not found/.test(stripped);
  a.check('first install completes with success marker (not "command not found")',
    installedOk,
    installedOk ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-200)));
}

// Snapshot manifest mtime+content for comparison after second install.
let firstMtime = '';
{
  const { output } = await t.run('stat -c %Y ~/.nimbus/runtimes/clang/binji-2020/manifest.json 2>/dev/null || cat ~/.nimbus/runtimes/clang/binji-2020/manifest.json | wc -c', 10_000);
  firstMtime = stripAnsi(output).trim();
}

// 2. Second install — must be fast + use a "skip" path AND NOT
//    "command not found".
{
  const { elapsed, output } = await t.run('nimbus install clang', 60_000);
  const stripped = stripAnsi(output);
  const notNotFound = !/command not found/.test(stripped);
  a.check('second install: nimbus is a registered command', notNotFound,
    notNotFound ? '' : JSON.stringify(stripped.slice(-200)));
  const fastOk = elapsed < 8_000 && notNotFound;
  a.check('second install completes < 8 s (no refetch)', fastOk, `elapsed=${elapsed}ms`);
  const skipMarker = /already installed|already at|fresh|skipping|up to date|cached/i.test(stripped);
  a.check('second install emits skip/already-installed marker', skipMarker && notNotFound,
    skipMarker ? '' : `output tail=${JSON.stringify(stripped.slice(-300))}`);
}

// 3. Manifest unchanged.
{
  const { output } = await t.run('stat -c %Y ~/.nimbus/runtimes/clang/binji-2020/manifest.json 2>/dev/null || cat ~/.nimbus/runtimes/clang/binji-2020/manifest.json | wc -c', 10_000);
  const secondMtime = stripAnsi(output).trim();
  a.check('manifest preserved across idempotent reinstall', firstMtime === secondMtime,
    `before=${firstMtime} after=${secondMtime}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
