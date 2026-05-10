#!/usr/bin/env bun
// pkg-manager/uninstall — after `nimbus uninstall clang`, the bin
// is no longer resolvable via `which clang`, the install dir is
// removed, and `nimbus install --list` no longer lists clang.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('pkg-manager/uninstall');
console.log(`pkg-manager/uninstall — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install clang', 120_000);

// Uninstall.
{
  const { output, elapsed } = await t.run('nimbus uninstall clang', 30_000);
  const stripped = stripAnsi(output);
  const ok = /uninstalled|removed|deleted/i.test(stripped);
  a.check('nimbus uninstall clang emits success marker', ok,
    ok ? `elapsed=${elapsed}ms` : `output=${JSON.stringify(stripped.slice(-300))}`);
}

// Bin path no longer exists. Use shell `ls` against the PARENT dir;
// the directory itself should no longer exist (covered by next check
// too), but if it does exist we'd see the file listing.
{
  const { output } = await t.run('ls ~/.nimbus/runtimes/clang/binji-2020/bin/', 10_000);
  const stripped = stripAnsi(output);
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  // After uninstall, the directory shouldn't exist; ls prints an
  // error OR an empty listing. We assert NO line consists of literally
  // "clang" (which is what `ls` would print if the file were present).
  const present = lines.some((l) => l === 'clang' || l === 'wasm-ld');
  a.check('installed bin path is removed', !present,
    !present ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

// Install dir removed.
{
  const { output } = await t.run('ls ~/.nimbus/runtimes/clang', 10_000);
  const stripped = stripAnsi(output);
  const removed = /ENOENT|No such|cannot access|not found/i.test(stripped)
    || !/binji-2020/.test(stripped);
  a.check('install directory removed', removed,
    removed ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

// nimbus install --list no longer lists clang.
{
  const { output } = await t.run('nimbus install --list', 5_000);
  const stripped = stripAnsi(output);
  // We accept "(no runtimes installed)" or any output that doesn't
  // contain "clang" on its own line.
  const noClang = !/\bclang\b/.test(stripped);
  a.check('nimbus install --list does not show clang', noClang,
    noClang ? '' : `list=${JSON.stringify(stripped.slice(-200))}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
