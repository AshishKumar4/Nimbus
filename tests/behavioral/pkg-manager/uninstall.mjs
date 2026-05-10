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

// Bin path no longer exists (use node existence check). Sigil
// pattern: assemble the result string at runtime so the command echo
// can't false-match.
{
  const { output } = await t.run(
    `node -e "const ok = require('fs').existsSync(process.env.HOME + '/.nimbus/runtimes/clang/binji-2020/bin/clang'); console.log('BIN'+'-STATE:' + (ok ? 'STILL_HERE' : 'GONE'))"`,
    10_000,
  );
  const stripped = stripAnsi(output);
  const gone = /BIN-STATE:GONE/.test(stripped);
  a.check('installed bin path is removed', gone,
    gone ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

// Install dir removed.
{
  const { output } = await t.run(
    `node -e "const ok = require('fs').existsSync(process.env.HOME + '/.nimbus/runtimes/clang'); console.log('DIR'+'-STATE:' + (ok ? 'STILL_HERE' : 'GONE'))"`,
    10_000,
  );
  const stripped = stripAnsi(output);
  const removed = /DIR-STATE:GONE/.test(stripped);
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
