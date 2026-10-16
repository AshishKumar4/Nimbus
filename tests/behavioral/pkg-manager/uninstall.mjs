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

// The install names the directory it installed: "[clang] installed at usr/lib/nimbus/clang/<version> (X MiB)".
let dir = null;
{
  const stripped = stripAnsi((await t.run('nimbus install clang', 120_000)).output);
  dir = stripped.match(/installed at\s+\/?(usr\/lib\/nimbus\/clang\/[\w.-]+)/)?.[1] ?? null;
  a.check('the install names the directory it installed', dir !== null, JSON.stringify(stripped.slice(-200)));
  dir = dir && `/${dir}`;
}
const exists = async (path) => (await t.run(`test -e ${path}`, 10_000)).exitCode === 0;
a.check('the installed bin directory exists before uninstall', dir !== null && await exists(`${dir}/bin/clang`), `dir=${dir}`);

// Uninstall.
{
  const { output, elapsed } = await t.run('nimbus uninstall clang', 30_000);
  const stripped = stripAnsi(output);
  const ok = /uninstalled|removed|deleted/i.test(stripped);
  a.check('nimbus uninstall clang emits success marker', ok,
    ok ? `elapsed=${elapsed}ms` : `output=${JSON.stringify(stripped.slice(-300))}`);
}

// The directory the install named is gone, and the clang root no longer lists it.
{
  a.check('installed bin path is removed', dir !== null && !await exists(`${dir}/bin/clang`), `dir=${dir}`);
  a.check('install directory removed', dir !== null && !await exists(dir), `dir=${dir}`);
  const { output } = await t.run('ls /usr/lib/nimbus/clang', 10_000);
  const stripped = stripAnsi(output);
  const version = dir?.split('/').pop();
  a.check('the clang root no longer lists the installed version', dir !== null && !stripped.split(/\s+/).includes(version),
    `version=${version} ls=${JSON.stringify(stripped.slice(-200))}`);
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
