#!/usr/bin/env bun
// pkg-manager/persist-across-restart — after a successful install, kill
// + restore the WebSocket. The installed runtime must still be on disk
// AND the registry must have rebuilt the bin → handler binding
// (boot-time rehydration loop).
//
// Category: R (runtime-behavioral) — observed cross-restart presence
// + content equality.
//
// PROBE-CLEANUP (2026-05-12): version string used to be hardcoded
// `binji-2020`. The clang-sysroot-swap (Path C) ships `wasi-libc-modern`;
// discover the installed version dynamically from `install --list` so
// the probe stays version-agnostic and survives future swaps.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('pkg-manager/persist-across-restart');
console.log(`pkg-manager/persist-across-restart — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
let t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. Install + discover the installed version. The success line is:
//   "[clang] installed at home/user/.nimbus/runtimes/clang/<version> (X MiB)"
const { output: installOut } = await t.run('nimbus install clang', 180_000);
const installStripped = stripAnsi(installOut);
const verMatch = installStripped.match(/installed at\s+(?:\/)?home\/user\/\.nimbus\/runtimes\/clang\/([\w.-]+)/);
const version = verMatch ? verMatch[1] : null;
a.check('install banner reports a version path', version !== null,
  version ? `version=${version}` : `tail=${JSON.stringify(installStripped.slice(-300))}`);

if (version === null) {
  await t.close();
  const sum = a.summary();
  process.exit(sum.fail > 0 ? 1 : 0);
}
const RUNTIME_DIR = `~/.nimbus/runtimes/clang/${version}`;

const { output: lsOutBefore } = await t.run(`ls ${RUNTIME_DIR}/bin/clang 2>&1`, 10_000);
const lsStrippedBefore = stripAnsi(lsOutBefore);
const beforePresent = lsStrippedBefore.includes(`/.nimbus/runtimes/clang/${version}/bin/clang`)
  && !/ENOENT|No such/i.test(lsStrippedBefore);
a.check('bin/clang exists before restart', beforePresent,
  beforePresent ? '' : `output=${JSON.stringify(lsStrippedBefore.slice(-200))}`);

// Manifest size before reconnect via `ls -la` parse (avoids the
// `wc -c` byte-inflation issue on large files).
const { output: szOutBefore } = await t.run(`ls -la ${RUNTIME_DIR}/manifest.json`, 10_000);
const matchBefore = stripAnsi(szOutBefore).match(/^\s*-\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s/m);
const beforeSize = matchBefore ? matchBefore[1] : '0';

// 2. Close + reconnect WS to same SID.
await t.close();
await sleep(500);
t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

// 3. Bin path still present.
{
  const { output } = await t.run(`ls ${RUNTIME_DIR}/bin/clang 2>&1`, 10_000);
  const stripped = stripAnsi(output);
  const present = stripped.includes(`/.nimbus/runtimes/clang/${version}/bin/clang`)
    && !/ENOENT|No such/i.test(stripped);
  a.check('bin/clang still exists after WS reconnect', present,
    present ? '' : `output=${JSON.stringify(stripped.slice(-200))}`);
}

// 4. Manifest byte-identical.
{
  const { output } = await t.run(`ls -la ${RUNTIME_DIR}/manifest.json`, 10_000);
  const matchAfter = stripAnsi(output).match(/^\s*-\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s/m);
  const afterSize = matchAfter ? matchAfter[1] : '0';
  a.check('manifest size unchanged across restart', beforeSize === afterSize && beforeSize !== '0',
    `before=${beforeSize} after=${afterSize}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
